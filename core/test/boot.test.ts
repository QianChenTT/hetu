import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir, uptime } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boot, firstPartyPath, resolveDataDir, type BootOptions, type Booted } from '../backend/boot/boot.ts'
import { contentHash, stateDir, StateStore } from '../backend/boot/state.ts'
import { EventLog } from '../lib/event-log.ts'
import { HOLD_TIMEOUT, holdOpen, onWindows, release, releaseAfter, releaseAll } from './hold.ts'

let base: string
let running: Booted[] = []

// Points the platform's own state location at the temp folder, so stateDir finds it there
function envFor(root: string, extra: Record<string, string> = {}): Record<string, string> {
  if (process.platform === 'win32') return { LOCALAPPDATA: root, ...extra }
  if (process.platform === 'darwin') return { HOME: root, ...extra }
  return { HOME: root, XDG_STATE_HOME: root, ...extra }
}
const installed = (extra: Record<string, string> = {}): BootOptions =>
  ({ packaged: true, installDir: path.join(base, 'install'), env: envFor(base, extra), platform: process.platform })
const dataDir = () => resolveDataDir(installed()).dataDir
const stateFile = (...parts: string[]) => path.join(dataDir(), 'state', ...parts)

async function started(options: BootOptions = installed()) {
  const booted = await boot(options)
  running.push(booted)
  return booted
}

async function stopped(booted: Booted) {
  await booted.release()
  running = running.filter(b => b !== booted)
}

// Every record across the segments, in order
async function records(dir = dataDir()) {
  const events = path.join(dir, 'events')
  const names = (await readdir(events)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  const all: Record<string, unknown>[] = []
  for (const name of names) {
    const text = await readFile(path.join(events, name), 'utf8')
    for (const line of text.split('\n').filter(Boolean)) all.push(JSON.parse(line))
  }
  return all
}
const bootRecords = async (dir?: string) =>
  (await records(dir)).filter(r => String(r.event).startsWith('boot.')).map(({ seq, prev, at, ...rest }) => rest)

// A plugin with its code and a matching entry, written through the store boot handed back
async function addSearch(booted: Booted) {
  const root = path.join(dataDir(), 'plugins', 'search')
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'main.js'), 'export {}')
  await booted.store.writePlugin('search', {
    version: '1.0.0', contentHash: await contentHash(root), signer: 'x', granted: [], class: 1, enabled: true,
  })
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'hetu-boot-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await releaseAll()
  for (const booted of running) await booted.release()
  running = []
  await rm(base, { recursive: true, force: true })
})

describe('first run', () => {
  it('finds nothing, writes the default switches and is not suspect', async () => {
    const booted = await started()
    expect(booted.checks).toEqual([{ check: 'switches', result: 'absent' }])
    expect(booted.suspect).toBe(false)
    expect(booted.logHealthy).toBe(true)
    expect(booted.dev).toBe(false)
    expect(await readdir(stateFile())).toEqual(['switches.json'])
    expect(booted.state.switches).toEqual({ guardsOff: [], devMode: false, skipVerification: false, allowUnsigned: [] })
  })

  it('logs each check without an id where the check has none, then what it wrote', async () => {
    await started()
    expect(await bootRecords()).toEqual([
      { event: 'boot.check', check: 'switches', result: 'absent' },
      { event: 'boot.default-written', file: 'switches' },
    ])
  })

  it('goes on with the defaults and logs it when a default can not be written', async () => {
    vi.spyOn(StateStore.prototype, 'writeSwitches').mockRejectedValue(Object.assign(new Error('no'), { code: 'EACCES' }))
    const booted = await started()
    expect(booted.state.switches.guardsOff).toEqual([])
    expect(await bootRecords()).toContainEqual({ event: 'boot.default-failed', file: 'switches', error: 'EACCES' })
    expect(await bootRecords()).not.toContainEqual({ event: 'boot.default-written', file: 'switches' })
  })
})

describe('a later run', () => {
  it('finds everything ok, is not suspect and writes nothing', async () => {
    await stopped(await started())
    const before = await readFile(stateFile('switches.json'))
    const booted = await started()
    expect(booted.checks).toEqual([{ check: 'switches', result: 'ok' }])
    expect(booted.suspect).toBe(false)
    expect(await readFile(stateFile('switches.json'))).toEqual(before)
    expect((await bootRecords()).slice(2)).toEqual([
      { event: 'boot.check', check: 'switches', result: 'ok' },
    ])
  })

  it('hands back the store it loaded with, so later writes go through the one writer', async () => {
    const load = vi.spyOn(StateStore.prototype, 'load')
    const booted = await started()
    expect(load.mock.contexts[0]).toBe(booted.store)
    await booted.store.writeSwitches({ guardsOff: ['leases'], devMode: false, skipVerification: false, allowUnsigned: [] })
    await stopped(booted)
    expect((await started()).state.switches.guardsOff).toEqual(['leases'])
  })

  it('says the log is not healthy when one record was lost, even though the log healed after it', async () => {
    const append = vi.spyOn(EventLog.prototype, 'append').mockRejectedValueOnce(new Error('lost'))
    const booted = await started()
    expect(append).toHaveBeenCalled()
    expect(booted.log.healthy).toBe(true)
    expect(booted.logHealthy).toBe(false)
  })

  it('writes the defaults before it logs anything, so a crash between the two reads as a second run', async () => {
    const order: string[] = []
    const switches = StateStore.prototype.writeSwitches
    vi.spyOn(StateStore.prototype, 'writeSwitches').mockImplementation(function (this: StateStore, input) {
      order.push('write')
      return switches.call(this, input)
    })
    const append = EventLog.prototype.append
    vi.spyOn(EventLog.prototype, 'append').mockImplementation(function (this: EventLog, event, fields) {
      order.push('log')
      return append.call(this, event, fields)
    })
    await started()
    expect(order.indexOf('write')).toBeLessThan(order.indexOf('log'))
  })

  it('logs a tampered plugin entry with its id and says the boot is suspect', async () => {
    const first = await started()
    await addSearch(first)
    await stopped(first)
    const entry = stateFile('plugins', 'search.json')
    await writeFile(entry, (await readFile(entry, 'utf8')).replace('"enabled": true', '"enabled": false'))

    const booted = await started()
    expect(booted.suspect).toBe(true)
    expect(booted.state.plugins.search).toBeUndefined()
    const later = (await bootRecords()).slice(2)
    expect(later).toContainEqual({ event: 'boot.check', check: 'plugin-entry', id: 'search', result: 'hash-mismatch' })
    expect(later.at(-1)).toEqual({ event: 'boot.suspect' })
  })
})

// Threat 55: the cheap signal that the state was wiped while hetu has run here before
describe('a wiped state', () => {
  it('reads the switches gone when the log already held records, and writes the default again', async () => {
    await stopped(await started())
    await rm(stateFile(), { recursive: true })
    const booted = await started()
    expect(booted.checks).toEqual([{ check: 'switches', result: 'gone' }])
    expect(booted.suspect).toBe(true)
    expect((await bootRecords()).slice(2)).toEqual([
      { event: 'boot.check', check: 'switches', result: 'gone' },
      { event: 'boot.suspect' },
      { event: 'boot.default-written', file: 'switches' },
    ])
    await stopped(booted)
    expect((await started()).suspect).toBe(false)
  })

  it('reads a wipe as gone when the log was damaged too, a break still means records were there', async () => {
    await stopped(await started())
    await rm(stateFile(), { recursive: true })
    await writeFile(path.join(dataDir(), 'events', 'events-1.jsonl'), 'garbage\n')
    expect((await started()).checks.map(c => c.result)).toEqual(['gone'])
  })

  it('reads the switches gone when the log was wiped but a plugin entry is still there', async () => {
    const first = await started()
    await addSearch(first)
    await stopped(first)
    await rm(path.join(dataDir(), 'events'), { recursive: true })
    await rm(stateFile('switches.json'))
    const booted = await started()
    expect(booted.checks).toEqual([
      { check: 'switches', result: 'gone' },
      { check: 'plugin-entry', id: 'search', result: 'ok' },
      { check: 'plugin-files', id: 'search', result: 'ok' },
    ])
    expect(booted.suspect).toBe(true)
  })

  it('reads the switches gone when the log was wiped and a plugin entry is there but tampered', async () => {
    const first = await started()
    await addSearch(first)
    await stopped(first)
    await rm(path.join(dataDir(), 'events'), { recursive: true })
    await rm(stateFile('switches.json'))
    await writeFile(stateFile('plugins', 'search.json'), '{}')
    const booted = await started()
    expect(booted.checks).toEqual([{ check: 'switches', result: 'gone' }, { check: 'plugin-entry', id: 'search', result: 'hash-missing' }])
  })

  // Accepted: with the log wiped too or unreadable nothing is left to tell, threat 55
  it('reads a wipe of the state and the log as a new install', async () => {
    await stopped(await started())
    await rm(stateFile(), { recursive: true })
    await rm(path.join(dataDir(), 'events'), { recursive: true })
    const booted = await started()
    expect(booted.checks.map(c => c.result)).toEqual(['absent'])
    expect(booted.suspect).toBe(false)
  })
})

describe('the data folder', () => {
  it('ignores HETU_DATA_DIR in a packaged build', async () => {
    const elsewhere = path.join(base, 'elsewhere')
    const booted = await started(installed({ HETU_DATA_DIR: elsewhere }))
    expect(booted.dataDir).toBe(dataDir())
    expect(booted.dev).toBe(false)
    await expect(readdir(elsewhere)).rejects.toThrow()
  })

  it('honours HETU_DATA_DIR in an unpackaged run, which is dev', async () => {
    const elsewhere = path.join(base, 'elsewhere')
    const booted = await started({ ...installed({ HETU_DATA_DIR: elsewhere }), packaged: false })
    expect(booted.dataDir).toBe(elsewhere)
    expect(booted.dev).toBe(true)
    expect(await readdir(path.join(elsewhere, 'state'))).toContain('switches.json')
  })

  it('gives an unpackaged run its own hetu-dev folder beside the real one', async () => {
    const booted = await started({ ...installed(), packaged: false })
    expect(booted.dataDir).toBe(path.join(path.dirname(dataDir()), 'hetu-dev'))
    expect(booted.dev).toBe(true)
    await expect(readdir(dataDir())).rejects.toThrow()
  })

  // Relative to the working folder but inside the temp folder, so a regression can't leave a data folder in the repo.
  // Skipped when the two are on different drives, where no relative path reaches it
  const relativeIntoBase = () => path.relative(process.cwd(), path.join(base, 'relative'))
  it('refuses a HETU_DATA_DIR that is not absolute', async ({ skip }) => {
    if (path.isAbsolute(relativeIntoBase())) skip()
    await expect(boot({ ...installed({ HETU_DATA_DIR: relativeIntoBase() }), packaged: false })).rejects.toThrow(/absolute/)
  })

  it('names the dev folder hetu-dev on every platform', () => {
    expect(stateDir('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'hetu-dev')).toBe('C:\\Users\\a\\AppData\\Local\\hetu-dev')
    expect(stateDir('darwin', { HOME: '/Users/a' }, 'hetu-dev')).toBe('/Users/a/Library/Application Support/hetu-dev')
    expect(stateDir('linux', { HOME: '/home/a' }, 'hetu-dev')).toBe('/home/a/.local/state/hetu-dev')
    expect(stateDir('linux', { HOME: '/home/a', XDG_STATE_HOME: '/s' }, 'hetu-dev')).toBe('/s/hetu-dev')
  })
})

describe('a log that can not be used', () => {
  it('still boots, loads the state and says the log is not healthy', async () => {
    await mkdir(dataDir(), { recursive: true })
    await writeFile(path.join(dataDir(), 'events'), 'in the way')
    const booted = await started()
    expect(booted.logHealthy).toBe(false)
    expect(booted.checks.map(c => c.result)).toEqual(['absent'])
    expect(await readdir(stateFile())).toContain('switches.json')
  })
})

describe('one hetu per folder', () => {
  it('refuses a second boot on a folder another boot holds, and takes it once released', async () => {
    const first = await started()
    await expect(boot(installed())).rejects.toThrow(/this process \(pid \d+\) is using .*remove .*hetu\.lock/)
    await stopped(first)
    await started()
  })

  it('takes over a lock left by a process that is gone', async () => {
    const child = spawn(process.execPath, ['-e', ''])
    await new Promise(resolve => child.on('exit', resolve))
    await mkdir(dataDir(), { recursive: true })
    await writeFile(path.join(dataDir(), 'hetu.lock'), String(child.pid))
    await started()
    expect(await readFile(path.join(dataDir(), 'hetu.lock'), 'utf8')).toBe(String(process.pid))
  })

  const lockFile = () => path.join(dataDir(), 'hetu.lock')
  async function leaveLock(text: string, agoMs = 0) {
    await mkdir(dataDir(), { recursive: true })
    await writeFile(lockFile(), text)
    const when = new Date(Date.now() - agoMs)
    await utimes(lockFile(), when, when)
  }

  // pid 4 is System on Windows and pid 1 is init elsewhere, both alive and both refuse a signal from this process
  it('refuses a lock whose pid is alive even when it can not be signalled', async () => {
    await leaveLock(process.platform === 'win32' ? '4' : '1')
    await expect(boot(installed())).rejects.toThrow(/another hetu \(pid (4|1)\)/)
  })

  // After a reboot Windows hands old pids to any program, the lock's pid then names someone else
  it('takes over a lock written before the machine last started, whatever its pid', async () => {
    await leaveLock(String(process.ppid), (uptime() + 60) * 1000)
    await started()
    expect(await readFile(lockFile(), 'utf8')).toBe(String(process.pid))
  })

  it('takes over a lock naming this pid when this process holds no lock there', async () => {
    await leaveLock(String(process.pid))
    await started()
  })

  it('stops counting a lock as its own once it has released it', async () => {
    await stopped(await started())
    await leaveLock(String(process.pid))
    await started()
  })

  // Written after the machine started, so only the pid decides. Half the uptime in milliseconds, which reads as before
  // the start if uptime were taken as milliseconds instead of seconds
  it('refuses a live lock written after the machine started, however long ago', async () => {
    await leaveLock(process.platform === 'win32' ? '4' : '1', Math.min(uptime() * 500, 3_600_000))
    await expect(boot(installed())).rejects.toThrow(/another hetu/)
  })

  it('takes over an empty lock once it is past the few seconds a start needs to write its pid', async () => {
    await leaveLock('', 10_000)
    await started()
  })

  it.runIf(onWindows)('waits out a reader holding a stale lock it takes over', async () => {
    await leaveLock('garbage', 60_000)
    const reader = await holdOpen(lockFile(), 'Read')
    const [booted] = await Promise.all([started(), releaseAfter(reader, 300)])
    expect(await readFile(lockFile(), 'utf8')).toBe(String(process.pid))
    await stopped(booted)
  }, HOLD_TIMEOUT)

  it.runIf(onWindows)('waits out a program holding its lock with no sharing when it releases it', async () => {
    const booted = await started()
    const reader = await holdOpen(lockFile(), 'None')
    await Promise.all([stopped(booted), releaseAfter(reader, 300)])
    expect(await readdir(dataDir())).not.toContain('hetu.lock')
  }, HOLD_TIMEOUT)

  it('refuses an empty lock a start may still be writing', async () => {
    await leaveLock('')
    await expect(boot(installed())).rejects.toThrow(/a hetu that is starting/)
  })

  it.each([['empty', ''], ['not a pid', 'garbage'], ['zero', '0'], ['negative', '-5']])('takes over a lock that is %s and old', async (_name, text) => {
    await leaveLock(text, 60_000)
    await started()
  })

  it.runIf(onWindows)('refuses a lock it can not read, since it may well be held', async () => {
    await leaveLock(String(process.ppid))
    const holder = await holdOpen(lockFile(), 'None')
    try {
      await expect(boot(installed())).rejects.toThrow(/can't read .*hetu\.lock/)
    } finally {
      await release(holder)
    }
  }, 15_000)

  it('lets go of its lock when the checks throw', async () => {
    vi.spyOn(StateStore.prototype, 'load').mockRejectedValueOnce(new Error('broken'))
    await expect(boot(installed())).rejects.toThrow('broken')
    expect(await readdir(dataDir())).not.toContain('hetu.lock')
    await started()
  })

  it('releases once, so a second call can not remove a lock taken after it', async () => {
    const first = await started()
    await stopped(first)
    await started()
    await first.release()
    expect(await readFile(lockFile(), 'utf8')).toBe(String(process.pid))
  })

  it('removes its own lock on release and leaves one that is not its own', async () => {
    const booted = await started()
    await stopped(booted)
    expect(await readdir(dataDir())).not.toContain('hetu.lock')
    const again = await started()
    await writeFile(path.join(dataDir(), 'hetu.lock'), '1')
    await again.release()
    expect(await readFile(path.join(dataDir(), 'hetu.lock'), 'utf8')).toBe('1')
  })
})

describe('firstPartyPath', () => {
  const cases: [string, string, string, string | null][] = [
    ['posix', '/opt/hetu', 'core/host.js', '/opt/hetu/core/host.js'],
    ['posix', '/opt/hetu', 'core/../editor/main.js', '/opt/hetu/editor/main.js'],
    ['posix', '/opt/hetu', '../evil.js', null],
    ['posix', '/opt/hetu', 'core/../../evil.js', null],
    ['posix', '/opt/hetu', '/etc/passwd', null],
    ['posix', '/opt/hetu', '/opt/hetu/core/host.js', null],
    ['posix', '/opt/hetu', '', null],
    ['posix', '/opt/hetu', '.', null],
    ['posix', '/opt/hetu', '..', null],
    ['posix', '/opt/hetu', '..evil/x.js', '/opt/hetu/..evil/x.js'],
    ['win32', 'C:\\Program Files\\hetu', 'core\\host.js', 'C:\\Program Files\\hetu\\core\\host.js'],
    ['win32', 'C:\\Program Files\\hetu', 'core/host.js', 'C:\\Program Files\\hetu\\core\\host.js'],
    ['win32', 'C:\\Program Files\\hetu', '..\\evil.js', null],
    ['win32', 'C:\\Program Files\\hetu', 'core\\..\\..\\evil.js', null],
    ['win32', 'C:\\Program Files\\hetu', 'C:\\Windows\\evil.js', null],
    ['win32', 'C:\\Program Files\\hetu', 'C:\\Program Files\\hetu\\core\\host.js', null],
    ['win32', 'C:\\Program Files\\hetu', 'D:evil.js', null],
    ['win32', 'C:\\Program Files\\hetu', '\\\\server\\share\\evil.js', null],
    ['win32', 'C:\\Program Files\\hetu', '\\evil.js', null],
  ]
  it.each(cases)('on %s in %s, %j gives %j', (platform, installDir, relative, expected) => {
    if (expected === null) expect(() => firstPartyPath(installDir, relative, platform)).toThrow(/inside the install/)
    else expect(firstPartyPath(installDir, relative, platform)).toBe(expected)
  })
})
