import { spawn, spawnSync } from 'node:child_process'
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FuseState, FuseV1Options, pathToFuseFile } from '@electron/fuses'
import { stateDir } from '../../backend/boot/state.ts'
import type { FuseName } from '../../build/fuses.ts'
import { executableIn } from '../../build/package.ts'

export const repo = path.join(import.meta.dirname, '..', '..', '..')
const platformFolder = process.platform === 'win32' ? 'win-unpacked' : process.platform === 'darwin' ? 'mac-arm64' : 'linux-unpacked'
// The packed folder under test: the folder build unless HETU_PACKAGED_APP names another, an install among them
export const appDir = process.env.HETU_PACKAGED_APP ?? path.join(repo, 'dist-package', 'dir', platformFolder)
export const resourcesOf = (dir: string) => (process.platform === 'darwin' ? path.join(dir, 'hetu.app', 'Contents', 'Resources') : path.join(dir, 'resources'))

const made: string[] = []

export async function cleanup(): Promise<void> {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

export async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-packaged-'))
  made.push(dir)
  return dir
}

// A new folder on the packed folder's volume, since a hard link can't cross volumes and a runner's temp folder can be
// on another. Where nothing can be written beside it, such as an install, the temp folder
async function besideApp(): Promise<string> {
  try {
    const root = path.join(path.dirname(appDir), 'copies')
    await mkdir(root, { recursive: true })
    const dir = await mkdtemp(path.join(root, 'hetu-packaged-'))
    made.push(dir)
    return dir
  } catch {
    return temp()
  }
}

// A copy of the packed folder made of hard links, so a test changes the files it names and costs no copy of the rest.
// The files named are copied for real, since writing through a link would change the original. A file Linux won't
// hard-link for another user, such as chrome-sandbox once it is root's with the setuid bit, is linked by name instead,
// since a real copy would lose both and a locked build can't start without the sandbox
export async function linkedCopy(real: readonly string[] = []): Promise<string> {
  const to = path.join(await besideApp(), 'app')
  // Signing a copy again on macOS rewrites the bundle's signature files, which through a link would change the original
  const copied = (file: string) => real.includes(file) || file.includes('/_CodeSignature/')
  const walk = async (from: string, into: string) => {
    await mkdir(into, { recursive: true })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name)
      const target = path.join(into, entry.name)
      // A link inside the folder, such as those in a macOS framework, is made again as the same link
      if (entry.isSymbolicLink()) await symlink(await readlink(source), target)
      else if (entry.isDirectory()) await walk(source, target)
      else if (copied(path.relative(appDir, source).split(path.sep).join('/'))) await copyFile(source, target)
      else await link(source, target).catch(async (err: unknown) => {
        if (process.platform !== 'linux' || (err as { code?: string }).code !== 'EPERM') throw err
        await symlink(source, target)
      })
    }
  }
  await walk(appDir, to)
  return to
}

// hetu's environment with the folders a packaged build finds its data by pointed at a new temp folder, and nothing of
// hetu's own or Electron's that a test didn't ask for
export async function homeEnv(extra: Record<string, string> = {}): Promise<{ env: Record<string, string>, dataDir: string }> {
  const home = await temp()
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(HETU_|ELECTRON_|NODE_OPTIONS$)/i.test(name)) continue
    env[name] = value
  }
  Object.assign(env, { LOCALAPPDATA: home, APPDATA: home, HOME: home, USERPROFILE: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home }, extra)
  return { env, dataDir: stateDir(process.platform, env) }
}

export async function records(dataDir: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path.join(dataDir, 'events', 'events-1.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

// code and signal are Node's for the exit, so a death by signal has a null code and names the signal. killed says the
// test ended the process once its wait was over
export type Started = { code: number | null, signal: string | null, killed: boolean, stderr: string, records: Record<string, unknown>[], dataDir: string, ready: boolean }

// The last characters of stderr, where a fatal error lands
const TAIL = 2000

// How a start ended, for an assertion's message
export function exitText(started: Started): string {
  const tail = started.stderr.length > TAIL ? started.stderr.slice(-TAIL) : started.stderr
  const how = started.killed ? 'ended by the test' : `code ${started.code}, signal ${started.signal}`
  return `${how}, ready ${started.ready}, stderr's end:\n${tail.trim() === '' ? '(empty)' : tail}`
}

// Where a copy of hetu named electron goes: beside the executable, so on macOS inside the bundle, where the executable
// finds the Electron framework as a real copy of the app would have it
export function electronCopyIn(appOutDir: string, platform: string = process.platform): string {
  return path.join(path.dirname(executableIn(appOutDir, platform)), platform === 'win32' ? 'electron.exe' : 'electron')
}

// The file that holds Electron's fuses, as @electron/fuses finds it: the executable on Windows and Linux, the Electron
// framework inside the bundle on macOS
export function fuseFileIn(appOutDir: string, platform: string = process.platform): string {
  return pathToFuseFile(executableIn(appOutDir, platform))
}

// A fuse's state as its byte in a wire getCurrentFuseWire read
export function fuseText(wire: Readonly<Record<number, number>>, fuse: FuseName): string {
  const byte = wire[FuseV1Options[fuse]]
  return `${fuse} ${byte === FuseState.ENABLE ? 'on' : byte === FuseState.DISABLE ? 'off' : `byte ${byte}`}`
}

// The header's JSON text in an archive's bytes: a pickled size, then a pickle holding the text's length and the text.
// These are the bytes Electron checks against the integrity the build recorded
export function asarHeader(bytes: Buffer): { start: number, length: number } {
  return { start: 16, length: bytes.readUInt32LE(12) }
}

// The SHA-256 recorded for Resources/app.asar under ElectronAsarIntegrity in an Info.plist in XML
export function plistAsarHash(text: string): string | undefined {
  const integrity = /<key>ElectronAsarIntegrity<\/key>\s*<dict>([\s\S]*?)<\/dict>\s*<\/dict>/.exec(text)?.[1]
  if (integrity === undefined) return undefined
  return /<key>Resources\/app\.asar<\/key>\s*<dict>[\s\S]*?<key>hash<\/key>\s*<string>([^<]*)<\/string>/.exec(integrity)?.[1]
}

// The process and every one it started, which a plain kill on Windows leaves running
function end(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
}

// Starts a packed hetu as a plain process and waits for core.ready, for the process to end, or for until to hold. Then
// ends it. ready says whether core.ready was written
export async function start(options: {
  dir?: string
  executable?: string
  args?: string[]
  env?: Record<string, string>
  ms?: number
  until?: (records: Record<string, unknown>[]) => boolean
} = {}): Promise<Started> {
  const { env, dataDir } = options.env === undefined ? await homeEnv() : { env: options.env, dataDir: stateDir(process.platform, options.env) }
  const executable = options.executable ?? executableIn(options.dir ?? appDir)
  const child = spawn(executable, options.args ?? [], { env, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' })
  let stderr = ''
  child.stderr.on('data', (piece: Buffer) => { stderr += piece.toString('utf8') })
  let code: number | null = null
  let signal: string | null = null
  let exited = false
  child.on('exit', (exitCode, exitSignal) => {
    code = exitCode
    signal = exitSignal
    exited = true
  })
  const done = options.until ?? (all => all.some(record => record.event === 'core.ready'))
  const deadline = Date.now() + (options.ms ?? 30_000)
  let seen: Record<string, unknown>[] = []
  while (!exited && Date.now() < deadline) {
    seen = await records(dataDir)
    if (done(seen)) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  const killed = !exited
  if (killed && child.pid !== undefined) end(child.pid)
  await new Promise(resolve => (exited ? resolve(null) : child.once('exit', resolve)))
  // A moment for the last lines to land
  await new Promise(resolve => setTimeout(resolve, 300))
  seen = await records(dataDir)
  return { code: killed ? null : code, signal: killed ? null : signal, killed, stderr, records: seen, dataDir, ready: seen.some(record => record.event === 'core.ready') }
}
