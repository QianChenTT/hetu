import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boot, firstPartyPath, resolveDataDir, type BootOptions, type Booted } from '../backend/boot/boot.ts'
import { contentHash, StateStore } from '../backend/boot/state.ts'

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

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'hetu-boot-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const booted of running) await booted.release()
  running = []
  await rm(base, { recursive: true, force: true })
})

describe('first run', () => {
  it('finds nothing, writes the default switches and agents and is not suspect', async () => {
    const booted = await started()
    expect(booted.checks).toEqual([{ check: 'switches', result: 'absent' }, { check: 'agents', result: 'absent' }])
    expect(booted.suspect).toBe(false)
    expect(booted.logHealthy).toBe(true)
    expect(booted.dev).toBe(false)
    expect((await readdir(stateFile())).sort()).toEqual(['agents.json', 'agents.json.sha256', 'switches.json', 'switches.json.sha256'])
    expect(booted.state.switches).toEqual({ guardsOff: [], devMode: false, skipVerification: false, allowUnsigned: [] })
    expect(Object.keys(booted.state.agents)).toEqual([])
  })

  it('logs each check without an id where the check has none, then what it wrote', async () => {
    await started()
    expect(await bootRecords()).toEqual([
      { event: 'boot.check', check: 'switches', result: 'absent' },
      { event: 'boot.check', check: 'agents', result: 'absent' },
      { event: 'boot.default-written', file: 'switches' },
      { event: 'boot.default-written', file: 'agents' },
    ])
  })

  it('goes on with the defaults and logs it when a default can not be written', async () => {
    vi.spyOn(StateStore.prototype, 'writeSwitches').mockRejectedValue(Object.assign(new Error('no'), { code: 'EACCES' }))
    const booted = await started()
    expect(booted.state.switches.guardsOff).toEqual([])
    expect(await bootRecords()).toContainEqual({ event: 'boot.default-failed', file: 'switches', error: 'EACCES' })
    expect(await bootRecords()).toContainEqual({ event: 'boot.default-written', file: 'agents' })
  })
})

describe('a later run', () => {
  it('finds everything ok, is not suspect and writes nothing', async () => {
    await stopped(await started())
    const before = await readFile(stateFile('switches.json'))
    const booted = await started()
    expect(booted.checks).toEqual([{ check: 'switches', result: 'ok' }, { check: 'agents', result: 'ok' }])
    expect(booted.suspect).toBe(false)
    expect(await readFile(stateFile('switches.json'))).toEqual(before)
    expect((await bootRecords()).slice(4)).toEqual([
      { event: 'boot.check', check: 'switches', result: 'ok' },
      { event: 'boot.check', check: 'agents', result: 'ok' },
    ])
  })

  it('hands back the store it loaded with, so later writes go through the one writer', async () => {
    const booted = await started()
    await booted.store.writeSwitches({ guardsOff: ['leases'], devMode: false, skipVerification: false, allowUnsigned: [] })
    await stopped(booted)
    expect((await started()).state.switches.guardsOff).toEqual(['leases'])
  })

  it('logs a tampered plugin entry with its id and says the boot is suspect', async () => {
    const first = await started()
    const root = path.join(dataDir(), 'plugins', 'search')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'main.js'), 'export {}')
    await first.store.writePlugin('search', {
      version: '1.0.0', contentHash: await contentHash(root), signer: 'x', granted: [], class: 1, enabled: true,
    })
    await stopped(first)
    const entry = stateFile('plugins', 'search.json')
    await writeFile(entry, (await readFile(entry, 'utf8')).replace('"enabled": true', '"enabled": false'))

    const booted = await started()
    expect(booted.suspect).toBe(true)
    expect(booted.state.plugins.search).toBeUndefined()
    const later = (await bootRecords()).slice(4)
    expect(later).toContainEqual({ event: 'boot.check', check: 'plugin-entry', id: 'search', result: 'hash-mismatch' })
    expect(later.at(-1)).toEqual({ event: 'boot.suspect' })
  })
})

// Threat 55: the cheap signal that the state was wiped while hetu has run here before
describe('a wiped state', () => {
  it('reads both files gone when the log already held records, and writes the defaults again', async () => {
    await stopped(await started())
    await rm(stateFile(), { recursive: true })
    const booted = await started()
    expect(booted.checks).toEqual([{ check: 'switches', result: 'gone' }, { check: 'agents', result: 'gone' }])
    expect(booted.suspect).toBe(true)
    expect((await bootRecords()).slice(4)).toEqual([
      { event: 'boot.check', check: 'switches', result: 'gone' },
      { event: 'boot.check', check: 'agents', result: 'gone' },
      { event: 'boot.suspect' },
      { event: 'boot.default-written', file: 'switches' },
      { event: 'boot.default-written', file: 'agents' },
    ])
    await stopped(booted)
    expect((await started()).suspect).toBe(false)
  })

  it('reads one file gone when only its pair was deleted', async () => {
    await stopped(await started())
    await rm(stateFile('agents.json'))
    await rm(stateFile('agents.json.sha256'))
    const booted = await started()
    expect(booted.checks).toEqual([{ check: 'switches', result: 'ok' }, { check: 'agents', result: 'gone' }])
    expect(booted.suspect).toBe(true)
  })

  it('reads a wipe as gone when the log was damaged too, a break still means records were there', async () => {
    await stopped(await started())
    await rm(stateFile(), { recursive: true })
    await writeFile(path.join(dataDir(), 'events', 'events-1.jsonl'), 'garbage\n')
    expect((await started()).checks.map(c => c.result)).toEqual(['gone', 'gone'])
  })

  it('reads a pair gone when the log was wiped but the other file is still there', async () => {
    await stopped(await started())
    await rm(path.join(dataDir(), 'events'), { recursive: true })
    await rm(stateFile('switches.json'))
    await rm(stateFile('switches.json.sha256'))
    const booted = await started()
    expect(booted.checks).toEqual([{ check: 'switches', result: 'gone' }, { check: 'agents', result: 'ok' }])
    expect(booted.suspect).toBe(true)
  })

  // Accepted: with the log wiped too or unreadable nothing is left to tell, row 55
  it('reads a wipe of the state and the log as a new install', async () => {
    await stopped(await started())
    await rm(stateFile(), { recursive: true })
    await rm(path.join(dataDir(), 'events'), { recursive: true })
    const booted = await started()
    expect(booted.checks.map(c => c.result)).toEqual(['absent', 'absent'])
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

  it('refuses a HETU_DATA_DIR that is not absolute', async () => {
    await expect(boot({ ...installed({ HETU_DATA_DIR: 'state-here' }), packaged: false })).rejects.toThrow(/absolute/)
  })
})

describe('a log that can not be used', () => {
  it('still boots, loads the state and says the log is not healthy', async () => {
    await mkdir(dataDir(), { recursive: true })
    await writeFile(path.join(dataDir(), 'events'), 'in the way')
    const booted = await started()
    expect(booted.logHealthy).toBe(false)
    expect(booted.checks.map(c => c.result)).toEqual(['absent', 'absent'])
    expect(await readdir(stateFile())).toContain('switches.json')
  })
})

describe('one hetu per folder', () => {
  it('refuses a second boot on a folder another boot holds, and takes it once released', async () => {
    const first = await started()
    await expect(boot(installed())).rejects.toThrow(/another hetu/)
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
    ['posix', '/opt/hetu', '', null],
    ['posix', '/opt/hetu', '.', null],
    ['posix', '/opt/hetu', '..', null],
    ['posix', '/opt/hetu', '..evil/x.js', '/opt/hetu/..evil/x.js'],
    ['win32', 'C:\\Program Files\\hetu', 'core\\host.js', 'C:\\Program Files\\hetu\\core\\host.js'],
    ['win32', 'C:\\Program Files\\hetu', 'core/host.js', 'C:\\Program Files\\hetu\\core\\host.js'],
    ['win32', 'C:\\Program Files\\hetu', '..\\evil.js', null],
    ['win32', 'C:\\Program Files\\hetu', 'core\\..\\..\\evil.js', null],
    ['win32', 'C:\\Program Files\\hetu', 'C:\\Windows\\evil.js', null],
    ['win32', 'C:\\Program Files\\hetu', 'D:evil.js', null],
    ['win32', 'C:\\Program Files\\hetu', '\\\\server\\share\\evil.js', null],
    ['win32', 'C:\\Program Files\\hetu', '\\evil.js', null],
  ]
  it.each(cases)('on %s in %s, %j gives %j', (platform, installDir, relative, expected) => {
    if (expected === null) expect(() => firstPartyPath(installDir, relative, platform)).toThrow(/inside the install/)
    else expect(firstPartyPath(installDir, relative, platform)).toBe(expected)
  })
})
