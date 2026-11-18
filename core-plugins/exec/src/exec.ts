import { randomBytes } from 'node:crypto'
import { mkdir, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { commandKey, envNameProblem, EXEC_OUTPUT_BYTES, EXEC_RUNNING } from 'hetu-core/api/exec.ts'
import type { Call, ExecRole, ExecView, Opening, Prepared, Provider, ProviderRefusal } from 'hetu-core/api/slots.ts'
import { asOpened, baseEnv, findProgram, inside, runClean, throughShare, withDeclared } from 'hetu-core/lib/clean-env.ts'

export type ExecOptions = {
  // The path programs are looked up on and the environment variables are passed through from, hetu's own but in tests
  path?: string
  ambient?: Readonly<Record<string, string | undefined>>
  // What is kept of stdout and of stderr and how many commands one caller runs at once, core/api's but in tests
  outputBytes?: number
  running?: number
}

export type Exec = {
  provider: Provider
  role: ExecRole
  // Makes exec's own folder under the data folder and clears what a crash left there
  start(dataDir: string): Promise<void>
  // Ends what is running and serves nothing more, for the plugin's stop
  close(): void
}

const refused = (code: ProviderRefusal['code'], reason?: ProviderRefusal['reason']): ProviderRefusal => (reason === undefined ? { code } : { code, reason })

// One plugin's exec items as exec matches them: each command's key with the variables its items name, and every
// variable the plugin's items name, for a command past the list
type Held = { commands: Map<string, string[]>, env: string[] }
type View = { plugins: Map<string, Held>, any: Set<string>, opening: Opening }
// What prepare settled for a call: the command it judged, the program's real path and the variables it gets
type Ready = { key: string, program: string, env: readonly string[] }

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

// The view the loader hands over, checked and indexed once. A throw marks exec failed, so a view it can't read leaves
// it refusing
function indexed(view: ExecView): View {
  if (typeof view !== 'object' || view === null) throw new Error('a view exec can\'t read')
  const { plugins, any, opening } = view
  if (typeof plugins !== 'object' || plugins === null || !strings(any)) throw new Error('a view with no plugins or no list of any-command plugins')
  if (typeof opening !== 'object' || opening === null || typeof opening.dataDir !== 'string' || typeof opening.installDir !== 'string'
    || (opening.folder !== null && typeof opening.folder !== 'string')) throw new Error('a view with no folders')
  const held = new Map<string, Held>()
  for (const [id, items] of Object.entries(plugins)) {
    if (!Array.isArray(items)) throw new Error('a plugin with no items')
    const commands = new Map<string, string[]>()
    const all = new Set<string>()
    for (const item of items) {
      if (typeof item !== 'object' || item === null || !Array.isArray(item.commands) || !strings(item.env)) throw new Error('an item exec can\'t read')
      for (const command of item.commands) {
        if (!strings(command) || command.length === 0) throw new Error('a command that is no argument array')
        const key = commandKey(command)
        commands.set(key, [...new Set([...(commands.get(key) ?? []), ...item.env])])
      }
      for (const name of item.env) all.add(name)
    }
    // A plugin whose items list no command holds nothing to run or to lift
    if (commands.size > 0) held.set(id, { commands, env: [...all] })
  }
  return { plugins: held, any: new Set(any), opening: { folder: opening.folder, dataDir: opening.dataDir, installDir: opening.installDir } }
}

// The real path of the deepest part of a path that exists, with the names under it that don't. A path that can't be
// resolved comes back as written
async function resolvedDeep(file: string): Promise<string> {
  let current = file
  const rest: string[] = []
  for (;;) {
    const real = await realpath(current).catch(() => null)
    if (real !== null) return path.join(real, ...rest)
    const parent = path.dirname(current)
    if (parent === current) return file
    rest.unshift(path.basename(current))
    current = parent
  }
}

// What an argument could name as a file: the argument itself, what follows an equals sign in it and a file URL's path.
// A URL parser drops spaces and control characters before a URL, so they don't hide one. A file URL naming a host is
// a share
function namedBy(arg: string): string[] {
  const found = [arg]
  const equals = arg.indexOf('=')
  if (equals !== -1 && equals < arg.length - 1) found.push(arg.slice(equals + 1))
  for (const text of [...found]) {
    if (!/^[\x00-\x20]*file:/i.test(text)) continue
    try {
      const url = new URL(text)
      const local = decodeURIComponent(process.platform === 'win32' ? url.pathname.replace(/^\/(?=[A-Za-z]:)/, '') : url.pathname)
      found.push(url.hostname === '' ? path.normalize(local) : `//${url.hostname}${url.pathname}`)
    } catch {}
  }
  return found
}

// exec.run for a plugin that holds an exec item. The gate judges the command when it is on. This check is exec's own
// and holds with the gate off: the caller's whole argument array has to be one its grants list, unless the human let
// that plugin run any command. A program runs by its real path with no shell, in an environment built from empty with
// only the variables its item names, in a new empty folder of exec's own, and neither the program nor any argument may
// name a file in the notes folder or in hetu's data, where a plugin could have written it
export function createExec(options: ExecOptions = {}): Exec {
  const ambient = options.ambient ?? process.env
  const lookup = options.path ?? ambient.PATH ?? ambient.Path
  const outputBytes = options.outputBytes ?? EXEC_OUTPUT_BYTES
  const limit = options.running ?? EXEC_RUNNING
  let home: string | null = null
  let view: View | null = null
  const ready = new Map<string, Ready>()
  const running = new Map<string, number>()
  let stopping = new AbortController()

  // The folders a command may take nothing from, by their real paths. One that doesn't exist holds nothing
  async function closed(opening: Opening): Promise<string[]> {
    const real: string[] = []
    for (const folder of [opening.folder, opening.dataDir]) {
      if (folder === null) continue
      real.push(await resolvedDeep(folder))
    }
    return real
  }

  // Whether an argument names a file in one of those folders, read the way Windows opens it. An absolute path counts
  // wherever it leads, by the real path of as much of it as exists. A relative one names a file in the working folder,
  // which is new and empty, unless it climbs out of it, and then it counts as an absolute one does, whether or not the
  // file is there yet, since a plugin can write it between prepare and the run. A path through a share always counts
  async function reaches(arg: string, roots: readonly string[], cwd: string): Promise<boolean> {
    for (const named of namedBy(arg)) {
      if (named === '' || named.includes('\0')) continue
      if (throughShare(named)) return true
      // A name of dots and spaces alone other than . and .. could climb any number of folders on some Windows paths
      if (process.platform === 'win32' && named.split(/[\\/]/).some(part => /^[. ]+$/.test(part) && part !== '.' && part !== '..')) return true
      const text = asOpened(named)
      let target: string
      if (path.isAbsolute(text)) {
        target = await resolvedDeep(path.resolve(text))
      } else {
        const joined = path.resolve(cwd, text)
        if (inside(cwd, joined)) continue
        target = await resolvedDeep(joined)
      }
      if (roots.some(root => inside(root, target))) return true
    }
    return false
  }

  const provider: Provider = {
    async prepare(call: Call): Promise<Prepared | ProviderRefusal> {
      const now = view
      if (home === null || now === null) return refused('unavailable')
      if (call.action !== 'exec.run') return refused('invalid')
      const { command } = (call.args ?? {}) as { command?: unknown }
      if (!strings(command) || command.length === 0 || command.some(arg => arg === '')) return refused('invalid')
      // Only a plugin holds exec. A window and a content frame never do
      if (call.caller.kind !== 'plugin') return refused('not-granted')
      const held = now.plugins.get(call.caller.id)
      if (held === undefined) return refused('not-granted')
      const key = commandKey(command)
      const listed = held.commands.get(key)
      if (listed === undefined && !now.any.has(call.caller.id)) return refused('not-granted')
      const env = listed ?? held.env
      // The schema refuses these names in a manifest, so one here came past it
      if (env.some(name => envNameProblem(name) !== null)) return refused('not-granted')
      const roots = await closed(now.opening)
      const program = await findProgram(command[0], { path: lookup, outside: roots })
      if (program === null) return refused('not-granted')
      // A working folder as each run gets one, which doesn't exist: the same depth, with nothing in it
      const cwd = path.join(home, 'run-0')
      for (const arg of command.slice(1)) {
        if (await reaches(arg, roots, cwd)) return refused('not-granted')
      }
      ready.set(call.callId, { key, program, env })
      return { scope: {} }
    },

    async perform(call: Call, prepared: Prepared): Promise<unknown> {
      const kept = ready.get(call.callId)
      ready.delete(call.callId)
      const dir = home
      if (dir === null || view === null) throw refused('unavailable')
      // The command the carrier had judged, which is the one prepare settled or the call fails
      const command = prepared.scope.command ?? (call.args as { command?: unknown }).command
      if (kept === undefined || !strings(command) || commandKey(command) !== kept.key || call.caller.kind !== 'plugin') throw refused('failed')
      const id = call.caller.id
      const count = running.get(id) ?? 0
      if (count >= limit) throw refused('throttled')
      running.set(id, count + 1)
      const cwd = path.join(dir, `run-${randomBytes(8).toString('hex')}`)
      try {
        await mkdir(cwd)
        const ran = await runClean(kept.program, command.slice(1), {
          cwd, env: withDeclared(baseEnv(ambient), kept.env, ambient), maxOutput: outputBytes, deadline: call.deadline, signal: stopping.signal,
        })
        if (ran.timedOut) throw refused('timeout')
        return {
          code: ran.code, signal: ran.signal, stdout: ran.stdout.toString('utf8'), stderr: ran.stderr.toString('utf8'), truncated: ran.truncated,
        }
      } finally {
        const left = (running.get(id) ?? 1) - 1
        if (left <= 0) running.delete(id)
        else running.set(id, left)
        await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
      }
    },

    release(call: Call): void {
      ready.delete(call.callId)
    },
  }

  const role: ExecRole = {
    stateChanged(next: ExecView): void {
      view = indexed(next)
    },
  }

  return {
    provider,
    role,

    async start(dataDir: string): Promise<void> {
      const dir = path.join(dataDir, 'host', 'exec')
      await mkdir(dir, { recursive: true })
      // Working folders a crash left mid-run
      for (const name of await readdir(dir)) {
        if (name.startsWith('run-')) await rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
      }
      stopping = new AbortController()
      home = dir
    },

    close(): void {
      home = null
      view = null
      ready.clear()
      stopping.abort()
    },
  }
}
