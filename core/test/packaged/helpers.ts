import { spawn, spawnSync } from 'node:child_process'
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stateDir } from '../../backend/boot/state.ts'
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

// A copy of the packed folder made of hard links, so a test changes the files it names and costs no copy of the rest.
// The files named are copied for real, since writing through a link would change the original. A file Linux won't
// hard-link for another user, such as chrome-sandbox once it is root's with the setuid bit, is linked by name instead,
// since a real copy would lose both and a locked build can't start without the sandbox
export async function linkedCopy(real: readonly string[] = []): Promise<string> {
  const to = path.join(await temp(), 'app')
  const walk = async (from: string, into: string) => {
    await mkdir(into, { recursive: true })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name)
      const target = path.join(into, entry.name)
      if (entry.isDirectory()) await walk(source, target)
      else if (real.includes(path.relative(appDir, source).split(path.sep).join('/'))) await copyFile(source, target)
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

export type Started = { code: number | null, stderr: string, records: Record<string, unknown>[], dataDir: string, ready: boolean }

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
  let exited = false
  child.on('exit', exitCode => {
    code = exitCode
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
  return { code: killed ? null : code, stderr, records: seen, dataDir, ready: seen.some(record => record.event === 'core.ready') }
}
