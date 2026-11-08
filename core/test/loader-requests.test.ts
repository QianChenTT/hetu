import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import { StateStore } from '../backend/boot/state.ts'
import {
  allowAll, cleanup, coreInstall, entryFor, filesFor, harness, hostManifest, reasonOf, stateOf, workerManifest, type Files,
} from './loader-fakes.ts'

afterEach(cleanup)

const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const worker = (id: string, extra: object = {}): Files => filesFor(workerManifest(id, extra))
const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const panel: Capability = { type: 'ui.panel' }
const notes: Capability = { type: 'luoshu.read', paths: ['notes/**'] }
const stateIn = async (dataDir: string) => (await new StateStore(dataDir).load()).state
const held = (answer: { applied: true } | { held: string }) => {
  if (!('held' in answer)) throw new Error('applied, not held')
  return answer.held
}
const code = (work: Promise<unknown>) => work.then(() => 'none', (err: { code?: string }) => err.code ?? String(err))

describe('a security request', () => {
  it('applies a narrowing change at once with its record', async () => {
    const made = await harness({ switches: { confirmOff: true } })
    await made.loader.start()
    expect(await made.loader.request({ kind: 'confirmOff', on: false }, editor)).toEqual({ applied: true })
    expect((await stateIn(made.dataDir)).switches.confirmOff).toBe(false)
    expect(made.link.events('security.applied')).toMatchObject([{ kind: 'confirmOff', window: 'editor', by: 'narrows' }])
    expect(made.loader.pending()).toEqual([])
  })

  it('holds a widening change for the Confirm and applies nothing', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    expect(made.loader.pending()).toEqual([{ id, kind: 'skipVerification', plugin: null }])
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
    expect(made.link.events('security.request')).toMatchObject([{ kind: 'skipVerification', window: 'editor' }])
    expect(made.link.events('security.applied')).toEqual([])
  })

  it('holds a change that destroys data', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'plugin.remove', plugin: 'alpha' }, editor))
    expect(made.loader.pending()).toEqual([{ id, kind: 'plugin.remove', plugin: 'alpha' }])
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
  })

  it('applies a held change on its Confirm, after the Confirm record', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    await made.loader.confirm(id, {})
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(true)
    const order = made.link.records.map(record => record.event).filter(event => event.startsWith('security.'))
    expect(order).toEqual(['security.request', 'security.confirm', 'security.applied'])
    expect(made.link.events('security.applied')).toMatchObject([{ kind: 'skipVerification', by: 'confirm' }])
    expect(made.loader.pending()).toEqual([])
  })

  it('gives the same change asked twice the same id', async () => {
    const made = await harness()
    await made.loader.start()
    const one = held(await made.loader.request({ kind: 'grant.widen', plugin: 'alpha', capability: notes }, editor))
    const two = held(await made.loader.request({ kind: 'grant.widen', plugin: 'alpha', capability: { paths: ['notes/**'], type: 'luoshu.read' } }, editor))
    expect(two).toBe(one)
    expect(made.loader.pending()).toHaveLength(1)
  })

  it('holds at most 16 and answers throttled past them', async () => {
    const made = await harness()
    await made.loader.start()
    for (let i = 0; i < 16; i++) {
      held(await made.loader.request({ kind: 'limit.set', constant: 'readyMs', value: 20000 + i, plugin: null }, editor))
    }
    expect(await code(made.loader.request({ kind: 'limit.set', constant: 'readyMs', value: 30000, plugin: null }, editor))).toBe('throttled')
    expect(made.loader.pending()).toHaveLength(16)
  })

  it('answers stale and drops the request when the state it read changed before the Confirm', async () => {
    const made = await harness({ switches: { devMode: ['alpha'] } })
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    await made.loader.request({ kind: 'devMode', plugin: 'alpha', on: false }, editor)
    expect(await code(made.loader.confirm(id, {}))).toBe('stale')
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
    expect(made.loader.pending()).toEqual([])
  })

  it('answers stale when a state file was edited outside hetu', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    await writeFile(path.join(made.dataDir, 'state', 'luoshu.json'), 'planted')
    expect(await code(made.loader.confirm(id, {}))).toBe('stale')
  })

  it('applies nothing and keeps the request when the Confirm record is lost', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    made.link.landing = event => (event === 'security.confirm' ? 'lost' : 'landed')
    expect(await code(made.loader.confirm(id, {}))).toBe('failed')
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
    expect(made.loader.pending()).toHaveLength(1)
  })

  // Record nothing is on, so the record is muted and the change still applies
  it('applies on a muted Confirm record', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    made.link.landing = () => 'muted'
    await made.loader.confirm(id, {})
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(true)
  })

  it('answers not-found for a request it doesn\'t hold', async () => {
    const made = await harness()
    await made.loader.start()
    expect(await code(made.loader.confirm('nope', {}))).toBe('not-found')
    expect(await code(made.loader.cancel('nope'))).toBe('not-found')
  })

  it('drops a cancelled request with its record', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    await made.loader.cancel(id)
    expect(made.loader.pending()).toEqual([])
    expect(made.link.events('security.cancel')).toMatchObject([{ kind: 'skipVerification' }])
    expect(await code(made.loader.confirm(id, {}))).toBe('not-found')
  })

  it('records the change by kind, target and hash, never the folder', async () => {
    const made = await harness()
    await made.loader.start()
    held(await made.loader.request({ kind: 'luoshu.set', folder: path.join(made.base, 'notes') }, editor))
    const [record] = made.link.events('security.request')
    expect(record).toMatchObject({ kind: 'luoshu.set', target: null, window: 'editor' })
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(record)).not.toContain('notes')
  })
})

describe('typing to prove attention', () => {
  it('confirms switching a security control off only with its id typed', async () => {
    const gate = allowAll()
    const made = await harness({ behave: { gate: { exports: { gate } } } })
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'plugin.off', plugin: 'gate' }, editor))
    expect(await code(made.loader.confirm(id, {}))).toBe('invalid')
    expect(await code(made.loader.confirm(id, { typed: 'Gate' }))).toBe('invalid')
    expect(made.loader.slot('gate')).toBe('on')
    await made.loader.confirm(id, { typed: 'gate' })
    expect(made.loader.slot('gate')).toBe('off')
  })

  it('confirms recording off only with log typed', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'recordNothing', on: true }, editor))
    expect(await code(made.loader.confirm(id, { typed: 'gate' }))).toBe('invalid')
    await made.loader.confirm(id, { typed: 'log' })
    expect(made.loader.recordNothing()).toBe(true)
  })
})

describe('confirmOff', () => {
  it('applies a widening change the trusted window asks for at once', async () => {
    const made = await harness({ switches: { confirmOff: true } })
    await made.loader.start()
    expect(await made.loader.request({ kind: 'skipVerification', on: true }, trusted)).toEqual({ applied: true })
    expect(made.link.events('security.applied')).toMatchObject([{ kind: 'skipVerification', by: 'confirm-off' }])
  })

  it('still holds one any other window asks for', async () => {
    const made = await harness({ switches: { confirmOff: true } })
    await made.loader.start()
    held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
  })

  it('still holds one from the trusted window while it is off', async () => {
    const made = await harness()
    await made.loader.start()
    held(await made.loader.request({ kind: 'skipVerification', on: true }, trusted))
  })
})

describe('limits', () => {
  it('apply one lowered at once and hold one raised past the value in force', async () => {
    const made = await harness({ switches: { limits: { all: { readyMs: 20000 }, plugins: {} } } })
    await made.loader.start()
    expect(await made.loader.request({ kind: 'limit.set', constant: 'readyMs', value: 15000, plugin: null }, editor)).toEqual({ applied: true })
    held(await made.loader.request({ kind: 'limit.set', constant: 'readyMs', value: 16000, plugin: null }, editor))
    // One plugin's own value wins over the value for all
    expect(await made.loader.request({ kind: 'limit.set', constant: 'callsInFlight', value: 63, plugin: 'alpha' }, editor)).toEqual({ applied: true })
    held(await made.loader.request({ kind: 'limit.set', constant: 'callsInFlight', value: 64, plugin: 'alpha' }, editor))
  })
})

describe('the kinds the loader applies since the trusted window', () => {
  it('grant.widen adds a capability to a folder plugin\'s entry and grant.narrow takes it out with its switch', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed({ granted: [panel] }) } })
    await made.loader.start()
    await made.loader.apply({ kind: 'grant.widen', plugin: 'alpha', capability: notes })
    expect((await stateIn(made.dataDir)).plugins.alpha.granted).toEqual([panel, notes])
    await made.loader.apply({ kind: 'grant.widen', plugin: 'alpha', capability: notes })
    expect((await stateIn(made.dataDir)).plugins.alpha.granted).toEqual([panel, notes])
    await made.loader.apply({ kind: 'item.off', plugin: 'alpha', capability: notes })
    await made.loader.apply({ kind: 'grant.narrow', plugin: 'alpha', capability: notes })
    const entry = (await stateIn(made.dataDir)).plugins.alpha
    expect(entry.granted).toEqual([panel])
    expect(entry.off ?? []).toEqual([])
  })

  it('plugin.clearStorage empties a plugin\'s storage and starts it again', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    const storage = path.join(made.dataDir, 'storage', 'alpha')
    await mkdir(storage, { recursive: true })
    await writeFile(path.join(storage, 'key'), 'value')
    await made.loader.start()
    await made.loader.apply({ kind: 'plugin.clearStorage', plugin: 'alpha' })
    await made.loader.settled()
    expect(await readdir(storage).catch(() => [])).toEqual([])
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
    expect(made.loader.plugin('alpha')?.incarnation).toBe(2)
  })

  it('plugin.reset clears a folder plugin\'s storage and cache and removes its entry, so it waits for approval again', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    for (const kind of ['storage', 'cache']) {
      await mkdir(path.join(made.dataDir, kind, 'alpha'), { recursive: true })
      await writeFile(path.join(made.dataDir, kind, 'alpha', 'key'), 'value')
    }
    await made.loader.start()
    await made.loader.apply({ kind: 'plugin.reset', plugin: 'alpha' })
    await made.loader.settled()
    expect((await stateIn(made.dataDir)).plugins.alpha).toBeUndefined()
    expect(stateOf(made.loader, 'alpha')).toBe('found')
    expect(reasonOf(made.loader, 'alpha')).toBe('new')
    for (const kind of ['storage', 'cache']) expect(await readdir(path.join(made.dataDir, kind, 'alpha')).catch(() => [])).toEqual([])
    // The code stays, it waits to be approved again
    expect(await readdir(path.join(made.dataDir, 'plugins', 'alpha'))).toContain('hetu-plugin.json')
  })

  it('plugin.reset clears an install plugin\'s start marker, so it starts at the next start', async () => {
    const made = await harness({ install: { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) } }, markers: ['luoshu'] })
    await mkdir(path.join(made.dataDir, 'starting'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'starting', 'luoshu'), '')
    await made.loader.start()
    expect(reasonOf(made.loader, 'luoshu')).toBe('marker')
    await made.loader.apply({ kind: 'plugin.reset', plugin: 'luoshu' })
    expect(await readdir(path.join(made.dataDir, 'starting'))).toEqual([])
    // A host half starts once per run, so it waits for Restart hetu
    expect(reasonOf(made.loader, 'luoshu')).toBe('restart-hetu')
  })
})
