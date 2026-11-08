import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capabilityKey, type Capability } from '../api/capabilities.ts'
import type { SecurityList } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import { StateStore } from '../backend/boot/state.ts'
import { carrierOptions } from '../backend/wire.ts'
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

  // One window could fill every place, so the trusted window's own requests and every prompt answered
  // throttled. Each sender has places of its own
  it('keeps places for the trusted window and the core when another window filled its own', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') } })
    await made.loader.start()
    for (let i = 0; i < 16; i++) {
      held(await made.loader.request({ kind: 'limit.set', constant: 'readyMs', value: 20000 + i, plugin: null }, editor))
    }
    expect(await code(made.loader.request({ kind: 'confirmOff', on: true }, editor))).toBe('throttled')
    held(await made.loader.request({ kind: 'confirmOff', on: true }, trusted))
    // The core raised alpha's approval at start, in its own places
    expect(made.loader.pending().filter(request => request.kind === 'plugin.approve')).toHaveLength(1)
  })

  // Two narrowings at once must both stand
  it('applies two narrowings made at once to two switches, both standing', async () => {
    const made = await harness({ switches: { devMode: ['alpha'], confirmOff: true } })
    await made.loader.start()
    await Promise.all([
      made.loader.request({ kind: 'devMode', plugin: 'alpha', on: false }, editor),
      made.loader.request({ kind: 'confirmOff', on: false }, editor),
    ])
    const { switches } = await stateIn(made.dataDir)
    expect([switches.devMode, switches.confirmOff]).toEqual([[], false])
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

  // Nothing tested the wait running out on a record that never settles
  it('applies nothing once its record\u2019s wait runs out on a log that never answers', async () => {
    const made = await harness({ loader: { confirmRecordMs: 100 } })
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    made.link.landing = (event, _fields, signal) => event === 'security.confirm'
      ? new Promise(resolve => signal?.addEventListener('abort', () => resolve('lost')))
      : 'landed'
    const started = performance.now()
    expect(await code(made.loader.confirm(id, {}))).toBe('failed')
    expect(performance.now() - started).toBeLessThan(1000)
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
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

  // confirmOff skips the Confirm, never the typing that switching protection off asks for
  it('still holds a change that asks for typing, so the word is typed', async () => {
    const made = await harness({ switches: { confirmOff: true } })
    await made.loader.start()
    held(await made.loader.request({ kind: 'plugin.off', plugin: 'gate' }, trusted))
    held(await made.loader.request({ kind: 'recordNothing', on: true }, trusted))
    expect(made.loader.slot('gate')).toBe('on')
  })

  it('still holds one from the trusted window while it is off', async () => {
    const made = await harness()
    await made.loader.start()
    held(await made.loader.request({ kind: 'skipVerification', on: true }, trusted))
  })
})

describe('limits', () => {
  // A lowered value applied at once let a window lock the trusted window out, force a fail-stop or drop
  // the audit, so a limit waits for the human's Confirm either way
  it('hold one lowered as well as one raised', async () => {
    const made = await harness({ switches: { limits: { all: { readyMs: 20000 }, plugins: {} } } })
    await made.loader.start()
    held(await made.loader.request({ kind: 'limit.set', constant: 'readyMs', value: 15000, plugin: null }, editor))
    held(await made.loader.request({ kind: 'limit.set', constant: 'readyMs', value: 30000, plugin: null }, editor))
    held(await made.loader.request({ kind: 'limit.set', constant: 'logFailMs', value: 1, plugin: null }, editor))
    expect((await stateIn(made.dataDir)).switches.limits.all.readyMs).toBe(20000)
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

  // Recover left a readyMs of 1 standing, so the gate failed again at every start
  it('plugin.reset clears the limits the human set for that plugin', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha') }, entries: { alpha: signed() },
      switches: { limits: { all: { readyMs: 20000 }, plugins: { alpha: { readyMs: 1 }, beta: { readyMs: 2 } } } },
    })
    await made.loader.start()
    await made.loader.apply({ kind: 'plugin.reset', plugin: 'alpha' })
    const { limits } = (await stateIn(made.dataDir)).switches
    expect(limits.plugins).toEqual({ beta: { readyMs: 2 } })
    expect(limits.all).toEqual({ readyMs: 20000 })
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

// Record nothing's own record is the last one
describe('recording off and on', () => {
  it('drains what waits before the record of recording going off and counts what still waits in it', async () => {
    const made = await harness()
    await made.loader.start()
    made.link.waiting = 2
    const id = held(await made.loader.request({ kind: 'recordNothing', on: true }, editor))
    await made.loader.confirm(id, { typed: 'log' })
    const at = made.link.timeline.indexOf('drain')
    expect(at).toBeGreaterThan(-1)
    expect(made.link.timeline.indexOf('record security.confirm')).toBeGreaterThan(at)
    expect(made.link.events('security.confirm')).toMatchObject([{ kind: 'recordNothing', unwritten: 2 }])
  })

  it('drains nothing for any other change', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    await made.loader.confirm(id, {})
    expect(made.link.timeline).not.toContain('drain')
  })

  it('switches recording back on before its record, so that record is the first one written again', async () => {
    const made = await harness({ switches: { recordNothing: true } })
    await made.loader.start()
    let recording: boolean | null = null
    made.link.landing = event => {
      if (event === 'security.applied') recording = !made.loader.recordNothing()
      return 'landed'
    }
    expect(await made.loader.request({ kind: 'recordNothing', on: false }, editor)).toEqual({ applied: true })
    expect(recording).toBe(true)
    // Only recording going off drains
    expect(made.link.timeline).not.toContain('drain')
  })
})

describe('first-use asks', () => {
  const key = (capability: Capability) => capabilityKey(capability)
  const access = (id: string, capability: Capability = notes) => ({
    stage: 'canonical' as const, caller: { kind: 'plugin' as const, id, half: 'worker', incarnation: 1 }, action: 'luoshu.read',
    capability: capability.type, scope: { paths: ['notes/a.md'] },
  })
  const asking = (extra: object = {}) => harness({
    behave: { gate: { exports: { gate: allowAll() } } },
    folder: { alpha: worker('alpha'), beta: worker('beta') },
    entries: { alpha: signed({ granted: [notes, panel], firstUse: [notes, panel] }), beta: signed({ granted: [notes] }) },
    ...extra,
  })

  it('reach the gate as items whose first use asks, from the firstUse list in the entry', async () => {
    const gate = allowAll()
    const made = await asking({ behave: { gate: { exports: { gate } } } })
    await made.loader.start()
    const view = gate.seen.at(-1)!
    expect(view.plugins.alpha.map(item => item.firstUse)).toEqual([true, true])
    expect(view.plugins.beta.map(item => item.firstUse)).toEqual([false])
  })

  it('hold an item.on for the item asked, named for the plugin', async () => {
    const made = await asking()
    await made.loader.start()
    const id = made.loader.asks.raise(key(notes), access('alpha'))
    expect(typeof id).toBe('string')
    expect(made.loader.pending()).toEqual([{ id, kind: 'item.on', plugin: 'alpha' }])
  })

  it('answer the same ask with the same id and another one while it is open with throttled', async () => {
    const made = await asking()
    await made.loader.start()
    const id = made.loader.asks.raise(key(notes), access('alpha'))
    expect(made.loader.asks.raise(key(notes), access('alpha'))).toBe(id)
    expect(made.loader.asks.raise(key(panel), access('alpha', panel))).toEqual({ code: 'throttled' })
  })

  it('answer not-granted for an item the plugin holds with no first use, or doesn\'t hold', async () => {
    const made = await asking()
    await made.loader.start()
    expect(made.loader.asks.raise(key(notes), access('beta'))).toEqual({ code: 'not-granted' })
    expect(made.loader.asks.raise(key({ type: 'storage' }), access('alpha', { type: 'storage' }))).toEqual({ code: 'not-granted' })
    expect(made.loader.asks.raise(key(notes), { ...access('alpha'), caller: editor })).toEqual({ code: 'not-granted' })
  })

  it('switch the item on for good once confirmed', async () => {
    const gate = allowAll()
    const made = await asking({ behave: { gate: { exports: { gate } } } })
    await made.loader.start()
    const id = made.loader.asks.raise(key(notes), access('alpha')) as string
    await made.loader.confirm(id, {})
    expect(gate.seen.at(-1)!.plugins.alpha.map(item => item.firstUse)).toEqual([false, true])
    expect((await stateIn(made.dataDir)).plugins.alpha.firstUse).toEqual([panel])
  })

  it('answer declined for the rest of the run once the human cancelled one', async () => {
    const made = await asking()
    await made.loader.start()
    const id = made.loader.asks.raise(key(notes), access('alpha')) as string
    await made.loader.cancel(id)
    expect(made.loader.asks.raise(key(notes), access('alpha'))).toEqual({ code: 'not-granted', reason: 'declined' })
    // Another item still asks
    expect(typeof made.loader.asks.raise(key(panel), access('alpha', panel))).toBe('string')
  })
})

describe('requests the core raises itself', () => {
  it('raise plugin.approve for a plugin found in the folder', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') } })
    await made.loader.start()
    expect(stateOf(made.loader, 'alpha')).toBe('found')
    const [request] = made.loader.pending()
    expect(request).toMatchObject({ kind: 'plugin.approve', plugin: 'alpha' })
    await made.loader.confirm(request.id, {})
    expect((await stateIn(made.dataDir)).plugins.alpha).toBeDefined()
  })
})

describe('the wiring', () => {
  it('hands the carrier the loader\'s asks unless a test names others', async () => {
    const made = await harness()
    expect(carrierOptions(made.loader, { log: null }).asks).toBe(made.loader.asks)
    const other = { raise: () => 'req-1' }
    expect(carrierOptions(made.loader, { log: null, asks: other }).asks).toBe(other)
  })
})

describe('the core actions the loader serves', () => {
  const call = (caller: Caller, action: string, args?: unknown) => ({ callId: 'c1', caller, action, args, deadline: Date.now() + 30_000 })

  it('takes a security request from a window and confirms or cancels it from the trusted one', async () => {
    const made = await harness()
    await made.loader.start()
    const answer = await made.loader.serve(call(editor, 'security.request', { change: { kind: 'skipVerification', on: true } })) as { held: string }
    expect(answer).toEqual({ held: expect.any(String) })
    await made.loader.serve(call(trusted, 'security.confirm', { requestId: answer.held }))
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(true)
    const again = await made.loader.serve(call(editor, 'security.request', { change: { kind: 'confirmOff', on: true } })) as { held: string }
    expect(await made.loader.serve(call(trusted, 'security.cancel', { requestId: again.held }))).toBe(null)
    expect(made.loader.pending()).toEqual([])
  })

  it('passes what the human typed on to the Confirm', async () => {
    const made = await harness({ behave: { gate: { exports: { gate: allowAll() } } } })
    await made.loader.start()
    const { held: id } = await made.loader.serve(call(editor, 'security.request', { change: { kind: 'plugin.off', plugin: 'gate' } })) as { held: string }
    expect(await code(made.loader.serve(call(trusted, 'security.confirm', { requestId: id })))).toBe('invalid')
    await made.loader.serve(call(trusted, 'security.confirm', { requestId: id, typed: 'gate' }))
    expect(made.loader.slot('gate')).toBe('off')
  })

  it('lists each plugin, the switches, the requests in the core\'s words and the stopped mode for the trusted window', async () => {
    const made = await harness({
      behave: { gate: { exports: { gate: allowAll() } } },
      folder: { alpha: worker('alpha') },
      entries: { alpha: signed({ granted: [notes, panel], off: [panel] }) },
    })
    await made.loader.start()
    await made.loader.request({ kind: 'plugin.off', plugin: 'gate' }, editor)
    const list = await made.loader.serve(call(trusted, 'security.list')) as SecurityList
    expect(list.plugins.find(plugin => plugin.id === 'gate')).toMatchObject({ from: 'install', place: 'host', state: 'ready', security: true, on: true })
    expect(list.plugins.find(plugin => plugin.id === 'alpha')).toMatchObject({
      from: 'folder', place: 'sandboxed', security: false, on: true,
      items: [{ capability: notes, off: false, firstUse: false }, { capability: panel, off: true, firstUse: false }],
    })
    expect(list.requests).toEqual([{
      id: expect.any(String), kind: 'plugin.off', plugin: 'gate', text: 'Switch gate off', notes: expect.any(Array), type: 'gate',
    }])
    expect(list.switches).toEqual({
      devMode: [], execAnyCommand: [], skipVerification: false, allowUnsigned: [], confirmOff: false, recordNothing: false,
    })
    expect(list.stopped).toBe(null)
  })

  it('stops and restarts a sandboxed plugin for the human, never a host half', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.loader.start()
    await made.loader.serve(call(trusted, 'core.stop', { plugin: 'alpha' }))
    expect(stateOf(made.loader, 'alpha')).toBe('stopped')
    expect(reasonOf(made.loader, 'alpha')).toBe('human')
    await made.loader.serve(call(trusted, 'core.restart', { plugin: 'alpha' }))
    await made.loader.settled()
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
    expect(await code(made.loader.serve(call(trusted, 'core.stop', { plugin: 'gate' })))).toBe('not-granted')
    expect(await code(made.loader.serve(call(trusted, 'core.stop', { plugin: 'ghost' })))).toBe('not-found')
  })

  // The human stops a plugin from the trusted window, so only the trusted window starts it again
  it('restarts a plugin the human stopped only from the trusted window, never from the editor or the watchdog', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.loader.start()
    await made.loader.serve(call(trusted, 'core.stop', { plugin: 'alpha' }))
    expect(await code(made.loader.serve(call(editor, 'core.restart', { plugin: 'alpha' })))).toBe('not-granted')
    const watchdog = { kind: 'plugin' as const, id: 'watchdog', half: 'host', incarnation: 1 }
    expect(await code(made.loader.serve(call(watchdog, 'watchdog.restart', { plugin: 'alpha' })))).toBe('not-granted')
    expect(stateOf(made.loader, 'alpha')).toBe('stopped')
    await made.loader.serve(call(trusted, 'core.restart', { plugin: 'alpha' }))
    await made.loader.settled()
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
  })

  it('leaves opening windows, Quit and Restart hetu to the runtime', async () => {
    const made = await harness()
    await made.loader.start()
    for (const action of ['security.open', 'core.quit', 'core.relaunch']) {
      expect(await code(made.loader.serve(call(editor, action)))).toBe('unavailable')
    }
  })
})

// Each request applies or waits in the loader's one queue, with Cancel, so nothing slips between a
// Confirm and its change
describe('requests in one queue', () => {
  it('lets a Cancel made while a Confirm waits on its record wait for that Confirm', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    let land!: (landing: 'landed') => void
    made.link.landing = event => (event === 'security.confirm' ? new Promise(resolve => { land = resolve }) : 'landed')
    const confirmed = made.loader.confirm(id, {})
    await new Promise(resolve => setTimeout(resolve, 20))
    const cancelled = code(made.loader.cancel(id))
    land('landed')
    await confirmed
    expect(await cancelled).toBe('not-found')
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(true)
    expect(made.link.events('security.cancel')).toEqual([])
  })

  it('applies a narrowing change only after a Confirm already under way', async () => {
    const made = await harness({ switches: { devMode: ['alpha'] } })
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    let land!: (landing: 'landed') => void
    made.link.landing = event => (event === 'security.confirm' ? new Promise(resolve => { land = resolve }) : 'landed')
    const confirmed = made.loader.confirm(id, {})
    await new Promise(resolve => setTimeout(resolve, 20))
    const narrowed = made.loader.request({ kind: 'devMode', plugin: 'alpha', on: false }, editor)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await stateIn(made.dataDir)).switches.devMode).toEqual(['alpha'])
    land('landed')
    await confirmed
    expect(await narrowed).toEqual({ applied: true })
    const { switches } = await stateIn(made.dataDir)
    expect([switches.skipVerification, switches.devMode]).toEqual([true, []])
  })

  it('tells the windows when a request is raised and when one goes', async () => {
    const made = await harness()
    await made.loader.start()
    const before = made.link.changes
    const id = held(await made.loader.request({ kind: 'skipVerification', on: true }, editor))
    expect(made.link.changes).toBeGreaterThan(before)
    const raised = made.link.changes
    await made.loader.cancel(id)
    expect(made.link.changes).toBeGreaterThan(raised)
  })
})

// After the human's Confirm the next request was drawn under the cursor and a second click counted. A
// request counts only once it has been first in line for the input delay
describe('the delay before a request counts', () => {
  it('refuses a Confirm until the request has been first in line for the delay, and starts it again for the next one', async () => {
    // Two changes to two plugins' entries, so confirming the first leaves the second fresh
    const made = await harness({
      loader: { confirmDelayMs: 200 },
      folder: { alpha: worker('alpha'), beta: worker('beta') },
      entries: { alpha: signed(), beta: signed() },
    })
    await made.loader.start()
    const first = held(await made.loader.request({ kind: 'grant.widen', plugin: 'alpha', capability: notes }, editor))
    const second = held(await made.loader.request({ kind: 'grant.widen', plugin: 'beta', capability: notes }, editor))
    expect(await code(made.loader.confirm(first, {}))).toBe('throttled')
    // Only the first in line counts
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(await code(made.loader.confirm(second, {}))).toBe('throttled')
    await made.loader.confirm(first, {})
    expect(await code(made.loader.confirm(second, {}))).toBe('throttled')
    await new Promise(resolve => setTimeout(resolve, 250))
    await made.loader.confirm(second, {})
    expect((await stateIn(made.dataDir)).plugins.beta.granted).toEqual([notes])
  })
})

// An approval was confirmed with no word of what it grants
describe('the request to approve a plugin', () => {
  it('lists its version and every grant its manifest asks for', async () => {
    const made = await harness({ folder: { alpha: worker('alpha', { capabilities: [notes, { type: 'net.fetch', hosts: ['example.com'] }] }) } })
    await made.loader.start()
    const list = await made.loader.serve({ callId: 'c1', caller: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 }) as SecurityList
    expect(list.requests[0]).toMatchObject({ kind: 'plugin.approve', plugin: 'alpha' })
    expect(list.requests[0].notes).toEqual(['Version 1.0.0', 'It asks for: luoshu.read on "notes/**"', 'It asks for: net.fetch to "example.com"'])
  })

  it('says when it asks for nothing', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') } })
    await made.loader.start()
    const list = await made.loader.serve({ callId: 'c1', caller: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 }) as SecurityList
    expect(list.requests[0].notes).toEqual(['Version 1.0.0', 'It asks for nothing'])
  })
})

// With the log down, the stopped mode's stop recording waited for a record the dead log could never take
describe('stopping recording with the log down', () => {
  it('applies though its own record was lost, since the log is what it switches off', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'recordNothing', on: true }, editor))
    made.link.landing = () => 'lost'
    await made.loader.confirm(id, { typed: 'log' })
    expect(made.loader.recordNothing()).toBe(true)
  })

  it('lets the audit writer go again when the switch can\u2019t be written', async () => {
    const made = await harness()
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'recordNothing', on: true }, editor))
    made.store.writeSwitches = async () => { throw new Error('read-only') }
    expect(await code(made.loader.confirm(id, { typed: 'log' }))).toBe('failed')
    expect(made.link.timeline.slice(-2)).toEqual(expect.arrayContaining(['resume']))
  })
})
