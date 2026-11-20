import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boot, type Booted } from '../backend/boot/boot.ts'
import { defaultSwitches, FORMAT, StateStore } from '../backend/boot/state.ts'

// The state files' format 3 and the reader for format 2, which held the items and revoked labels of agents and is read
// with them dropped, then written back as format 3 once at boot

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const read = { type: 'luoshu.read' as const, paths: ['**'] }
const inbox = { type: 'luoshu.read' as const, paths: ['inbox/**'] }
const entry = (over: object = {}) => ({
  version: '1.0.0', contentHash: 'a'.repeat(64), signer: 'hetu first-party', granted: [read], class: 1, enabled: true, ...over,
})
const notes = { folder: process.platform === 'win32' ? 'C:\\Users\\han\\notes' : '/home/han/notes' }
// What format 2 held for agents: the items and the revoked labels on mcp's entry and the labels held in the switches
const agents = [{ agent: 'client#1', capability: inbox }]
const switches2 = { ...defaultSwitches(), devMode: ['search'], revokedAgents: ['client#4'] }

let dir: string
let running: Booted[] = []
const stateFile = (...parts: string[]) => path.join(dir, 'state', ...parts)
const entryFile = (id: string) => stateFile('plugins', `${id}.json`)

// What a program that knows hetu writes: the body in a format and a hash line that matches it
async function plant(file: string, format: number, body: object) {
  const text = `${JSON.stringify({ format, ...body }, null, 2)}\n`
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${text}${sha256(text)}\n`)
}
// The body of a state file without its hash line, as JSON
const bodyOf = async (file: string) => JSON.parse((await readFile(file, 'utf8')).split('\n').slice(0, -2).join('\n'))

// What an older build left: every file in format 2, mcp's entry holding agents' items and revoked labels
async function format2() {
  await plant(stateFile('switches.json'), 2, switches2)
  await plant(stateFile('luoshu.json'), 2, notes)
  await plant(entryFile('mcp'), 2, entry({ agents, revoked: ['client#3'] }))
  await plant(entryFile('search'), 2, entry({ signer: 'sigstore:someone', off: [read] }))
}

async function started() {
  const booted = await boot({ packaged: false, installDir: path.join(dir, 'install'), env: { HETU_DATA_DIR: dir }, platform: process.platform })
  running.push(booted)
  return booted
}
async function stopped(booted: Booted) {
  await booted.release()
  running = running.filter(one => one !== booted)
}
async function bootRecords() {
  const events = path.join(dir, 'events')
  const all: Record<string, unknown>[] = []
  for (const name of (await readdir(events)).sort()) {
    for (const line of (await readFile(path.join(events, name), 'utf8')).split('\n').filter(Boolean)) {
      const { seq, prev, at, ...rest } = JSON.parse(line)
      if (String(rest.event).startsWith('boot.')) all.push(rest)
    }
  }
  return all
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hetu-format-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const booted of running) await booted.release()
  running = []
  await rm(dir, { recursive: true, force: true })
})

describe('the state files in format 3', () => {
  it('writes each file in format 3', async () => {
    const store = new StateStore(dir)
    expect(FORMAT).toBe(3)
    await store.writeSwitches(defaultSwitches())
    await store.writePlugin('mcp', entry())
    expect((await bodyOf(stateFile('switches.json'))).format).toBe(3)
    expect((await bodyOf(entryFile('mcp'))).format).toBe(3)
  })

  it('takes no agents\' items or revoked labels on any entry and none in the switches', async () => {
    const store = new StateStore(dir)
    for (const id of ['mcp', 'search']) {
      await expect(store.writePlugin(id, entry({ agents }))).rejects.toThrow()
      await expect(store.writePlugin(id, entry({ revoked: ['client#3'] }))).rejects.toThrow()
    }
    await expect(store.writeSwitches({ ...defaultSwitches(), revokedAgents: ['client#4'] })).rejects.toThrow()
    await plant(entryFile('mcp'), 3, entry({ agents }))
    await plant(stateFile('switches.json'), 3, { ...defaultSwitches(), revokedAgents: ['client#4'] })
    const loaded = await store.load()
    expect(loaded.checks).toEqual([
      { check: 'switches', result: 'invalid' }, { check: 'luoshu', result: 'absent' }, { check: 'plugin-entry', id: 'mcp', result: 'invalid' },
    ])
  })
})

describe('the reader for format 2', () => {
  it('reads each file with agents, revoked and revokedAgents dropped and everything else kept', async () => {
    await format2()
    const loaded = await new StateStore(dir).load()
    expect(loaded.checks).toEqual([
      { check: 'switches', result: 'ok' }, { check: 'luoshu', result: 'ok' },
      { check: 'plugin-entry', id: 'mcp', result: 'ok' }, { check: 'plugin-entry', id: 'search', result: 'ok' },
    ])
    expect(loaded.suspect).toBe(false)
    const { revokedAgents, ...kept } = switches2
    expect(loaded.state.switches).toEqual(kept)
    expect(loaded.state.luoshu).toEqual(notes)
    expect(loaded.state.plugins.mcp).toEqual(entry())
    expect(loaded.state.plugins.search).toEqual(entry({ signer: 'sigstore:someone', off: [read] }))
  })

  it('checks the hash of a format 2 file as before, an edited one suspect', async () => {
    await plant(entryFile('mcp'), 2, entry({ agents }))
    const text = await readFile(entryFile('mcp'), 'utf8')
    await writeFile(entryFile('mcp'), text.replace('client#1', 'client#9'))
    const loaded = await new StateStore(dir).load()
    expect(loaded.checks).toContainEqual({ check: 'plugin-entry', id: 'mcp', result: 'hash-mismatch' })
    expect(loaded.suspect).toBe(true)
  })

  it('holds a format 2 file to the fields format 2 had, an unknown one invalid', async () => {
    await plant(entryFile('mcp'), 2, entry({ extra: 1 }))
    await plant(entryFile('search'), 2, entry({ agents: 'all of them' }))
    const loaded = await new StateStore(dir).load()
    expect(loaded.checks).toContainEqual({ check: 'plugin-entry', id: 'mcp', result: 'invalid' })
    expect(loaded.checks).toContainEqual({ check: 'plugin-entry', id: 'search', result: 'invalid' })
  })

  it('reads format 1 as invalid and format 4 as newer', async () => {
    await plant(entryFile('mcp'), 1, entry())
    await plant(entryFile('search'), 4, entry())
    const loaded = await new StateStore(dir).load()
    expect(loaded.checks).toContainEqual({ check: 'plugin-entry', id: 'mcp', result: 'invalid' })
    expect(loaded.checks).toContainEqual({ check: 'plugin-entry', id: 'search', result: 'newer' })
  })
})

describe('a format 2 state at boot', () => {
  it('writes each file back once in format 3 with the dropped fields gone and records it, the next boot writing nothing', async () => {
    await format2()
    const booted = await started()
    expect(booted.suspect).toBe(false)
    expect(booted.state.plugins.mcp).toEqual(entry())
    for (const file of [stateFile('switches.json'), stateFile('luoshu.json'), entryFile('mcp'), entryFile('search')]) {
      expect((await bodyOf(file)).format).toBe(3)
    }
    expect(await bodyOf(entryFile('mcp'))).toEqual({ format: 3, ...entry() })
    expect(Object.keys(await bodyOf(stateFile('switches.json')))).not.toContain('revokedAgents')
    expect((await bootRecords()).filter(record => record.event === 'boot.upgraded')).toEqual([
      { event: 'boot.upgraded', file: 'switches' }, { event: 'boot.upgraded', file: 'luoshu' },
      { event: 'boot.upgraded', file: 'plugin-entry', id: 'mcp' }, { event: 'boot.upgraded', file: 'plugin-entry', id: 'search' },
    ])
    await stopped(booted)
    const before = await readFile(entryFile('mcp'))
    const again = await started()
    expect(again.checks.every(check => check.result === 'ok')).toBe(true)
    expect((await bootRecords()).filter(record => record.event === 'boot.upgraded')).toHaveLength(4)
    expect(await readFile(entryFile('mcp'))).toEqual(before)
  })

  it('writes back no format 2 file that failed its check', async () => {
    await plant(entryFile('mcp'), 2, entry({ agents }))
    const text = (await readFile(entryFile('mcp'), 'utf8')).replace('client#1', 'client#9')
    await writeFile(entryFile('mcp'), text)
    await started()
    expect(await readFile(entryFile('mcp'), 'utf8')).toBe(text)
    expect((await bootRecords()).filter(record => record.event === 'boot.upgraded')).toEqual([])
  })

  it('leaves a file whose write back failed in format 2, recorded, read the same way at the next start', async () => {
    await plant(entryFile('mcp'), 2, entry({ agents }))
    vi.spyOn(StateStore.prototype, 'writePlugin').mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'EACCES' }))
    const booted = await started()
    expect(booted.state.plugins.mcp).toEqual(entry())
    expect((await bodyOf(entryFile('mcp'))).format).toBe(2)
    expect(await bootRecords()).toContainEqual({ event: 'boot.upgrade-failed', file: 'plugin-entry', id: 'mcp', error: 'EACCES' })
    await stopped(booted)
    vi.restoreAllMocks()
    expect((await started()).state.plugins.mcp).toEqual(entry())
    expect((await bodyOf(entryFile('mcp'))).format).toBe(3)
  })
})
