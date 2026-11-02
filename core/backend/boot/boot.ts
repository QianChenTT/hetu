import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { uptime } from 'node:os'
import path from 'node:path'
import { retried } from '../disk.ts'
import { EventLog, type Opened } from '../events/log.ts'
import { defaultState, stateDir, StateStore, type Check, type SecurityState } from './state.ts'

export type BootOptions = {
  packaged: boolean
  installDir: string
  env: Record<string, string | undefined>
  platform: string
}

// gone is boot's own result: switches or agents with no file although hetu has run here before
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

// The locks this process holds, so a lock naming this pid can be told apart from one an earlier run left
const held = new Set<string>()
// An empty lock this young may be a start that hasn't written its pid yet
const YOUNG_MS = 5000

// Who holds the lock, or null when it was left by a run that is gone. A pid is only a name: after a reboot Windows hands
// old pids to any program, so a lock from before this boot of the machine is stale whatever its pid. Reuse within one
// uptime still reads as live, #66's single-instance lock closes that for the installed app
async function holderOf(file: string): Promise<string | null> {
  let text: string
  let written: number
  try {
    written = (await retried(() => stat(file), file, 'read')).mtimeMs
    text = await retried(() => readFile(file, 'utf8'), file, 'read')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    // Fails closed, a lock that can't be read may well be held
    throw new Error(`can't read ${file}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
  }
  if (written < Date.now() - uptime() * 1000) return null
  if (text.trim() === '') return Date.now() - written < YOUNG_MS ? 'a hetu that is starting' : null
  const pid = Number(text)
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (pid === process.pid) return held.has(file) ? `this process (pid ${pid})` : null
  return alive(pid) ? `another hetu (pid ${pid})` : null
}

// Two hetus on one folder would write over each other's state and fork the log. A lock left by a run that is
// gone is taken over. Two starts racing over the same stale lock can both get in, a later single-instance lock in #66
// covers two copies of the same app
async function lock(dataDir: string): Promise<() => Promise<void>> {
  const file = path.join(dataDir, 'hetu.lock')
  for (let attempt = 0; ; attempt++) {
    let handle
    try {
      handle = await open(file, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw err
      const holder = await holderOf(file)
      if (holder !== null) throw new Error(`${holder} is using ${dataDir}. If no hetu is running, remove ${file}`)
      await retried(() => rm(file, { force: true }), file)
      continue
    }
    try {
      await handle.writeFile(String(process.pid))
    } catch (err) {
      await handle.close().catch(() => {})
      await rm(file, { force: true }).catch(() => {})
      throw err
    }
    await handle.close()
    held.add(file)
    let released = false
    return async () => {
      // Once only, and only its own lock, in case a takeover put someone else's there
      if (released) return
      released = true
      held.delete(file)
      let text: string
      try {
        text = await retried(() => readFile(file, 'utf8'), file, 'read')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
      if (text === String(process.pid)) await retried(() => rm(file, { force: true }), file)
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

  // A missing switches or agents file is a new install only if nothing says hetu ran here before. A log that couldn't
  // be opened says nothing, so a wipe then reads as a new install
  const ranBefore = (opened !== null && (opened.lastSeq > 0 || opened.broken !== null))
    || checks.some(c => c.result !== 'absent')
  const missing = checks.filter(c => (c.check === 'switches' || c.check === 'agents') && c.result === 'absent')
  if (ranBefore) {
    for (const check of missing) check.result = 'gone'
    if (missing.length > 0) suspect = true
  }

  // Defaults loosen nothing, every guard on and no agents, so they go in without a confirmation. Written so the next
  // boot can tell a wipe from a new install, and before anything is logged, so a crash in between can't leave records
  // that make the next boot read a new install as a wipe. A write that fails still does, once, accepted
  const state = loaded.state
  const written: { file: string, error?: string }[] = []
  for (const check of missing) {
    const write = check.check === 'switches'
      ? () => store.writeSwitches(defaultState().switches)
      : () => store.writeAgents({})
    try {
      await write()
      written.push({ file: check.check })
    } catch (err) {
      written.push({ file: check.check, error: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }

  let healthy = opened !== null
  for (const check of checks) {
    const fields: Record<string, string> = { check: check.check, result: check.result }
    if (check.id !== undefined) fields.id = check.id
    healthy = await record(log, 'boot.check', fields) && healthy
  }
  if (suspect) healthy = await record(log, 'boot.suspect') && healthy
  for (const { file, error } of written) {
    healthy = await (error === undefined
      ? record(log, 'boot.default-written', { file })
      : record(log, 'boot.default-failed', { file, error })) && healthy
  }

  return { state, suspect, checks, store, log, logHealthy: healthy && log.healthy, dataDir, dev, release }
}
