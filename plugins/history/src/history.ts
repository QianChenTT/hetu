import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HistoryCommit } from 'hetu-core/api/actions.ts'
import type { Caller } from 'hetu-core/api/envelope.ts'
import { HISTORY_FILE_BYTES, LOG_PAGE } from 'hetu-core/api/exec.ts'
import type { Call, HistoryRole, Opening, Prepared, Provider, ProviderRefusal } from 'hetu-core/api/slots.ts'
import { canonical, type Canonical } from 'hetu-core/lib/canonical.ts'
import { baseEnv, type Env, findProgram, inside, nullDevice, runClean, setVariable } from 'hetu-core/lib/clean-env.ts'

export type HistoryOptions = {
  // The path git is looked up on and the environment the base is read from, hetu's own but in tests
  path?: string
  ambient?: Readonly<Record<string, string | undefined>>
  // The largest file a commit stores, HISTORY_FILE_BYTES but in tests
  fileBytes?: number
}

export type History = {
  provider: Provider
  role: HistoryRole
  // Finds git and makes history's own folders under the data folder. Throws with no git to run
  start(dataDir: string): Promise<void>
  // Ends what is running and serves nothing more, for the plugin's stop
  close(): void
}

const refused = (code: ProviderRefusal['code'], reason?: ProviderRefusal['reason']): ProviderRefusal => (reason === undefined ? { code } : { code, reason })
const commitId = /^[0-9a-f]{40}$/
const NO_COMMIT = '0'.repeat(40)
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
  const ambient = options.ambient ?? process.env
  const lookup = options.path ?? ambient.PATH ?? ambient.Path
  let home: string | null = null
  let opening: Folder | null = null
  const repos = new Map<Folder, Promise<Repo>>()
  const resolved = new Map<string, Canonical[]>()
  const preparedUnder = new Map<string, Folder>()
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
    return env
  }

  async function run(repo: Repo, args: readonly string[], more: { input?: Buffer | string, env?: Env, maxOutput?: number, bare?: boolean } = {}) {
    // On every call, so a config edited inside the repo loses on the keys that would run a program
    const fixed = more.bare === true ? [] : [
      `--git-dir=${repo.dir}`, '--literal-pathspecs', '--no-pager',
      '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullDevice()}`, '-c', 'core.autocrlf=false', '-c', 'gc.auto=0',
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

  // One note's bytes as they are now, null for none. A folder under that name is no note either
  async function bytesOf(target: Canonical): Promise<Buffer | null> {
    let size: number
    try {
      const info = await stat(target.absolute)
      if (!info.isFile()) return null
      size = info.size
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw err
    }
    if (size > fileBytes) throw refused('failed', 'too-large')
    const bytes = await readFile(target.absolute)
    if (bytes.length > fileBytes) throw refused('failed', 'too-large')
    return bytes
  }

  async function commit(repo: Repo, call: Call, targets: readonly Canonical[]): Promise<unknown> {
    const { message } = call.args as { message: string }
    // Every note is read before git hears of any, so a file over the cap commits none of the call
    const notes: { path: string, bytes: Buffer | null }[] = []
    for (const target of targets) notes.push({ path: target.relative, bytes: await bytesOf(target) })
    const parent = await head(repo)
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

  async function log(repo: Repo, call: Call, target: Canonical): Promise<unknown> {
    if (await head(repo) === null) return { commits: [] }
    const limit = (call.args as { limit?: number }).limit ?? LOG_PAGE
    const format = ['%H', '%an', '%cn', '%aI', '%B'].join('%x1f')
    const out = await git(repo, ['rev-list', `--max-count=${limit}`, `--format=${format}%x1e`, BRANCH, '--', target.relative])
    const commits: HistoryCommit[] = []
    for (const record of out.split(RECORD)) {
      // rev-list writes its own "commit <id>" line before each formatted one
      const fields = record.replace(/^\s*commit [0-9a-f]+\n/, '').split(FIELD)
      if (fields.length !== 5 || !commitId.test(fields[0])) continue
      const [id, author, committer, date, message] = fields
      commits.push({ commit: id, author, committer, date, message: message.replace(/\n+$/, '') })
    }
    return { commits }
  }

  async function read(repo: Repo, call: Call, target: Canonical): Promise<unknown> {
    const { commit: id } = call.args as { commit: string }
    if (!commitId.test(id)) throw refused('invalid')
    const ran = await run(repo, ['cat-file', 'blob', `${id}:${target.relative}`], { maxOutput: fileBytes + 1 })
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
        const target = await canonical(under.folder, item, { dataDir: under.dataDir, installDir: under.installDir })
        if (!target.ok) return refused(target.code)
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
