import { mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { EventLog, type Opened } from '../events/log.ts'
import { defaultState, stateDir, StateStore, type Check, type SecurityState } from './state.ts'

export type BootOptions = {
  packaged: boolean
  installDir: string
  env: Record<string, string | undefined>
  platform: string
}

// gone is boot's own result: switches or agents with no file and no hash although hetu has run here before
export type BootCheck = Omit<Check, 'result'> & { result: Check['result'] | 'gone' }

export type Booted = {
  // What to run with. After a failed check it differs from the files and must never be written back whole
  state: SecurityState
  suspect: boolean
  checks: BootCheck[]
  // The one writer of the state, passed on so no second store races it
  store: StateStore
  log: EventLog
  logHealthy: boolean
  dataDir: string
  dev: boolean
  release: () => Promise<void>
}

// A packaged build ignores HETU_DATA_DIR, so the environment can't move the state somewhere else. An unpackaged run
// gets its own folder, so a dev copy never shares the state of an installed hetu (Han, 2026-11-02)
export function resolveDataDir(options: Omit<BootOptions, 'installDir'>): { dataDir: string, dev: boolean } {
  const { packaged, env, platform } = options
  if (packaged) return { dataDir: stateDir(platform, env), dev: false }
  const override = env.HETU_DATA_DIR
  if (override === undefined) return { dataDir: stateDir(platform, env, 'hetu-dev'), dev: true }
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (!paths.isAbsolute(override)) throw new Error('HETU_DATA_DIR is not an absolute path')
  return { dataDir: override, dev: true }
}

// A piece of first-party code, which loads only from the install
export function firstPartyPath(installDir: string, relative: string, platform: string = process.platform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (relative === '' || paths.isAbsolute(relative)) throw new Error(`not a path inside the install: ${relative}`)
  const resolved = paths.resolve(installDir, relative)
  const inside = paths.relative(installDir, resolved)
  // .. covers an escape and an absolute answer covers another drive, which a drive relative path like C:x can reach
  if (inside === '' || inside === '..' || inside.startsWith(`..${paths.sep}`) || paths.isAbsolute(inside)) {
    throw new Error(`not a path inside the install: ${relative}`)
  }
  return resolved
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM is a process that exists and can't be signalled
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Two hetus on one folder would pair one's file with the other's hash and fork the log. A lock left by a process that
// is gone is taken over. Two starts racing over the same stale lock can both get in, a later single-instance lock
// in #66 covers two copies of the same app
async function lock(dataDir: string): Promise<() => Promise<void>> {
  const file = path.join(dataDir, 'hetu.lock')
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(file, 'wx')
      try {
        await handle.writeFile(String(process.pid))
      } finally {
        await handle.close()
      }
      return async () => {
        // Only its own lock, in case a stale takeover put someone else's there
        if ((await readFile(file, 'utf8').catch(() => '')) === String(process.pid)) await rm(file, { force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw err
      const holder = Number(await readFile(file, 'utf8').catch(() => ''))
      if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) throw new Error(`another hetu (pid ${holder}) is using ${dataDir}`)
      await rm(file, { force: true })
    }
  }
}

// The log may be down, so logging never stops a boot. healthy says whether it all went in
async function record(log: EventLog, event: string, fields: Record<string, string | boolean> = {}): Promise<boolean> {
  try {
    await log.append(event, fields)
    return true
  } catch {
    return false
  }
}

// Holds no policy and starts nothing, it reads and checks the state and says what it found. #66 wires the host in
export async function boot(options: BootOptions): Promise<Booted> {
  const { dataDir, dev } = resolveDataDir(options)
  await mkdir(dataDir, { recursive: true })
  const release = await lock(dataDir)
  try {
    return await checked(dataDir, dev, release)
  } catch (err) {
    await release()
    throw err
  }
}

async function checked(dataDir: string, dev: boolean, release: () => Promise<void>): Promise<Booted> {
  const log = new EventLog(dataDir)
  let opened: Opened | null = null
  try {
    opened = await log.open()
  } catch {
    // Notes stay usable with the log down, logHealthy says so
  }

  const store = new StateStore(dataDir)
  const loaded = await store.load()
  const checks: BootCheck[] = loaded.checks.map(c => ({ ...c }))
  let suspect = loaded.suspect

  // A missing pair is a new install only if nothing says hetu ran here before. A log that couldn't be opened says
  // nothing, so a wipe then reads as a new install
  const ranBefore = (opened !== null && (opened.lastSeq > 0 || opened.broken !== null))
    || checks.some(c => c.result !== 'absent')
  const missing = checks.filter(c => (c.check === 'switches' || c.check === 'agents') && c.result === 'absent')
  if (ranBefore) {
    for (const check of missing) check.result = 'gone'
    if (missing.length > 0) suspect = true
  }

  let healthy = opened !== null
  for (const check of checks) {
    const fields: Record<string, string> = { check: check.check, result: check.result }
    if (check.id !== undefined) fields.id = check.id
    healthy = await record(log, 'boot.check', fields) && healthy
  }
  if (suspect) healthy = await record(log, 'boot.suspect') && healthy

  // Defaults loosen nothing, every guard on and no agents, so they go in without a confirmation. Written so the next
  // boot can tell a wipe from a new install
  const state = loaded.state
  for (const check of missing) {
    const write = check.check === 'switches'
      ? () => store.writeSwitches(defaultState().switches)
      : () => store.writeAgents({})
    try {
      await write()
      healthy = await record(log, 'boot.default-written', { file: check.check }) && healthy
    } catch (err) {
      healthy = await record(log, 'boot.default-failed', { file: check.check, error: (err as NodeJS.ErrnoException).code ?? 'unknown' }) && healthy
    }
  }

  return { state, suspect, checks, store, log, logHealthy: healthy && log.healthy, dataDir, dev, release }
}
