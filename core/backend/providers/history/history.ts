import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HistoryCommit } from '../../../api/actions.ts'
import type { Caller } from '../../../api/envelope.ts'
import { HISTORY_COMMIT_BYTES, HISTORY_FILE_BYTES, LOG_PAGE, MAX_COMMIT_MESSAGE, MAX_COMMIT_PATHS, MAX_LOG_PAGE } from '../../../api/exec.ts'
import { isDotName, MAX_SCOPE_LENGTH } from '../../../api/scope.ts'
import type { Call, HistoryRole, Opening, Prepared, Provider, ProviderRefusal } from '../../../api/policy-jobs.ts'
import { canonical, folderState, lastNamed, looked, named, type Canonical } from '../../../lib/canonical.ts'
import { baseEnv, type Env, findProgram, inside, nullDevice, runClean, setVariable } from '../../../lib/clean-env.ts'

export type HistoryOptions = {
  // The path git is looked up on and the environment the base is read from, hetu's own but in tests
  path?: string
  ambient?: Readonly<Record<string, string | undefined>>
  // The largest file a commit stores, HISTORY_FILE_BYTES but in tests
  fileBytes?: number
  // The most one commit reads into memory, HISTORY_COMMIT_BYTES but in tests
  commitBytes?: number
}

export type History = {
  provider: Provider
  role: HistoryRole
  // Finds git and makes history's own folders under the data folder. Throws with no git to run
  start(dataDir: string): Promise<void>
  // Ends what is running and serves nothing more, for the plugin's stop
  close(): void
}

// Opening a note to read it: no link at the last name and no wait on a FIFO, where the system has the flags
const NOTE_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const refused = (code: ProviderRefusal['code'], reason?: ProviderRefusal['reason']): ProviderRefusal => (reason === undefined ? { code } : { code, reason })
// What a commit refused not-granted throws once the call's judge refused the path it would record: the judge's own
// refusal, so the caller and the record get the gate's code or a guard's and not a missing grant whatever refused
const passedOn = (err: unknown, denied: ProviderRefusal | null): unknown =>
  denied !== null && typeof err === 'object' && err !== null && !(err instanceof Error) && (err as ProviderRefusal).code === 'not-granted' ? denied : err
const commitId = /^[0-9a-f]{40}$/
const NO_COMMIT = '0'.repeat(40)
// How many times a note is opened when its name holds another file each time it is looked at again
const OPENS = 3
const BRANCH = 'refs/heads/main'
// What git answers with apart from a note's bytes: ids and a page of the log
const SMALL = 1024 * 1024
// Between the fields and the commits of a log page. A message holds neither, since core/api refuses control characters
const FIELD = '\x1f'
const RECORD = '\x1e'

type Folder = Opening & { folder: string }
// One notes folder's repo with the git that serves it
type Repo = { dir: string, git: string, env: Env }

// What git takes for a name: no angle brackets, no line breaks and nothing but space at the ends
const nameOf = (text: string) => text.replace(/[<>\r\n\0]/g, ' ').replace(/\s+/g, ' ').trim()
const callerName = (caller: Caller) => (caller.kind === 'plugin' ? caller.id : caller.kind === 'window' ? `window.${caller.role}` : `content.${caller.plugin}`)

// history.commit, history.log and history.read over a repo hetu owns, one per notes folder, under the data folder.
// git never sees the notes folder: it runs with --git-dir alone from an empty folder of history's own, takes each
// note's bytes on stdin and never a path to open, so no config, hook, filter or nested repo under the notes is read.
// prepare canonicalises each path, so the gate decides on the name the note really has
export function createHistory(options: HistoryOptions = {}): History {
  const fileBytes = options.fileBytes ?? HISTORY_FILE_BYTES
  const commitBytes = options.commitBytes ?? HISTORY_COMMIT_BYTES
  const ambient = options.ambient ?? process.env
  const lookup = options.path ?? ambient.PATH ?? ambient.Path
  let home: string | null = null
  let opening: Folder | null = null
  const repos = new Map<Folder, Promise<Repo>>()
  const resolved = new Map<string, Canonical[]>()
  const preparedUnder = new Map<string, Folder>()
  // The path each target was prepared from, as the caller wrote it, so a look at its folder can resolve it again
  const spelling = new WeakMap<Canonical, string>()
  let stopping = new AbortController()
  // git keeps one index per repo, so one call runs at a time
  let tail: Promise<void> = Promise.resolve()

  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const done = tail.then(work)
    tail = done.then(() => {}, () => {})
    return done
  }

  // Empty, and the only folder git runs in or reads as a home
  const emptyDir = () => path.join(home!, 'empty')

  // Built from the base alone: no config but the repo's own, no prompt, a home with nothing in it and a PATH of git's
  // own folder
  function envFor(git: string): Env {
    const env = baseEnv(ambient)
    const empty = emptyDir()
    const own = path.dirname(git)
    setVariable(env, 'PATH', env.PATH === undefined ? own : `${own}${path.delimiter}${env.PATH}`)
    setVariable(env, 'HOME', empty)
    setVariable(env, 'XDG_CONFIG_HOME', empty)
    if (process.platform === 'win32') {
      const { root } = path.parse(empty)
      setVariable(env, 'USERPROFILE', empty)
      setVariable(env, 'HOMEDRIVE', root.replace(/[\\/]+$/, ''))
      setVariable(env, 'HOMEPATH', empty.slice(root.length - 1))
    }
    env.GIT_CONFIG_NOSYSTEM = '1'
    env.GIT_ATTR_NOSYSTEM = '1'
    env.GIT_CONFIG_GLOBAL = nullDevice()
    env.GIT_TERMINAL_PROMPT = '0'
    // A promisor remote edited into the repo would fetch a missing object through a program of its choosing
    env.GIT_NO_LAZY_FETCH = '1'
    return env
  }

  async function run(repo: Repo, args: readonly string[], more: { input?: Buffer | string, env?: Env, maxOutput?: number, bare?: boolean } = {}) {
    // On every call, so a config edited inside the repo loses on the keys that would run a program
    const fixed = more.bare === true ? [] : [
      `--git-dir=${repo.dir}`, '--literal-pathspecs', '--no-pager',
      '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullDevice()}`, '-c', 'core.autocrlf=false', '-c', 'gc.auto=0',
      // No transport at all: a remote, a submodule or a promisor named in an edited config can't run upload-pack or ssh
      '-c', 'protocol.allow=never',
    ]
    return runClean(repo.git, [...fixed, ...args], {
      cwd: emptyDir(), env: more.env ?? repo.env, input: more.input, maxOutput: more.maxOutput ?? SMALL, signal: stopping.signal,
    })
  }

  // The command's output as text, or a throw when git refused it
  async function git(repo: Repo, args: readonly string[], more: Parameters<typeof run>[2] = {}): Promise<string> {
    const ran = await run(repo, args, more)
    if (ran.code !== 0 || ran.truncated) throw new Error(`git ${args[0]} ended with ${ran.code ?? ran.signal}: ${ran.stderr.toString('utf8').slice(0, 400)}`)
    return ran.stdout.toString('utf8')
  }

  // The repo for a notes folder, made the first time the folder is used. Its name comes from the folder's real path,
  // so two spellings of one folder share a history and two folders never do
  function repoOf(under: Folder): Promise<Repo> {
    let known = repos.get(under)
    if (known === undefined) {
      known = (async () => {
        const real = await realpath(under.folder)
        // Never a git from the notes folder or from hetu's own data
        const found = await findProgram('git', { path: lookup, outside: [under.dataDir, real] })
        if (found === null || inside(real, found)) throw refused('unavailable')
        const key = createHash('sha256').update(real).digest('hex').slice(0, 16)
        const dir = path.join(home!, key, 'shadow.git')
        const repo: Repo = { dir, git: found, env: envFor(found) }
        if (!await stat(path.join(dir, 'HEAD')).then(() => true, () => false)) {
          await mkdir(path.dirname(dir), { recursive: true })
          // No template, so the repo starts with no hooks folder and no sample files
          await git(repo, ['init', '--quiet', '--bare', '--template=', '--initial-branch=main', dir], { bare: true })
          await writeFile(path.join(path.dirname(dir), 'folder.txt'), `${real}\n`)
        }
        return repo
      })()
      repos.set(under, known)
      known.catch(() => {
        if (repos.get(under) === known) repos.delete(under)
      })
    }
    return known
  }

  const head = async (repo: Repo): Promise<string | null> => {
    const ran = await run(repo, ['rev-parse', '--verify', '--quiet', `${BRANCH}^{commit}`])
    const id = ran.stdout.toString('utf8').trim()
    return ran.code === 0 && commitId.test(id) ? id : null
  }

  // One note's bytes as they are now, null for none, with the path to record them under. A folder under that name is no
  // note either. The note is opened once and checked and read through that one handle, so what is read is what was
  // checked: a name swapped for a link to a file outside the notes folder between a check and a read by name would have
  // put that file in the repo. Where the system has them, a link at the last name is refused and a FIFO opens without
  // waiting for a writer. Once open, the caller's spelling is resolved again as named does, before the size or anything
  // else of the file is looked at: the open finds a note made since prepare under another case of the last name, which
  // the look at the folder never sees. The bytes go in only under the path judged or one the judge allows. A name that
  // holds another file by then is opened again, a few times before the call answers stale
  async function bytesOf(prepared: Canonical, target: Canonical, judged: (now: Canonical) => boolean): Promise<{ bytes: Buffer | null, target: Canonical }> {
    const spelled = spelling.get(prepared)
    const now = opening
    for (let tries = 1; ; tries++) {
      let handle
      try {
        handle = await open(target.absolute, NOTE_READ)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return { bytes: null, target }
        if (code === 'ELOOP') throw refused('failed')
        throw err
      }
      try {
        const info = await handle.stat({ bigint: true })
        // A path that stands for a name leading to a dot name has no spelling kept and no file at it
        if (now !== null && spelled !== undefined) {
          const options = { dataDir: now.dataDir, installDir: now.installDir }
          // The folder's look held, so only the last name is resolved again, the whole spelling when that gives anything
          // but a name in that folder
          const at = target
          const again = async () => (await lastNamed(at, spelled, options)) ?? canonical(now.folder, spelled, options)
          const found = await named(target, info, again, judged)
          if (found.state === 'moved') throw refused('not-granted')
          if (found.state === 'held') target = found.target
          else if (tries < OPENS) continue
          else throw refused('stale')
        }
        if (!info.isFile()) return { bytes: null, target }
        if (info.size > BigInt(fileBytes)) throw refused('failed', 'too-large')
        const bytes = await handle.readFile()
        if (bytes.length > fileBytes) throw refused('failed', 'too-large')
        return { bytes, target }
      } finally {
        await handle.close()
      }
    }
  }

  // The folder of a prepared path looked at again just before its note is read, as the luoshu does, with one more look
  // through canonical on the caller's spelling for a folder that reads as moved, whose path goes on when it is the one
  // judged or judged says the gate allows it. One gone since holds no note. Answers the path to read and record
  async function standing(prepared: Canonical, judged: (now: Canonical) => boolean): Promise<Canonical> {
    const spelled = spelling.get(prepared)
    const now = opening
    const { state, target } = now === null || spelled === undefined
      ? { state: await folderState(prepared.absolute), target: prepared }
      : await looked(prepared, folderState, () => canonical(now.folder, spelled, { dataDir: now.dataDir, installDir: now.installDir }), judged)
    if (state === 'moved') throw refused('not-granted')
    return target
  }

  async function commit(repo: Repo, call: Call, targets: readonly Canonical[]): Promise<unknown> {
    const { message } = call.args as { message: string }
    // Every note is read before git hears of any, so a file over the cap commits none of the call
    const notes: { path: string, bytes: Buffer | null }[] = []
    let total = 0
    // The paths as judged, each replaced once the gate allows the path a look resolved again
    const paths = targets.map(target => target.relative)
    // The judge's own refusal, so a commit refused for it answers what refused: the gate, a guard or a gate that is
    // down
    let denied: ProviderRefusal | null = null
    for (const [at, prepared] of targets.entries()) {
      // Each note's look runs in the one queue every history call waits in, so a call whose time ran out on the notes
      // before stops here, before git hears of any
      if (Date.now() > call.deadline) throw refused('timeout')
      const judged = (now: Canonical) => {
        const next = paths.with(at, now.relative)
        if (call.judge === undefined) return false
        const answer = call.judge(next)
        denied = answer === null ? null : refused(answer.code, answer.reason)
        if (answer !== null) return false
        paths[at] = now.relative
        return true
      }
      try {
        const { bytes, target } = await bytesOf(prepared, await standing(prepared, judged), judged)
        total += bytes?.length ?? 0
        // All of a commit sits in memory at once, so the call as a whole has a cap too
        if (total > commitBytes) throw refused('failed', 'too-large')
        notes.push({ path: target.relative, bytes })
      } catch (err) {
        throw passedOn(err, denied)
      }
    }
    const parent = await head(repo)
    // Only history writes this repo and one call at a time, so a lock here was left by a git ended mid-write. The index
    // starts as the last commit, so nothing an earlier git staged goes into this one
    await rm(path.join(repo.dir, 'index.lock'), { force: true })
    await git(repo, parent === null ? ['read-tree', '--empty'] : ['read-tree', parent])
    try {
      const entries: string[] = []
      // A note gone first, so a folder of its name can take its place in the same commit
      for (const note of notes.filter(entry => entry.bytes === null)) entries.push(`0 ${NO_COMMIT}\t${note.path}\0`)
      for (const note of notes) {
        if (note.bytes === null) continue
        // The bytes as they are: no filter, no line ending or encoding change, whatever attribute files say. git applies
        // none to stdin with no path given, and the flag keeps it so
        const blob = (await git(repo, ['hash-object', '-w', '--no-filters', '--stdin'], { input: note.bytes })).trim()
        if (!commitId.test(blob)) throw new Error('git hash-object gave no id')
        entries.push(`100644 ${blob}\t${note.path}\0`)
      }
      await git(repo, ['update-index', '--add', '--replace', '-z', '--index-info'], { input: entries.join('') })
      const tree = (await git(repo, ['write-tree'])).trim()
      if (parent !== null && (await git(repo, ['rev-parse', '--verify', `${parent}^{tree}`])).trim() === tree) return { commit: null }
      // An empty tree with nothing before it is a commit of nothing
      if (parent === null && notes.every(note => note.bytes === null)) return { commit: null }
      const committer = nameOf(callerName(call.caller)) || 'hetu'
      const author = (call.onBehalf === undefined ? '' : nameOf(call.onBehalf)) || committer
      const env: Env = Object.assign(Object.create(null), repo.env, {
        GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: 'author@hetu.invalid', GIT_COMMITTER_NAME: committer, GIT_COMMITTER_EMAIL: 'committer@hetu.invalid',
      })
      // Never signed, so no config in the repo can name a signing program to run
      const made = (await git(repo, ['commit-tree', '--no-gpg-sign', tree, ...(parent === null ? [] : ['-p', parent])], { input: message, env })).trim()
      if (!commitId.test(made)) throw new Error('git commit-tree gave no id')
      await git(repo, ['update-ref', BRANCH, made, parent ?? NO_COMMIT])
      return { commit: made }
    } catch (err) {
      // The index back to the last commit, so a call that failed leaves nothing for the next one to commit
      await run(repo, parent === null ? ['read-tree', '--empty'] : ['read-tree', parent]).catch(() => {})
      throw err
    }
  }

  // The commits of a page that changed a path with no dot segment under the folder or note logged. A build from before
  // dot names were refused could have committed one. A commit that changed nothing else would show its author, date
  // and message in a folder's log. diff-tree names the changed paths of each commit in the order given
  async function plainOf(repo: Repo, ids: readonly string[], relative: string): Promise<Set<string>> {
    const out = await git(repo, ['diff-tree', '--stdin', '-r', '-z', '--name-only', '--root', '--no-renames', '--', relative], {
      input: ids.map(id => `${id}\n`).join(''), maxOutput: ids.length * MAX_COMMIT_PATHS * (MAX_SCOPE_LENGTH * 3 + 1) + SMALL,
    })
    const plain = new Set<string>()
    let at = -1
    for (const item of out.split('\0')) {
      if (ids[at + 1] === item) at++
      else if (at >= 0 && item !== '' && !item.split('/').some(isDotName)) plain.add(ids[at])
    }
    return plain
  }

  async function log(repo: Repo, call: Call, target: Canonical): Promise<unknown> {
    if (await head(repo) === null) return { commits: [] }
    const limit = (call.args as { limit?: number }).limit ?? LOG_PAGE
    const format = ['%H', '%an', '%cn', '%aI', '%B'].join('%x1f')
    const commits: HistoryCommit[] = []
    // A page at a time until the commits kept fill one, since a page can lose some. The first page is the limit, all a
    // log with no commit of dot paths only needs. Each after it is the largest page, so a run of such commits costs a
    // page for every 200 and not one for each. The deadline is looked at before each page, so a long run ends there and
    // frees the calls waiting behind it
    for (let skip = 0, size = limit; commits.length < limit; skip += size, size = MAX_LOG_PAGE) {
      if (Date.now() > call.deadline) throw refused('timeout')
      // A message of the longest kind is three bytes a character, with room for the names, the date and the id
      const out = await git(repo, ['rev-list', `--max-count=${size}`, `--skip=${skip}`, `--format=${format}%x1e`, BRANCH, '--', target.relative], { maxOutput: size * (MAX_COMMIT_MESSAGE * 3 + 4096) })
      const page: HistoryCommit[] = []
      for (const record of out.split(RECORD)) {
        // rev-list writes its own "commit <id>" line before each formatted one
        const fields = record.replace(/^\s*commit [0-9a-f]+\n/, '').split(FIELD)
        if (fields.length !== 5 || !commitId.test(fields[0])) continue
        const [id, author, committer, date, message] = fields
        page.push({ commit: id, author, committer, date, message: message.replace(/\n+$/, '') })
      }
      if (page.length === 0) break
      const plain = await plainOf(repo, page.map(listed => listed.commit), target.relative)
      commits.push(...page.filter(listed => plain.has(listed.commit)))
      if (page.length < size) break
    }
    return { commits: commits.slice(0, limit) }
  }

  async function read(repo: Repo, call: Call, target: Canonical): Promise<unknown> {
    const { commit: id } = call.args as { commit: string }
    if (!commitId.test(id)) throw refused('invalid')
    // Through ^{commit}, so the id of a tree or a blob names nothing
    const ran = await run(repo, ['cat-file', 'blob', `${id}^{commit}:${target.relative}`], { maxOutput: fileBytes + 1 })
    if (ran.code !== 0) throw refused('not-found')
    if (ran.truncated || ran.stdout.length > fileBytes) throw refused('failed', 'too-large')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(ran.stdout)
    } catch {
      throw refused('failed', 'not-text')
    }
    return { text, version: createHash('sha256').update(ran.stdout).digest('hex') }
  }

  function forget(callId: string): void {
    resolved.delete(callId)
    preparedUnder.delete(callId)
  }

  const provider: Provider = {
    async prepare(call: Call): Promise<Prepared | ProviderRefusal> {
      const under = opening
      if (home === null || under === null) return refused('unavailable')
      const args = (call.args ?? {}) as { path?: unknown, paths?: unknown }
      const named = call.action === 'history.commit' ? args.paths : [args.path]
      if (!Array.isArray(named) || named.length === 0 || !named.every(item => typeof item === 'string')) return refused('invalid')
      const targets: Canonical[] = []
      for (const item of named as string[]) {
        const found = await canonical(under.folder, item, { dataDir: under.dataDir, installDir: under.installDir })
        // A name spelled with no dot that leads to a dot name is taken as the same name missing, at a path no file has,
        // so its commit, log and read answer as a missing note's do. History writes nothing in the notes folder
        let target: Canonical
        if (found.ok) {
          target = found
          spelling.set(target, item)
        } else if (found.code === 'not-granted' && found.absent !== undefined) target = found.absent
        else return refused(found.code)
        if (!targets.some(known => known.relative === target.relative)) targets.push(target)
      }
      resolved.set(call.callId, targets)
      preparedUnder.set(call.callId, under)
      return { scope: { paths: targets.map(target => target.relative) } }
    },

    async perform(call: Call): Promise<unknown> {
      const targets = resolved.get(call.callId)
      const under = preparedUnder.get(call.callId)
      forget(call.callId)
      // A folder picked since prepare, or none now, ends the call: its paths belong to the folder before
      if (home === null || opening === null || under !== opening) throw refused('unavailable')
      if (targets === undefined || targets.length === 0) throw refused('failed')
      return inOrder(async () => {
        // A call waits its turn behind the others, so what held at perform is asked again
        if (Date.now() > call.deadline) throw refused('timeout')
        if (home === null || opening !== under) throw refused('unavailable')
        const repo = await repoOf(under)
        if (call.action === 'history.commit') return commit(repo, call, targets)
        if (call.action === 'history.log') return log(repo, call, targets[0])
        if (call.action === 'history.read') return read(repo, call, targets[0])
        throw refused('invalid')
      })
    },

    release(call: Call): void {
      forget(call.callId)
    },
  }

  const role: HistoryRole = {
    open(next: Opening): void {
      opening = next.folder === null ? null : { ...next, folder: next.folder }
    },
  }

  return {
    provider,
    role,

    async start(dataDir: string): Promise<void> {
      const found = await findProgram('git', { path: lookup, outside: [dataDir] })
      if (found === null) throw new Error('history needs git and found none on the path outside hetu\'s own folders')
      const dir = path.join(dataDir, 'host', 'history')
      await mkdir(path.join(dir, 'empty'), { recursive: true })
      stopping = new AbortController()
      home = dir
    },

    close(): void {
      home = null
      opening = null
      repos.clear()
      stopping.abort()
    },
  }
}
