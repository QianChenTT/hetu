import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { envNameProblem } from '../api/exec.ts'

// How history and exec start a program: an environment built from empty, the program by its real absolute path and no
// shell. Nothing of hetu's own environment reaches a command unless it is named

export type Env = Record<string, string>
type Ambient = Readonly<Record<string, string | undefined>>

// A variable's value by name. Windows reads names without case, and only process.env itself does that for a lookup
function lookup(ambient: Ambient, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return Object.hasOwn(ambient, name) ? ambient[name] : undefined
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(ambient)) {
    if (key.toUpperCase() === upper) return value
  }
  return undefined
}

// Node starts a Windows process with these whether the caller names them or not: libuv copies each one that is missing
// from its own environment. PATH and SystemRoot are among them and set apart below
const WINDOWS_CARRIED = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SystemDrive', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'windir']

// What every command starts with. Nothing on macOS and Linux. On Windows an environment can't start empty, so the
// base sets what libuv would carry over anyway, on purpose: who the user is and where Windows is, as hetu has them, and
// a PATH of System32 alone, so hetu's own PATH reaches a command only when it is named
export function baseEnv(ambient: Ambient = process.env, platform: NodeJS.Platform = process.platform): Env {
  const env: Env = Object.create(null)
  if (platform !== 'win32') return env
  const root = lookup(ambient, 'SystemRoot', platform) ?? 'C:\\Windows'
  env.SystemRoot = root
  env.PATH = path.win32.join(root, 'System32')
  for (const name of WINDOWS_CARRIED) {
    const value = lookup(ambient, name, platform)
    if (value !== undefined) env[name] = value
  }
  return env
}

// env with one variable set. On Windows a name already there in another case is the same variable, so it goes first
export function setVariable(env: Env, name: string, value: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    const upper = name.toUpperCase()
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === upper) delete env[key]
    }
  }
  env[name] = value
}

// base with the variables named, each with the value hetu itself has. A name that is unset is left out, and so is one
// that makes a program load code or is no name at all, whatever list it came in
export function withDeclared(base: Env, names: readonly string[], ambient: Ambient = process.env, platform: NodeJS.Platform = process.platform): Env {
  const env: Env = Object.assign(Object.create(null), base)
  for (const name of names) {
    if (envNameProblem(name) !== null) continue
    const value = lookup(ambient, name, platform)
    if (value !== undefined) setVariable(env, name, value, platform)
  }
  return env
}

// The null device as git takes it for a config file. Node's os.devNull on Windows is \\.\nul, which git refuses
export function nullDevice(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'NUL' : '/dev/null'
}

// Windows and macOS volumes compare names without case
const foldsCase = (platform: NodeJS.Platform) => platform === 'win32' || platform === 'darwin'

// Whether target is the folder or lies under it. Both are real paths from the OS
export function inside(folder: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const [outer, inner] = foldsCase(platform) ? [folder.toLowerCase(), target.toLowerCase()] : [folder, target]
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep)
}

// The real path of each folder that exists. One that doesn't holds nothing a program could be found in
async function realFolders(folders: readonly string[]): Promise<string[]> {
  const real: string[] = []
  for (const folder of folders) {
    const found = await realpath(folder).catch(() => null)
    if (found !== null) real.push(found)
  }
  return real
}

// A shell would run these, and Node refuses to start one without a shell
const scripts = new Set(['.cmd', '.bat'])
// What Windows adds to a name with no extension, in this order. Never PATHEXT, which a user can point at scripts
const extensions = ['.exe', '.com']

// The file as a program to run: its real path when it is a file the user may execute, outside every folder named and
// no script
async function runnable(file: string, outside: readonly string[], platform: NodeJS.Platform): Promise<string | null> {
  const info = await stat(file).catch(() => null)
  if (info === null || !info.isFile()) return null
  const real = await realpath(file).catch(() => null)
  if (real === null) return null
  if (platform === 'win32' && scripts.has(path.extname(real).toLowerCase())) return null
  if (platform !== 'win32' && !await access(real, constants.X_OK).then(() => true, () => false)) return null
  return outside.some(folder => inside(folder, real, platform)) ? null : real
}

export type FindOptions = {
  // The PATH to search, hetu's own
  path: string | undefined
  // Folders a command may run nothing from: a program found inside one, or through a link into one, is passed over
  outside: readonly string[]
  platform?: NodeJS.Platform
}

// A program by an absolute path or by a bare name looked up on the path, as its real absolute path, or null. Entries
// that aren't absolute are skipped, so the working directory is never searched, and a name with a folder in it is
// refused for the same reason
export async function findProgram(name: string, options: FindOptions): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const outside = await realFolders(options.outside)
  const spellings = (file: string) => (platform === 'win32' && path.extname(file) === '' ? extensions.map(extension => file + extension) : [file])
  if (path.isAbsolute(name)) {
    for (const file of spellings(name)) {
      const found = await runnable(file, outside, platform)
      if (found !== null) return found
    }
    return null
  }
  if (name === '' || name.includes('/') || name.includes('\\')) return null
  for (const folder of (options.path ?? '').split(path.delimiter)) {
    if (folder === '' || !path.isAbsolute(folder)) continue
    for (const file of spellings(path.join(folder, name))) {
      const found = await runnable(file, outside, platform)
      if (found !== null) return found
    }
  }
  return null
}

export type RunOptions = {
  cwd: string
  env: Env
  // Written to the program's stdin, which is then closed. With none it is closed at once
  input?: Buffer | string
  // What is kept of stdout and of stderr, each. More is dropped and the program runs on
  maxOutput: number
  // ms since the epoch. A program still running then is ended
  deadline?: number
  // Ends the program when aborted
  signal?: AbortSignal
}

export type Ran = { code: number | null, signal: string | null, stdout: Buffer, stderr: Buffer, truncated: boolean, timedOut: boolean }

// The longest delay a timer takes
const MAX_TIMER_MS = 2 ** 31 - 1

// Runs a program by its path with the arguments as they are: no shell, no window, the environment exactly as given.
// Rejects when the program can't start. A program ended at the deadline resolves with timedOut
export function runClean(program: string, args: readonly string[], options: RunOptions): Promise<Ran> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new Error('aborted before the program started'))
      return
    }
    const child = spawn(program, [...args], {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let truncated = false
    let timedOut = false
    const collect = (stream: NodeJS.ReadableStream) => {
      const pieces: Buffer[] = []
      let size = 0
      stream.on('data', (piece: Buffer) => {
        const room = options.maxOutput - size
        if (piece.length > room) truncated = true
        if (room <= 0) return
        const kept = piece.length > room ? piece.subarray(0, room) : piece
        pieces.push(kept)
        size += kept.length
      })
      return () => Buffer.concat(pieces)
    }
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    const end = () => { child.kill() }
    const left = options.deadline === undefined ? null : Math.min(Math.max(0, options.deadline - Date.now()), MAX_TIMER_MS)
    const timer = left === null ? null : setTimeout(() => {
      timedOut = true
      end()
    }, left)
    options.signal?.addEventListener('abort', end, { once: true })
    const done = () => {
      if (timer !== null) clearTimeout(timer)
      options.signal?.removeEventListener('abort', end)
    }
    child.on('error', err => {
      done()
      reject(err)
    })
    child.on('close', (code, signal) => {
      done()
      resolve({ code, signal, stdout: stdout(), stderr: stderr(), truncated, timedOut })
    })
    // A program that ends without reading its input closes the pipe under the write
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })
}
