import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capabilityKey, type Capability } from '../api/capabilities.ts'
import type { SecurityList } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import { StateStore } from '../backend/boot/state.ts'
import { createSecurityView } from '../backend/security-view/security-view.ts'
import { allowAll, cleanup, entryFor, filesFor, harness, reasonOf, stateOf, workerManifest, type Files } from './plugins-manager-fakes.ts'

afterEach(cleanup)

const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const worker = (id: string, extra: object = {}): Files => filesFor(workerManifest(id, extra))
const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const panel: Capability = { type: 'ui.view' }
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
    await made.pluginsManager.start()
    expect(await made.pluginsManager.request({ kind: 'confirmOff', on: false }, editor)).toEqual({ applied: true })
    expect((await stateIn(made.dataDir)).switches.confirmOff).toBe(false)
    expect(made.link.events('security.applied')).toMatchObject([{ kind: 'confirmOff', window: 'editor', by: 'narrows' }])
    expect(made.pluginsManager.pending()).toEqual([])
  })

  it('holds a widening change for the Confirm and applies nothing', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    expect(made.pluginsManager.pending()).toEqual([{ id, kind: 'skipVerification', plugin: null }])
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
    expect(made.link.events('security.request')).toMatchObject([{ kind: 'skipVerification', window: 'editor' }])
    expect(made.link.events('security.applied')).toEqual([])
  })

  it('holds a change that destroys data', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'plugin.remove', plugin: 'alpha' }, editor))
    expect(made.pluginsManager.pending()).toEqual([{ id, kind: 'plugin.remove', plugin: 'alpha' }])
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
  })

  it('applies a held change on its Confirm, after the Confirm record', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    await made.pluginsManager.confirm(id, {})
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(true)
    const order = made.link.records.map(record => record.event).filter(event => event.startsWith('security.'))
    expect(order).toEqual(['security.request', 'security.confirm', 'security.applied'])
    expect(made.link.events('security.applied')).toMatchObject([{ kind: 'skipVerification', by: 'confirm' }])
    expect(made.pluginsManager.pending()).toEqual([])
  })

  it('gives the same change asked twice the same id', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const one = held(await made.pluginsManager.request({ kind: 'grant.widen', plugin: 'alpha', capability: notes }, editor))
    const two = held(await made.pluginsManager.request({ kind: 'grant.widen', plugin: 'alpha', capability: { paths: ['notes/**'], type: 'luoshu.read' } }, editor))
    expect(two).toBe(one)
    expect(made.pluginsManager.pending()).toHaveLength(1)
  })

  // One window could fill every place, so the trusted window's own requests and every prompt answered
  // throttled. Each sender has places of its own
  it('keeps places for the trusted window and the core when another window filled its own', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') } })
    await made.pluginsManager.start()
    for (let i = 0; i < 16; i++) {
      held(await made.pluginsManager.request({ kind: 'limit.set', constant: 'readyMs', value: 20000 + i, plugin: null }, editor))
    }
    expect(await code(made.pluginsManager.request({ kind: 'confirmOff', on: true }, editor))).toBe('throttled')
    held(await made.pluginsManager.request({ kind: 'confirmOff', on: true }, trusted))
    // The core raised alpha's approval at start, in its own places
    expect(made.pluginsManager.pending().filter(request => request.kind === 'plugin.approve')).toHaveLength(1)
  })

  // Two narrowings at once must both stand
  it('applies two narrowings made at once to two switches, both standing', async () => {
    const made = await harness({ switches: { devMode: ['alpha'], confirmOff: true } })
    await made.pluginsManager.start()
    await Promise.all([
      made.pluginsManager.request({ kind: 'devMode', plugin: 'alpha', on: false }, editor),
      made.pluginsManager.request({ kind: 'confirmOff', on: false }, editor),
    ])
    const { switches } = await stateIn(made.dataDir)
    expect([switches.devMode, switches.confirmOff]).toEqual([[], false])
  })

  it('holds at most 16 and answers throttled past them', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    for (let i = 0; i < 16; i++) {
      held(await made.pluginsManager.request({ kind: 'limit.set', constant: 'readyMs', value: 20000 + i, plugin: null }, editor))
    }
    expect(await code(made.pluginsManager.request({ kind: 'limit.set', constant: 'readyMs', value: 30000, plugin: null }, editor))).toBe('throttled')
    expect(made.pluginsManager.pending()).toHaveLength(16)
  })

  it('answers stale and drops the request when the state it read changed before the Confirm', async () => {
    const made = await harness({ switches: { devMode: ['alpha'] } })
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    await made.pluginsManager.request({ kind: 'devMode', plugin: 'alpha', on: false }, editor)
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('stale')
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
    expect(made.pluginsManager.pending()).toEqual([])
  })

  it('answers stale when a state file was edited outside hetu', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    await writeFile(path.join(made.dataDir, 'state', 'luoshu.json'), 'planted')
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('stale')
  })

  it('applies nothing and keeps the request when the Confirm record is lost', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    made.link.landing = event => (event === 'security.confirm' ? 'lost' : 'landed')
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('failed')
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
    expect(made.pluginsManager.pending()).toHaveLength(1)
  })

  // Nothing tested the wait running out on a record that never settles
  it('applies nothing once its record\u2019s wait runs out on a log that never answers', async () => {
    const made = await harness({ pluginsManager: { confirmRecordMs: 100 } })
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    made.link.landing = (event, _fields, signal) => event === 'security.confirm'
      ? new Promise(resolve => signal?.addEventListener('abort', () => resolve('lost')))
      : 'landed'
    const started = performance.now()
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('failed')
    expect(performance.now() - started).toBeLessThan(1000)
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
  })

  // Record nothing is on, so the record is muted and the change still applies
  it('applies on a muted Confirm record', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    made.link.landing = () => 'muted'
    await made.pluginsManager.confirm(id, {})
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(true)
  })

  it('answers not-found for a request it doesn\'t hold', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    expect(await code(made.pluginsManager.confirm('nope', {}))).toBe('not-found')
    expect(await code(made.pluginsManager.cancel('nope'))).toBe('not-found')
  })

  it('drops a cancelled request with its record', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    await made.pluginsManager.cancel(id)
    expect(made.pluginsManager.pending()).toEqual([])
    expect(made.link.events('security.cancel')).toMatchObject([{ kind: 'skipVerification' }])
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('not-found')
  })

  it('records the change by kind, target and hash, never the folder', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    held(await made.pluginsManager.request({ kind: 'luoshu.pick', folder: path.join(made.base, 'notes') }, editor))
    const [record] = made.link.events('security.request')
    expect(record).toMatchObject({ kind: 'luoshu.pick', target: null, window: 'editor' })
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(record)).not.toContain('notes')
  })
})

describe('typing to prove attention', () => {
  it('confirms switching a security control off only with its id typed', async () => {
    const gate = allowAll()
    const made = await harness({ modules: { gate } })
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'gate' }, editor))
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('invalid')
    expect(await code(made.pluginsManager.confirm(id, { typed: 'Gate' }))).toBe('invalid')
    expect(made.pluginsManager.policyJob('gate')).toBe('on')
    await made.pluginsManager.confirm(id, { typed: 'gate' })
    expect(made.pluginsManager.policyJob('gate')).toBe('off')
  })

  it('confirms recording off only with its id typed', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'recording' }, editor))
    expect(await code(made.pluginsManager.confirm(id, { typed: 'gate' }))).toBe('invalid')
    await made.pluginsManager.confirm(id, { typed: 'recording' })
    expect(made.modules.state('recording')).toBe('off')
  })
})

describe('confirmOff', () => {
  it('applies a widening change the trusted window asks for at once', async () => {
    const made = await harness({ switches: { confirmOff: true } })
    await made.pluginsManager.start()
    expect(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, trusted)).toEqual({ applied: true })
    expect(made.link.events('security.applied')).toMatchObject([{ kind: 'skipVerification', by: 'confirm-off' }])
  })

  it('still holds one any other window asks for', async () => {
    const made = await harness({ switches: { confirmOff: true } })
    await made.pluginsManager.start()
    held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
  })

  // confirmOff skips the Confirm, never the typing that switching protection off asks for
  it('still holds a change that asks for typing, so the word is typed', async () => {
    const made = await harness({ switches: { confirmOff: true } })
    await made.pluginsManager.start()
    held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'gate' }, trusted))
    held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'recording' }, trusted))
    expect(made.pluginsManager.policyJob('gate')).toBe('on')
  })

  it('still holds one from the trusted window while it is off', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, trusted))
  })
})

describe('limits', () => {
  // A lowered value applied at once let a window lock the trusted window out, force a fail-stop or drop
  // the audit, so a limit waits for the human's Confirm either way
  it('hold one lowered as well as one raised', async () => {
    const made = await harness({ switches: { limits: { all: { readyMs: 20000 }, plugins: {} } } })
    await made.pluginsManager.start()
    held(await made.pluginsManager.request({ kind: 'limit.set', constant: 'readyMs', value: 15000, plugin: null }, editor))
    held(await made.pluginsManager.request({ kind: 'limit.set', constant: 'readyMs', value: 30000, plugin: null }, editor))
    held(await made.pluginsManager.request({ kind: 'limit.set', constant: 'logFailMs', value: 1, plugin: null }, editor))
    expect((await stateIn(made.dataDir)).switches.limits.all.readyMs).toBe(20000)
  })
})

describe('the kinds the plugins manager applies since the trusted window', () => {
  it('grant.widen adds a capability to a folder plugin\'s entry and grant.narrow takes it out with its switch', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed({ granted: [panel] }) } })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'grant.widen', plugin: 'alpha', capability: notes })
    expect((await stateIn(made.dataDir)).plugins.alpha.granted).toEqual([panel, notes])
    await made.pluginsManager.apply({ kind: 'grant.widen', plugin: 'alpha', capability: notes })
    expect((await stateIn(made.dataDir)).plugins.alpha.granted).toEqual([panel, notes])
    await made.pluginsManager.apply({ kind: 'item.off', plugin: 'alpha', capability: notes })
    await made.pluginsManager.apply({ kind: 'grant.narrow', plugin: 'alpha', capability: notes })
    const entry = (await stateIn(made.dataDir)).plugins.alpha
    expect(entry.granted).toEqual([panel])
    expect(entry.off ?? []).toEqual([])
  })

  it('plugin.clearStorage empties a plugin\'s storage and starts it again', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    const storage = path.join(made.dataDir, 'storage', 'alpha')
    await mkdir(storage, { recursive: true })
    await writeFile(path.join(storage, 'key'), 'value')
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.clearStorage', plugin: 'alpha' })
    await made.pluginsManager.settled()
    expect(await readdir(storage).catch(() => [])).toEqual([])
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    expect(made.pluginsManager.plugin('alpha')?.incarnation).toBe(2)
  })

  it('plugin.reset clears a folder plugin\'s storage and cache and removes its entry, so it waits for approval again', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    for (const kind of ['storage', 'cache']) {
      await mkdir(path.join(made.dataDir, kind, 'alpha'), { recursive: true })
      await writeFile(path.join(made.dataDir, kind, 'alpha', 'key'), 'value')
    }
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.reset', plugin: 'alpha' })
    await made.pluginsManager.settled()
    expect((await stateIn(made.dataDir)).plugins.alpha).toBeUndefined()
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('found')
    expect(reasonOf(made.pluginsManager, 'alpha')).toBe('new')
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
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.reset', plugin: 'alpha' })
    const { limits } = (await stateIn(made.dataDir)).switches
    expect(limits.plugins).toEqual({ beta: { readyMs: 2 } })
    expect(limits.all).toEqual({ readyMs: 20000 })
  })

  // A core module has no storage, cache or entry of its own to reset, its switch is the way out
  it('plugin.reset refuses a core module and changes nothing', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    await expect(made.pluginsManager.apply({ kind: 'plugin.reset', plugin: 'luoshu' })).rejects.toThrow('core module')
    expect(made.modules.state('luoshu')).toBe('on')
    expect(made.link.events('security.applied')).toEqual([])
  })
})

// Record nothing's own record is the last one
describe('recording off and on', () => {
  it('drains what waits before the record of recording going off and counts what still waits in it', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    made.link.waiting = 2
    const id = held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'recording' }, editor))
    await made.pluginsManager.confirm(id, { typed: 'recording' })
    const at = made.link.timeline.indexOf('drain')
    expect(at).toBeGreaterThan(-1)
    expect(made.link.timeline.indexOf('record security.confirm')).toBeGreaterThan(at)
    expect(made.link.events('security.confirm')).toMatchObject([{ kind: 'plugin.off', target: 'recording', unwritten: 2 }])
  })

  it('drains nothing for any other change', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    await made.pluginsManager.confirm(id, {})
    expect(made.link.timeline).not.toContain('drain')
  })

  it('switches recording back on before its record, so that record is the first one written again', async () => {
    const made = await harness({ switches: { off: ['recording'] } })
    await made.pluginsManager.start()
    let recording: boolean | null = null
    made.link.landing = event => {
      if (event === 'security.applied') recording = made.modules.state('recording') !== 'off'
      return 'landed'
    }
    expect(await made.pluginsManager.request({ kind: 'plugin.on', plugin: 'recording' }, editor)).toEqual({ applied: true })
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
  // Each of alpha's items is class 4, so the grant risk classifier has each ask at its first use. beta's read of notes
  // is class 1 and asks nothing
  const wide: Capability = { type: 'luoshu.write', paths: ['**'] }
  const anywhere: Capability = { type: 'net.fetch', hosts: ['*'] }
  const asking = (gate = allowAll()) => harness({
    modules: { gate },
    folder: { alpha: worker('alpha'), beta: worker('beta') },
    entries: { alpha: signed({ granted: [wide, anywhere], class: 4, firstUse: [wide, anywhere] }), beta: signed({ granted: [notes] }) },
  })

  it('reach the gate as items whose first use asks, from the firstUse list in the entry', async () => {
    const gate = allowAll()
    const made = await asking(gate)
    await made.pluginsManager.start()
    const view = gate.seen.at(-1)!
    expect(view.plugins.alpha.map(item => item.firstUse)).toEqual([true, true])
    expect(view.plugins.beta.map(item => item.firstUse)).toEqual([false])
  })

  it('hold an item.on for the item asked, named for the plugin', async () => {
    const made = await asking()
    await made.pluginsManager.start()
    const id = made.pluginsManager.asks.raise(key(wide), access('alpha', wide))
    expect(typeof id).toBe('string')
    expect(made.pluginsManager.pending()).toEqual([{ id, kind: 'item.on', plugin: 'alpha' }])
  })

  it('answer the same ask with the same id and another one while it is open with throttled', async () => {
    const made = await asking()
    await made.pluginsManager.start()
    const id = made.pluginsManager.asks.raise(key(wide), access('alpha', wide))
    expect(made.pluginsManager.asks.raise(key(wide), access('alpha', wide))).toBe(id)
    expect(made.pluginsManager.asks.raise(key(anywhere), access('alpha', anywhere))).toEqual({ code: 'throttled' })
  })

  it('answer not-granted for an item the plugin holds with no first use, or doesn\'t hold', async () => {
    const made = await asking()
    await made.pluginsManager.start()
    expect(made.pluginsManager.asks.raise(key(notes), access('beta'))).toEqual({ code: 'not-granted' })
    expect(made.pluginsManager.asks.raise(key({ type: 'storage' }), access('alpha', { type: 'storage' }))).toEqual({ code: 'not-granted' })
    expect(made.pluginsManager.asks.raise(key(notes), { ...access('alpha'), caller: editor })).toEqual({ code: 'not-granted' })
  })

  it('switch the item on for good once confirmed', async () => {
    const gate = allowAll()
    const made = await asking(gate)
    await made.pluginsManager.start()
    const id = made.pluginsManager.asks.raise(key(wide), access('alpha', wide)) as string
    await made.pluginsManager.confirm(id, {})
    expect(gate.seen.at(-1)!.plugins.alpha.map(item => item.firstUse)).toEqual([false, true])
    expect((await stateIn(made.dataDir)).plugins.alpha.firstUse).toEqual([anywhere])
  })

  it('answer declined for the rest of the run once the human cancelled one', async () => {
    const made = await asking()
    await made.pluginsManager.start()
    const id = made.pluginsManager.asks.raise(key(wide), access('alpha', wide)) as string
    await made.pluginsManager.cancel(id)
    expect(made.pluginsManager.asks.raise(key(wide), access('alpha', wide))).toEqual({ code: 'not-granted', reason: 'declined' })
    // Another item still asks
    expect(typeof made.pluginsManager.asks.raise(key(anywhere), access('alpha', anywhere))).toBe('string')
  })
})

describe('requests the core raises itself', () => {
  it('raise plugin.approve for a plugin found in the folder', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('found')
    const [request] = made.pluginsManager.pending()
    expect(request).toMatchObject({ kind: 'plugin.approve', plugin: 'alpha' })
    await made.pluginsManager.confirm(request.id, {})
    expect((await stateIn(made.dataDir)).plugins.alpha).toBeDefined()
  })
})

describe('the wiring', () => {
  it('hands the carrier its asks, the core actions it serves and its listeners through the carrier\'s door as it is built', async () => {
    const made = await harness()
    expect(made.link.handed.asks).toBe(made.pluginsManager.asks)
    expect(Object.fromEntries(made.link.handed.served)).toEqual({ 'plugins-manager': made.pluginsManager.serve })
    expect([made.link.handed.wayClosed.length, made.link.handed.heard.length]).toEqual([1, 1])
  })
})

describe('the core actions the plugins manager serves', () => {
  const call = (caller: Caller, action: string, args?: unknown) => ({ callId: 'c1', caller, action, args, deadline: Date.now() + 30_000 })

  it('takes a security request from a window and confirms or cancels it from the trusted one', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const answer = await made.pluginsManager.serve(call(editor, 'security.request', { change: { kind: 'skipVerification', on: true } })) as { held: string }
    expect(answer).toEqual({ held: expect.any(String) })
    await made.pluginsManager.serve(call(trusted, 'security.confirm', { requestId: answer.held }))
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(true)
    const again = await made.pluginsManager.serve(call(editor, 'security.request', { change: { kind: 'confirmOff', on: true } })) as { held: string }
    expect(await made.pluginsManager.serve(call(trusted, 'security.cancel', { requestId: again.held }))).toBe(null)
    expect(made.pluginsManager.pending()).toEqual([])
  })

  it('passes what the human typed on to the Confirm', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const { held: id } = await made.pluginsManager.serve(call(editor, 'security.request', { change: { kind: 'plugin.off', plugin: 'gate' } })) as { held: string }
    expect(await code(made.pluginsManager.serve(call(trusted, 'security.confirm', { requestId: id })))).toBe('invalid')
    await made.pluginsManager.serve(call(trusted, 'security.confirm', { requestId: id, typed: 'gate' }))
    expect(made.pluginsManager.policyJob('gate')).toBe('off')
  })

  it('lists each plugin, the switches, the requests in the core\'s words and the stopped mode for the trusted window', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha') },
      entries: { alpha: signed({ granted: [notes, panel], off: [panel] }) },
    })
    await made.pluginsManager.start()
    await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'gate' }, editor)
    const list = await made.pluginsManager.serve(call(trusted, 'security.list')) as SecurityList
    expect(list.plugins.find(plugin => plugin.id === 'gate')).toMatchObject({ from: 'core', place: 'core', state: 'ready', security: true, on: true })
    expect(list.plugins.find(plugin => plugin.id === 'alpha')).toMatchObject({
      from: 'folder', place: 'sandboxed', security: false, on: true,
      items: [{ capability: notes, off: false, firstUse: false }, { capability: panel, off: true, firstUse: false }],
    })
    expect(list.requests).toEqual([{
      id: expect.any(String), kind: 'plugin.off', plugin: 'gate', text: 'Switch gate off', notes: expect.any(Array), type: 'gate', agent: null,
    }])
    expect(list.switches).toEqual({
      devMode: [], execAnyCommand: [], skipVerification: false, allowUnsigned: [], confirmOff: false,
    })
    expect(list.limits).toEqual({ all: {}, plugins: {} })
    expect(list.luoshu).toBe(null)
    expect(list.stopped).toBe(null)
  })

  it('lists the limits the human set, for all and for each plugin, as copies the window can’t change', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null })
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'callsInFlight', value: 8, plugin: 'alpha' })
    const list = await made.pluginsManager.serve(call(trusted, 'security.list')) as SecurityList
    expect(list.limits).toEqual({ all: { readyMs: 20000 }, plugins: { alpha: { callsInFlight: 8 } } })
    list.limits.all.readyMs = 1
    expect((await made.pluginsManager.serve(call(trusted, 'security.list')) as SecurityList).limits.all.readyMs).toBe(20000)
  })

  it('names the notes folder once luoshu.pick applies', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const folder = path.join(made.base, 'notes')
    await made.pluginsManager.apply({ kind: 'luoshu.pick', folder })
    expect((await made.pluginsManager.serve(call(trusted, 'security.list')) as SecurityList).luoshu).toBe(folder)
  })

  it('stops and restarts a sandboxed plugin for the human, never a core module', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(call(trusted, 'core.stop', { plugin: 'alpha' }))
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('stopped')
    expect(reasonOf(made.pluginsManager, 'alpha')).toBe('human')
    await made.pluginsManager.serve(call(trusted, 'core.restart', { plugin: 'alpha' }))
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    expect(await code(made.pluginsManager.serve(call(trusted, 'core.stop', { plugin: 'gate' })))).toBe('not-found')
    expect(made.modules.state('gate')).toBe('on')
    expect(await code(made.pluginsManager.serve(call(trusted, 'core.stop', { plugin: 'ghost' })))).toBe('not-found')
  })

  // The human stops a plugin from the trusted window, so only the trusted window starts it again
  it('restarts a plugin the human stopped only from the trusted window, never from the editor', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(call(trusted, 'core.stop', { plugin: 'alpha' }))
    expect(await code(made.pluginsManager.serve(call(editor, 'core.restart', { plugin: 'alpha' })))).toBe('not-granted')
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('stopped')
    await made.pluginsManager.serve(call(trusted, 'core.restart', { plugin: 'alpha' }))
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
  })

  // Only a utility half, the door, is kept to the trusted window
  it('restarts a running sandboxed plugin from the editor window too', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(call(editor, 'core.restart', { plugin: 'alpha' }))
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    expect(made.pluginsManager.plugin('alpha')?.incarnation).toBe(2)
  })

  it('leaves opening windows, Quit and Restart hetu to the runtime', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    for (const action of ['app.openSecurity', 'app.quit', 'app.relaunch']) {
      expect(await code(made.pluginsManager.serve(call(editor, action)))).toBe('unavailable')
    }
  })
})

// Each request applies or waits in the plugins manager's one queue, with Cancel, so nothing slips between a
// Confirm and its change
describe('requests in one queue', () => {
  it('lets a Cancel made while a Confirm waits on its record wait for that Confirm', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    let land!: (landing: 'landed') => void
    made.link.landing = event => (event === 'security.confirm' ? new Promise(resolve => { land = resolve }) : 'landed')
    const confirmed = made.pluginsManager.confirm(id, {})
    await new Promise(resolve => setTimeout(resolve, 20))
    const cancelled = code(made.pluginsManager.cancel(id))
    land('landed')
    await confirmed
    expect(await cancelled).toBe('not-found')
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(true)
    expect(made.link.events('security.cancel')).toEqual([])
  })

  it('applies a narrowing change only after a Confirm already under way', async () => {
    const made = await harness({ switches: { devMode: ['alpha'] } })
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    let land!: (landing: 'landed') => void
    made.link.landing = event => (event === 'security.confirm' ? new Promise(resolve => { land = resolve }) : 'landed')
    const confirmed = made.pluginsManager.confirm(id, {})
    await new Promise(resolve => setTimeout(resolve, 20))
    const narrowed = made.pluginsManager.request({ kind: 'devMode', plugin: 'alpha', on: false }, editor)
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
    await made.pluginsManager.start()
    const before = made.link.changes
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    expect(made.link.changes).toBeGreaterThan(before)
    const raised = made.link.changes
    await made.pluginsManager.cancel(id)
    expect(made.link.changes).toBeGreaterThan(raised)
  })
})

// After the human's Confirm the next request was drawn under the cursor and a second click counted. A
// request counts only once it has been first in line for the input delay
describe('the delay before a request counts', () => {
  it('refuses a Confirm until the request has been first in line for the delay, and starts it again for the next one', async () => {
    // Two changes to two plugins' entries, so confirming the first leaves the second fresh
    const made = await harness({
      pluginsManager: { confirmDelayMs: 200 },
      folder: { alpha: worker('alpha'), beta: worker('beta') },
      entries: { alpha: signed(), beta: signed() },
    })
    await made.pluginsManager.start()
    const first = held(await made.pluginsManager.request({ kind: 'grant.widen', plugin: 'alpha', capability: notes }, editor))
    const second = held(await made.pluginsManager.request({ kind: 'grant.widen', plugin: 'beta', capability: notes }, editor))
    expect(await code(made.pluginsManager.confirm(first, {}))).toBe('throttled')
    // Only the first in line counts
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(await code(made.pluginsManager.confirm(second, {}))).toBe('throttled')
    await made.pluginsManager.confirm(first, {})
    expect(await code(made.pluginsManager.confirm(second, {}))).toBe('throttled')
    await new Promise(resolve => setTimeout(resolve, 250))
    await made.pluginsManager.confirm(second, {})
    expect((await stateIn(made.dataDir)).plugins.beta.granted).toEqual([notes])
  })
})

// An approval was confirmed with no word of what it grants
describe('the request to approve a plugin', () => {
  it('lists its version and every grant its manifest asks for', async () => {
    const made = await harness({ folder: { alpha: worker('alpha', { capabilities: [notes, { type: 'net.fetch', hosts: ['example.com'] }] }) } })
    await made.pluginsManager.start()
    const list = await made.pluginsManager.serve({ callId: 'c1', caller: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 }) as SecurityList
    expect(list.requests[0]).toMatchObject({ kind: 'plugin.approve', plugin: 'alpha' })
    expect(list.requests[0].notes).toEqual(['Version 1.0.0', 'It asks for: luoshu.read on "notes/**"', 'It asks for: net.fetch to "example.com"', 'Class 4, Powerful: it can read notes and reach the network, so it could send notes out'])
  })

  it('quotes each target, topic and variable its manifest names', async () => {
    const asks: Capability[] = [
      { type: 'plugin.call', targets: ['notes'] }, { type: 'events.subscribe', topics: ['notes.saved'] },
      { type: 'exec', commands: [['git', 'status']], env: ['HOME'] },
    ]
    const made = await harness({ folder: { alpha: worker('alpha', { capabilities: asks }) } })
    await made.pluginsManager.start()
    const list = await made.pluginsManager.serve({ callId: 'c1', caller: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 }) as SecurityList
    expect(list.requests[0].notes.slice(0, 4)).toEqual([
      'Version 1.0.0', 'It asks for: plugin.call to "notes"', 'It asks for: events.subscribe to "notes.saved"',
      'It asks for: exec of ["git","status"] with "HOME" from your environment',
    ])
  })

  it('says when it asks for nothing', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') } })
    await made.pluginsManager.start()
    const list = await made.pluginsManager.serve({ callId: 'c1', caller: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 }) as SecurityList
    expect(list.requests[0].notes).toEqual(['Version 1.0.0', 'It asks for nothing', 'Class 0, Contained'])
  })
})

// With the log down, the stopped mode's stop recording waited for a record the dead log could never take
describe('stopping recording with the log down', () => {
  it('applies though its own record was lost, since the log is what it switches off', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'recording' }, editor))
    made.link.landing = () => 'lost'
    await made.pluginsManager.confirm(id, { typed: 'recording' })
    expect(made.modules.state('recording')).toBe('off')
  })

  it('applies though the drain before its record threw, with how much waited unknown', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'recording' }, editor))
    made.link.drain = async () => { throw new Error('broken') }
    await made.pluginsManager.confirm(id, { typed: 'recording' })
    expect(made.modules.state('recording')).toBe('off')
    expect(made.link.events('security.confirm')).toMatchObject([{ target: 'recording', unwritten: null }])
  })

  it('lets the audit writer go again when the switch can\u2019t be written', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'recording' }, editor))
    made.store.writeSwitches = async () => { throw new Error('read-only') }
    expect(await code(made.pluginsManager.confirm(id, { typed: 'recording' }))).toBe('failed')
    expect(made.link.timeline.slice(-2)).toEqual(expect.arrayContaining(['resume']))
  })
})

// A record recording throws on counts as one that didn't land, so a change that waits on it applies nothing
describe('a record recording throws on', () => {
  const call = (caller: Caller, action: string) => ({ callId: 'c1', caller, action, args: undefined, deadline: Date.now() + 30_000 })

  it('fails the Confirm and applies nothing', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    made.link.landing = () => { throw new Error('broken') }
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('failed')
    expect((await made.pluginsManager.serve(call(trusted, 'security.list')) as SecurityList).switches.skipVerification).toBe(false)
  })
})

// The security view is a core module in the path of every held change. Off, every change applies unasked and the
// editor window may only switch it on again. A throw applies nothing
describe('the security view', () => {
  const list = async (made: Awaited<ReturnType<typeof harness>>) =>
    (await made.pluginsManager.serve({ callId: 'c1', caller: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 })) as SecurityList

  it('is a row of its own, a security control switched off only in a Confirm with its id typed', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    expect((await list(made)).plugins.find(row => row.id === 'security-view')).toMatchObject({ from: 'core', state: 'ready', security: true, on: true })
    const id = held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'security-view' }, trusted))
    expect((await list(made)).requests.find(request => request.id === id)?.type).toBe('security-view')
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('invalid')
    await made.pluginsManager.confirm(id, { typed: 'security-view' })
    expect(made.modules.state('security-view')).toBe('off')
  })

  it('applies a widening change from the trusted window unasked once off, its record landing first', async () => {
    const made = await harness({ switches: { off: ['security-view'] } })
    await made.pluginsManager.start()
    expect(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, trusted)).toEqual({ applied: true })
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(true)
    const at = made.link.timeline.indexOf('record security.confirm')
    expect(at).toBeGreaterThan(-1)
    expect(made.link.events('security.confirm')).toMatchObject([{ kind: 'skipVerification', by: 'view-off' }])
    expect(made.pluginsManager.pending()).toEqual([])
  })

  it('takes from the editor window only the change that switches it on again once off, which applies at once', async () => {
    const made = await harness({ switches: { off: ['security-view'] } })
    await made.pluginsManager.start()
    expect(await code(made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))).toBe('not-granted')
    expect(await code(made.pluginsManager.request({ kind: 'plugin.off', plugin: 'search' }, editor))).toBe('not-granted')
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
    expect(await made.pluginsManager.request({ kind: 'plugin.on', plugin: 'security-view' }, editor)).toEqual({ applied: true })
    expect(made.modules.state('security-view')).toBe('on')
  })

  it('counts a Confirm of a notice the core raised with no delay and no word once off', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, switches: { off: ['security-view'] }, pluginsManager: { confirmDelayMs: 60_000 } })
    await made.pluginsManager.start()
    const [notice] = made.pluginsManager.pending()
    expect(notice).toMatchObject({ kind: 'plugin.approve', plugin: 'alpha' })
    await made.pluginsManager.confirm(notice.id, {})
    expect((await stateIn(made.dataDir)).plugins.alpha).toBeDefined()
    expect(made.pluginsManager.pending()).toEqual([])
  })

  // No security control goes off while nothing asks for its typed word
  it('refuses switching any security control off once off, from either window, and still switches itself on again', async () => {
    const made = await harness({ switches: { off: ['security-view'] } })
    await made.pluginsManager.start()
    for (const plugin of ['gate', 'grant-risk-classifier', 'flood-control', 'recording', 'security-view']) {
      for (const from of [trusted, editor]) {
        expect(await code(made.pluginsManager.request({ kind: 'plugin.off', plugin }, from))).toBe('not-granted')
      }
    }
    expect(made.modules.state('gate')).toBe('on')
    expect(made.modules.state('recording')).toBe('on')
    expect(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'storage' }, trusted)).toEqual({ applied: true })
    expect(await made.pluginsManager.request({ kind: 'plugin.on', plugin: 'security-view' }, trusted)).toEqual({ applied: true })
    expect(made.modules.state('security-view')).toBe('on')
  })

  it('keeps a security control\'s off held, typed or not, once the view went off', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const gate = held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'gate' }, trusted))
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'security-view' })
    expect(await code(made.pluginsManager.confirm(gate, { typed: 'gate' }))).toBe('not-granted')
    expect(made.modules.state('gate')).toBe('on')
    expect(await code(made.pluginsManager.confirm(gate, {}))).toBe('not-granted')
    expect(made.pluginsManager.pending().map(request => request.id)).toContain(gate)
  })

  // The heartbeat is no security control, but switching it off leaves a hang unwatched, so it waits for one Confirm
  it('holds the heartbeat\'s off for one Confirm with no word, from either window, and switches it on again at once', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'heartbeat' }, editor))
    const id = held(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'heartbeat' }, trusted))
    expect((await list(made)).requests.find(request => request.id === id)?.type).toBe(null)
    await made.pluginsManager.confirm(id, {})
    expect(made.modules.state('heartbeat')).toBe('off')
    expect(await made.pluginsManager.request({ kind: 'plugin.on', plugin: 'heartbeat' }, editor)).toEqual({ applied: true })
    expect(made.modules.state('heartbeat')).toBe('on')
  })

  it('applies the heartbeat\'s off unasked from the trusted window once the view is off', async () => {
    const made = await harness({ switches: { off: ['security-view'] } })
    await made.pluginsManager.start()
    expect(await code(made.pluginsManager.request({ kind: 'plugin.off', plugin: 'heartbeat' }, editor))).toBe('not-granted')
    expect(await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'heartbeat' }, trusted)).toEqual({ applied: true })
    expect(made.modules.state('heartbeat')).toBe('off')
  })

  it('applies nothing and answers failed for a change it throws on, with the fault recorded', async () => {
    const securityView = createSecurityView()
    securityView.asked = () => { throw new Error('broken') }
    const made = await harness({ modules: { securityView } })
    await made.pluginsManager.start()
    expect(await code(made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))).toBe('failed')
    expect(await code(made.pluginsManager.request({ kind: 'confirmOff', on: false }, editor))).toBe('failed')
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
    expect(made.pluginsManager.pending()).toEqual([])
    expect(made.link.events('fault')).toContainEqual({ plugin: 'security-view', step: 'asked' })
  })

  it('applies nothing and answers failed for a Confirm it throws on', async () => {
    const securityView = createSecurityView()
    securityView.confirms = () => { throw new Error('broken') }
    const made = await harness({ modules: { securityView } })
    await made.pluginsManager.start()
    const id = held(await made.pluginsManager.request({ kind: 'skipVerification', on: true }, editor))
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('failed')
    expect((await stateIn(made.dataDir)).switches.skipVerification).toBe(false)
    expect(made.link.events('fault')).toContainEqual({ plugin: 'security-view', step: 'confirms' })
  })
})
