import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { HeldRequest, SecurityList } from '../api/actions.ts'
import { capabilityKey, type Capability } from '../api/capabilities.ts'
import type { Change } from '../api/changes.ts'
import type { Caller } from '../api/envelope.ts'
import path from 'node:path'
import {
  allowAll, cleanup, coreInstall, entryFor, filesFor, harness, hostManifest, reasonOf, stateOf, until, workerManifest, writeFolder, type Files,
} from './loader-fakes.ts'

afterEach(cleanup)

const read: Capability = { type: 'luoshu.read', paths: ['notes/**'] }
const fetchOne: Capability = { type: 'net.fetch', hosts: ['example.com'] }
const exec: Capability = { type: 'exec', commands: [['git', 'status']], env: [] }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const editor: Caller = { kind: 'window', role: 'editor', n: 1 }

const worker = (id: string, capabilities: Capability[] = []): Files => filesFor(workerManifest(id, { capabilities }))
const withCapabilities = () => ({ ...coreInstall(), capabilities: { files: filesFor(hostManifest('capabilities')) } })
const call = (caller: Caller, action: string, args?: unknown) => ({ callId: `c${Math.random()}`, caller, action, args, deadline: Date.now() + 30_000 })

async function listed(made: Awaited<ReturnType<typeof harness>>): Promise<SecurityList> {
  return await made.loader.serve(call(trusted, 'security.list')) as SecurityList
}

async function approved(made: Awaited<ReturnType<typeof harness>>, id: string): Promise<HeldRequest> {
  await made.loader.request({ kind: 'plugin.approve', plugin: id }, editor)
  const request = (await listed(made)).requests.find(held => held.kind === 'plugin.approve' && held.plugin === id)!
  await made.loader.apply({ kind: 'plugin.approve', plugin: id })
  return request
}

describe('an approval', () => {
  it('writes the class and the items that ask at first use from the capabilities slot, and its screen under the core\'s words', async () => {
    const made = await harness({ install: withCapabilities(), folder: { reader: worker('reader', [read, fetchOne, exec]) } })
    await made.loader.start()
    const request = await approved(made, 'reader')
    expect(request.notes).toContain('Class 4, Powerful: it can read notes and reach the network, so it could send notes out')
    const entry = (await made.store.load()).state.plugins.reader
    expect(entry.class).toBe(4)
    expect(entry.firstUse).toEqual([fetchOne, exec])
  })

  it('counts what a plugin reaches through plugin.call, followed in turn, and names a network plugin\'s readers', async () => {
    const made = await harness({
      install: withCapabilities(),
      folder: { sender: worker('sender', [fetchOne]), middle: worker('middle'), notes: worker('notes', [read, { type: 'plugin.call', targets: ['middle'] }]) },
      entries: {
        sender: root => entryFor(root, { granted: [fetchOne], class: 3 }),
        middle: root => entryFor(root, { granted: [{ type: 'plugin.call', targets: ['sender'] }], class: 3 }),
      },
    })
    await made.loader.start()
    await approved(made, 'notes')
    const entry = (await made.store.load()).state.plugins.notes
    expect(entry.class).toBe(4)
    expect(entry.firstUse).toEqual([{ type: 'plugin.call', targets: ['middle'] }])
  })

  it('writes a null class and every item at first use with the slot down, and says so', async () => {
    const made = await harness({ folder: { reader: worker('reader', [read, { type: 'storage' }]) } })
    await made.loader.start()
    expect(made.loader.slot('capabilities')).toBe('absent')
    const request = await approved(made, 'reader')
    expect(request.notes).toContain('The capabilities plugin is down, so the class is unknown and counted as 4: every item asks at its first use')
    const entry = (await made.store.load()).state.plugins.reader
    expect(entry.class).toBeNull()
    expect(entry.firstUse).toEqual([read, { type: 'storage' }])
  })
})

describe('a network plugin’s approval', () => {
  it('names the plugins that read and can reach it', async () => {
    const made = await harness({
      install: withCapabilities(),
      folder: { sync: worker('sync', [fetchOne]), notes: worker('notes') },
      entries: { notes: root => entryFor(root, { granted: [read, { type: 'plugin.call', targets: ['sync'] }], class: 1 }) },
    })
    await made.loader.start()
    const request = await approved(made, 'sync')
    expect(request.notes).toContain('Plugins that read and are connected to it through plugin.call: notes')
  })
})

describe('a staged update', () => {
  async function updating(entry: object, install = withCapabilities(), next: Capability[] = []) {
    const made = await harness({ install, folder: { calc: worker('calc') }, entries: { calc: root => entryFor(root, { granted: [], ...entry }) } })
    await made.loader.start()
    const dir = path.join(made.dataDir, 'staging', 'calc-next')
    await writeFolder(dir, filesFor(workerManifest('calc', { version: '1.1.0', capabilities: next })))
    return { made, outcome: await made.loader.update('calc', dir) }
  }

  it('loads on its own for a class 0 plugin with views while the slot is on', async () => {
    const { outcome } = await updating({ class: 0, granted: [{ type: 'ui.view' }] }, withCapabilities(), [{ type: 'ui.view' }])
    expect(outcome).toEqual({ outcome: 'applied' })
  })

  it('loads on its own for a class 0 plugin while the slot is on, its record first', async () => {
    const { made, outcome } = await updating({ class: 0 })
    expect(outcome).toEqual({ outcome: 'applied' })
    expect(made.loader.pending()).toEqual([])
    expect(made.link.events('plugin.updated')).toEqual([{ plugin: 'calc', from: '1.0.0', to: '1.1.0' }])
  })

  it.each([
    ['a class above 0', { class: 1 }, withCapabilities(), []],
    ['a null class, which counts as 4', { class: null }, withCapabilities(), []],
    ['a class 0 plugin asking for a grant it doesn’t hold', { class: 0 }, withCapabilities(), [{ type: 'storage' }]],
    ['the slot down', { class: 0 }, coreInstall(), []],
    // A layout draws the whole window, so a new one never takes its place unasked
    ['a class 0 plugin holding ui.layout', { class: 0, granted: [{ type: 'ui.layout' }] }, withCapabilities(), [{ type: 'ui.layout' }]],
  ] as [string, object, ReturnType<typeof withCapabilities>, Capability[]][])('waits for the Confirm with %s', async (_name, entry, install, next) => {
    const { made, outcome } = await updating(entry, install, next)
    expect(outcome).toMatchObject({ outcome: 'confirm' })
    expect(made.loader.pending()).toMatchObject([{ kind: 'plugin.update', plugin: 'calc' }])
  })
})

describe('a first-party copy', () => {
  const bundled = (files: Files) => ({ files, firstParty: true })

  it('takes its class from the slot, which starts before the copy', async () => {
    const made = await harness({ install: { ...withCapabilities(), git: bundled(worker('git', [read])) } })
    await made.loader.start()
    const entry = (await made.store.load()).state.plugins.git
    expect(entry.class).toBe(1)
    expect(entry.firstUse).toBeUndefined()
  })

  it('asks at the first use of every item with the slot down', async () => {
    const made = await harness({ install: { ...coreInstall(), git: bundled(worker('git', [read, { type: 'storage' }])) } })
    await made.loader.start()
    const entry = (await made.store.load()).state.plugins.git
    expect(entry.class).toBeNull()
    expect(entry.firstUse).toEqual([read, { type: 'storage' }])
  })
})

describe('the plugins connected through plugin.call', () => {
  it('count both ways, so a reader and a network plugin sharing a callee are class 4, the callee too', async () => {
    const bridge = { type: 'plugin.call', targets: ['bridge'] } as Capability
    const made = await harness({
      install: withCapabilities(),
      folder: { reader: worker('reader'), sender: worker('sender', [fetchOne, bridge]), bridge: worker('bridge', [{ type: 'storage' }]) },
      entries: {
        reader: root => entryFor(root, { granted: [read, bridge], class: 1 }),
        bridge: root => entryFor(root, { granted: [{ type: 'storage' }], class: 0 }),
      },
    })
    await made.loader.start()
    const request = await approved(made, 'sender')
    expect((await made.store.load()).state.plugins.sender.class).toBe(4)
    expect(request.notes).toContain('Plugins that read and are connected to it through plugin.call: reader')
    await made.loader.apply({ kind: 'grant.widen', plugin: 'bridge', capability: { type: 'ui.view' } })
    expect((await made.store.load()).state.plugins.bridge.class).toBe(4)
  })
})

// Publishing needs no grant, so a plugin can signal every plugin that hears its topics by what and when it publishes.
// Data moves one way along a subscription: from the plugin that owns the topic to the plugin that hears it
describe('a subscription to another plugin\'s topics', () => {
  const hears = (...topics: string[]): Capability => ({ type: 'events.subscribe', topics })
  const writeAll: Capability = { type: 'luoshu.write', paths: ['**'] }
  const calls: Capability = { type: 'plugin.call', targets: ['reader'] }

  // What id's approval writes and shows, every other plugin approved before it with what it holds, beside a luoshu
  async function approval(plugins: Record<string, Capability[]>, id: string) {
    const made = await harness({
      install: { ...withCapabilities(), luoshu: { files: filesFor(hostManifest('luoshu')) } },
      folder: Object.fromEntries(Object.entries(plugins).map(([other, granted]) => [other, worker(other, granted)])),
      entries: Object.fromEntries(Object.entries(plugins).filter(([other]) => other !== id)
        .map(([other, granted]) => [other, (root: string) => entryFor(root, { granted, class: 0 })])),
    })
    await made.loader.start()
    const request = await approved(made, id)
    const entry = (await made.store.load()).state.plugins[id]
    return { class: entry.class, firstUse: entry.firstUse ?? [], notes: request.notes }
  }

  it('pairs a reader that speaks with a network plugin that hears it, both class 4, the subscription asking at first use', async () => {
    const plugins = { reader: [read], sender: [fetchOne, hears('reader.done'), hears('luoshu.changed')] }
    const sender = await approval(plugins, 'sender')
    expect(sender.class).toBe(4)
    expect(sender.firstUse).toEqual([fetchOne, hears('reader.done')])
    expect(sender.notes).toContain('Plugins that read and can reach it through events: reader')
    const reader = await approval(plugins, 'reader')
    expect(reader.class).toBe(4)
    expect(reader.firstUse).toEqual([])
    expect(reader.notes).toContain('Plugins with network it can reach through events: sender')
  })

  it('leaves a network plugin that speaks and a reader that hears it at their own classes, since nothing moves back', async () => {
    const plugins = { sender: [fetchOne], reader: [read, hears('sender.sent')] }
    const reader = await approval(plugins, 'reader')
    expect(reader.class).toBe(1)
    expect(reader.firstUse).toEqual([])
    expect(reader.notes.filter(line => line.includes('through events'))).toEqual([])
    expect((await approval(plugins, 'sender')).class).toBe(3)
  })

  it('gives the listener none of the speaker\'s grants, so a plugin with views hearing a class 4 plugin stays class 0', async () => {
    const viewer = await approval({ writer: [writeAll], viewer: [{ type: 'ui.view' }, hears('writer.saved')] }, 'viewer')
    expect(viewer.class).toBe(0)
    expect(viewer.firstUse).toEqual([])
  })

  it('leaves two plugins hearing one speaker that holds nothing, a reader and a network plugin hearing the luoshu, unpaired', async () => {
    const plugins = { reader: [read, hears('luoshu.changed')], sender: [fetchOne, hears('luoshu.changed')] }
    expect((await approval(plugins, 'reader')).class).toBe(1)
    expect((await approval(plugins, 'sender')).class).toBe(3)
  })

  it('is followed in turn, so a reader, a plugin hearing it that speaks on and a network plugin hearing that are class 4', async () => {
    const plugins = { reader: [read], middle: [hears('reader.done')], sender: [fetchOne, hears('middle.done')] }
    expect(await approval(plugins, 'reader')).toMatchObject({ class: 4, firstUse: [] })
    expect(await approval(plugins, 'middle')).toMatchObject({ class: 4, firstUse: [hears('reader.done')] })
    const sender = await approval(plugins, 'sender')
    expect(sender).toMatchObject({ class: 4, firstUse: [fetchOne, hears('middle.done')] })
    expect(sender.notes).toContain('Plugins that read and can reach it through events: reader')
  })

  it('is followed with plugin.call, so a network plugin hearing a reader\'s caller is class 4, the caller and the reader too', async () => {
    const plugins = { reader: [read], middle: [calls], sender: [fetchOne, hears('middle.done')] }
    expect(await approval(plugins, 'sender')).toMatchObject({ class: 4, firstUse: [fetchOne, hears('middle.done')] })
    expect(await approval(plugins, 'middle')).toMatchObject({ class: 4, firstUse: [calls] })
    expect(await approval(plugins, 'reader')).toMatchObject({ class: 4, firstUse: [] })
  })

  it('links nothing for a plugin hearing only its own topics', async () => {
    const sender = await approval({ reader: [read], sender: [fetchOne, hears('sender.sent')] }, 'sender')
    expect(sender.class).toBe(3)
    expect(sender.firstUse).toEqual([])
  })
})

describe('a widened or narrowed grant', () => {
  it('adds an item that asks at first use, takes it off when the grant goes, and keeps the class in step', async () => {
    const made = await harness({ install: withCapabilities(), folder: { tool: worker('tool') }, entries: { tool: root => entryFor(root, { granted: [read], class: 1 }) } })
    await made.loader.start()
    await made.loader.apply({ kind: 'grant.widen', plugin: 'tool', capability: exec })
    let entry = (await made.store.load()).state.plugins.tool
    expect(entry.class).toBe(4)
    expect(entry.firstUse).toEqual([exec])
    await made.loader.apply({ kind: 'grant.narrow', plugin: 'tool', capability: exec })
    entry = (await made.store.load()).state.plugins.tool
    expect(entry.class).toBe(1)
    expect(entry.firstUse ?? []).toEqual([])
  })
})

describe('the plugin list', () => {
  it('shows each plugin-folder plugin\'s class, null for none known', async () => {
    const made = await harness({
      install: withCapabilities(),
      folder: { tool: worker('tool'), other: worker('other') },
      entries: { tool: root => entryFor(root, { class: 2 }), other: root => entryFor(root, { class: null }) },
    })
    await made.loader.start()
    const plugins = (await listed(made)).plugins
    expect(plugins.find(plugin => plugin.id === 'tool')?.class).toBe(2)
    expect(plugins.find(plugin => plugin.id === 'other')?.class).toBeNull()
    expect(plugins.find(plugin => plugin.id === 'gate')?.class).toBeNull()
  })
})

describe('the capabilities slot', () => {
  it('stops hetu when its module gives no capabilities role', async () => {
    const made = await harness({ install: withCapabilities(), behave: { capabilities: { exports: {} } } })
    await made.loader.start()
    await until(() => stateOf(made.loader, 'capabilities') === 'failed')
    expect(reasonOf(made.loader, 'capabilities')).toBe('no-role')
  })
})

describe('what the class rests on', () => {
  it('reads the class again before a class 0 update loads on its own, so one now connected to more waits for the Confirm', async () => {
    const call: Capability = { type: 'plugin.call', targets: ['runner'] }
    const made = await harness({
      install: withCapabilities(),
      folder: { calc: worker('calc'), runner: worker('runner') },
      entries: {
        calc: root => entryFor(root, { granted: [call], class: 0 }),
        runner: root => entryFor(root, { granted: [exec], class: 4 }),
      },
    })
    await made.loader.start()
    const dir = path.join(made.dataDir, 'staging', 'calc-next')
    await writeFolder(dir, filesFor(workerManifest('calc', { version: '1.1.0', capabilities: [call] })))
    expect(await made.loader.update('calc', dir)).toMatchObject({ outcome: 'confirm' })
  })

  it('reads the class again when an update applies', async () => {
    const call: Capability = { type: 'plugin.call', targets: ['runner'] }
    const made = await harness({
      install: withCapabilities(),
      folder: { calc: worker('calc'), runner: worker('runner') },
      entries: {
        calc: root => entryFor(root, { granted: [call], class: 1 }),
        runner: root => entryFor(root, { granted: [exec], class: 4 }),
      },
    })
    await made.loader.start()
    const dir = path.join(made.dataDir, 'staging', 'calc-next')
    await writeFolder(dir, filesFor(workerManifest('calc', { version: '1.1.0', capabilities: [call] })))
    await made.loader.update('calc', dir)
    await made.loader.apply({ kind: 'plugin.update', plugin: 'calc' })
    expect((await made.store.load()).state.plugins.calc.class).toBe(4)
  })

  it.each([
    ['a class past 4', { classify: () => 7, firstUse: () => [], screen: () => [] }],
    ['a class that isn’t whole', { classify: () => 1.5, firstUse: () => [], screen: () => [] }],
    ['a throw', { classify: () => { throw new Error('broken') }, firstUse: () => [], screen: () => [] }],
    ['first use that isn’t a list', { classify: () => 1, firstUse: () => 'all', screen: () => [] }],
  ])('takes the slot as down for %s: a null class and every item at first use', async (_name, capabilities) => {
    const made = await harness({
      install: withCapabilities(),
      behave: { capabilities: { exports: { capabilities: capabilities as never } } },
      folder: { reader: worker('reader', [read]) },
    })
    await made.loader.start()
    await approved(made, 'reader')
    const entry = (await made.store.load()).state.plugins.reader
    expect(entry.class).toBeNull()
    expect(entry.firstUse).toEqual([read])
  })
})

describe('a new copy of a first-party plugin', () => {
  const bundled = (files: Files) => ({ files, firstParty: true })

  async function copied(base: string | undefined, capabilities: Capability[], version: string) {
    const made = await harness({ ...(base === undefined ? {} : { base }), install: { ...withCapabilities(), git: bundled(filesFor(workerManifest('git', { version, capabilities }))) } })
    await made.loader.start()
    return made
  }

  it('asks again for an item that never asked before, once the new grants make it close a pair', async () => {
    const first = await copied(undefined, [fetchOne], '1.0.0')
    expect((await first.store.load()).state.plugins.git.firstUse).toBeUndefined()
    await first.loader.shutdown()
    const second = await copied(first.base, [fetchOne, read], '1.1.0')
    const entry = (await second.store.load()).state.plugins.git
    expect(entry.class).toBe(4)
    expect(entry.firstUse).toEqual([fetchOne])
  })

  it('keeps an item asking that asked before and that the human never confirmed', async () => {
    const first = await copied(undefined, [read, fetchOne], '1.0.0')
    expect((await first.store.load()).state.plugins.git.firstUse).toEqual([fetchOne])
    await first.loader.shutdown()
    const second = await copied(first.base, [read, fetchOne, { type: 'storage' }], '1.1.0')
    expect((await second.store.load()).state.plugins.git.firstUse).toEqual([fetchOne])
  })

  it('keeps an item the human confirmed from asking again', async () => {
    const first = await copied(undefined, [read, fetchOne], '1.0.0')
    expect((await first.store.load()).state.plugins.git.firstUse).toEqual([fetchOne])
    await first.loader.apply({ kind: 'item.on', plugin: 'git', capability: fetchOne })
    await first.loader.shutdown()
    const second = await copied(first.base, [read, fetchOne, { type: 'storage' }], '1.1.0')
    expect((await second.store.load()).state.plugins.git.firstUse).toBeUndefined()
  })
})

// After a change to one plugin every other plugin whose links it changes is classed again and its entry takes the new
// class and first-use list. A move up is named on the Confirm of the request that causes it, a move down is stored
// without a word
describe('a class another plugin\'s change moves', () => {
  type Made = Awaited<ReturnType<typeof harness>>
  const hears = (...topics: string[]): Capability => ({ type: 'events.subscribe', topics })
  const calls = (...targets: string[]): Capability => ({ type: 'plugin.call', targets })
  const commit: Capability = { type: 'history', access: 'commit', paths: ['notes/**'] }
  const entryFile = (made: Made, id: string) => readFile(path.join(made.dataDir, 'state', 'plugins', `${id}.json`))
  const stored = async (made: Made, id: string) => (await made.store.load()).state.plugins[id]

  // The notes on the Confirm of a window's request for change, the change applied after
  async function confirmed(made: Made, change: Change): Promise<string[]> {
    await made.loader.request(change, editor)
    const request = (await listed(made)).requests.find(held => held.kind === change.kind && held.plugin === ('plugin' in change ? change.plugin : null))!
    await made.loader.apply(change)
    return request.notes
  }

  // Two plugins calling each other's way along a chain, each with what it holds and its stored class
  async function plugins(entries: Record<string, [Capability[], number]>): Promise<Made> {
    const made = await harness({
      install: withCapabilities(),
      folder: Object.fromEntries(Object.keys(entries).map(id => [id, worker(id)])),
      entries: Object.fromEntries(Object.entries(entries).map(([id, [granted, n]]) => [id, (root: string) => entryFor(root, { granted, class: n })])),
    })
    await made.loader.start()
    return made
  }

  // A network plugin hearing a reader's topic, approved while the reader isn't installed, beside the reader's folder
  async function listening(gate = allowAll()): Promise<Made> {
    const made = await harness({
      install: withCapabilities(),
      behave: { gate: { exports: { gate } } },
      folder: { listener: worker('listener', [fetchOne, hears('reader.done')]), reader: worker('reader', [read]) },
    })
    await made.loader.start()
    await approved(made, 'listener')
    return made
  }

  it('raises a network listener approved before the reader it hears to 4, named on the reader\'s Confirm, its fetch and subscription asking', async () => {
    const gate = allowAll()
    const made = await listening(gate)
    expect((await stored(made, 'listener')).class).toBe(3)
    expect((await stored(made, 'listener')).firstUse).toBeUndefined()
    const request = await approved(made, 'reader')
    expect(request.notes).toContain('Raises listener from class 3, Network to class 4, Powerful')
    const entry = await stored(made, 'listener')
    expect(entry.class).toBe(4)
    expect(entry.firstUse).toEqual([fetchOne, hears('reader.done')])
    expect(gate.seen.at(-1)!.plugins.listener.map(item => item.firstUse)).toEqual([true, true])
    const asked = made.loader.asks.raise(capabilityKey(fetchOne), {
      stage: 'canonical', caller: { kind: 'plugin', id: 'listener', half: 'worker', incarnation: 1 }, action: 'net.fetch',
      capability: 'net.fetch', scope: {},
    })
    expect(typeof asked).toBe('string')
  })

  it('names on a widen\'s Confirm the caller the widened grant lifts, with both classes and stores its new class', async () => {
    const made = await plugins({ a: [[read, calls('b')], 1], b: [[{ type: 'storage' }], 0] })
    const notes = await confirmed(made, { kind: 'grant.widen', plugin: 'b', capability: fetchOne })
    expect(notes).toContain('Raises a from class 1, Reader to class 4, Powerful')
    expect(await stored(made, 'a')).toMatchObject({ class: 4, firstUse: [calls('b')] })
  })

  it('names a move up below 4 and adds no item that asks at first use', async () => {
    const made = await plugins({ a: [[commit, calls('b')], 2], b: [[{ type: 'storage' }], 0] })
    const notes = await confirmed(made, { kind: 'grant.widen', plugin: 'b', capability: fetchOne })
    expect(notes).toContain('Raises a from class 2, Writer to class 3, Network')
    const entry = await stored(made, 'a')
    expect(entry.class).toBe(3)
    expect(entry.firstUse).toBeUndefined()
  })

  it('names a move out of 0, after which that plugin\'s update waits for the Confirm', async () => {
    const made = await plugins({ a: [[{ type: 'ui.view' }, calls('b')], 0], b: [[{ type: 'storage' }], 0] })
    const notes = await confirmed(made, { kind: 'grant.widen', plugin: 'b', capability: commit })
    expect(notes).toContain('Raises a from class 0, Contained to class 2, Writer')
    expect((await stored(made, 'a')).class).toBe(2)
    const dir = path.join(made.dataDir, 'staging', 'a-next')
    await writeFolder(dir, filesFor(workerManifest('a', { version: '1.1.0', capabilities: [{ type: 'ui.view' }, calls('b')] })))
    expect(await made.loader.update('a', dir)).toMatchObject({ outcome: 'confirm' })
  })

  it('stores a move down without a word once the plugin that lifted it goes and the list shrinks', async () => {
    const made = await listening()
    await approved(made, 'reader')
    expect(await stored(made, 'listener')).toMatchObject({ class: 4, firstUse: [fetchOne, hears('reader.done')] })
    const notes = await confirmed(made, { kind: 'plugin.remove', plugin: 'reader' })
    expect(notes.filter(line => line.includes('listener'))).toEqual([])
    const entry = await stored(made, 'listener')
    expect(entry.class).toBe(3)
    expect(entry.firstUse).toBeUndefined()
  })

  it('stores a move down once the grant that lifted it is narrowed', async () => {
    const made = await plugins({ a: [[read, calls('b')], 1], b: [[{ type: 'storage' }], 0] })
    await made.loader.apply({ kind: 'grant.widen', plugin: 'b', capability: fetchOne })
    expect(await stored(made, 'a')).toMatchObject({ class: 4, firstUse: [calls('b')] })
    await made.loader.apply({ kind: 'grant.narrow', plugin: 'b', capability: fetchOne })
    const entry = await stored(made, 'a')
    expect(entry.class).toBe(1)
    expect(entry.firstUse).toBeUndefined()
  })

  it('follows the chain, so a plugin two links away moves too', async () => {
    const made = await plugins({ a: [[read, calls('b')], 1], b: [[calls('c')], 1], c: [[{ type: 'storage' }], 1] })
    const notes = await confirmed(made, { kind: 'grant.widen', plugin: 'c', capability: fetchOne })
    expect(notes).toContain('Raises a from class 1, Reader to class 4, Powerful')
    expect(notes).toContain('Raises b from class 1, Reader to class 4, Powerful')
    expect(await stored(made, 'a')).toMatchObject({ class: 4, firstUse: [calls('b')] })
    expect(await stored(made, 'b')).toMatchObject({ class: 4, firstUse: [calls('c')] })
  })

  it('leaves the entry of a plugin whose links didn\'t change byte for byte, even one whose stored class is out of date', async () => {
    const made = await harness({
      install: withCapabilities(),
      folder: { listener: worker('listener', [fetchOne, hears('reader.done')]), reader: worker('reader', [read]), lone: worker('lone') },
      entries: { lone: root => entryFor(root, { granted: [read, calls('far')], class: 2, firstUse: [read] }) },
    })
    await made.loader.start()
    const before = await entryFile(made, 'lone')
    await approved(made, 'listener')
    await approved(made, 'reader')
    expect((await stored(made, 'listener')).class).toBe(4)
    expect((await entryFile(made, 'lone')).equals(before)).toBe(true)
  })

  it('writes a raised class before the change and a lowered one after, so a change whose own write fails leaves the class high', async () => {
    const made = await listening()
    const write = made.store.writePlugin.bind(made.store)
    made.store.writePlugin = async (id, entry) => (id === 'reader' ? Promise.reject(new Error('disk full')) : write(id, entry))
    await expect(made.loader.apply({ kind: 'plugin.approve', plugin: 'reader' })).rejects.toThrow('disk full')
    expect(await stored(made, 'listener')).toMatchObject({ class: 4, firstUse: [fetchOne, hears('reader.done')] })
    made.store.writePlugin = write
    await made.loader.apply({ kind: 'plugin.approve', plugin: 'reader' })
    const remove = made.store.removePlugin.bind(made.store)
    made.store.removePlugin = async () => Promise.reject(new Error('disk full'))
    await expect(made.loader.apply({ kind: 'plugin.remove', plugin: 'reader' })).rejects.toThrow('disk full')
    made.store.removePlugin = remove
    expect((await stored(made, 'listener')).class).toBe(4)
  })

  it('replaces the class and the list with no Confirm on screen, for a first-party copy at start', async () => {
    const made = await harness({
      install: { ...withCapabilities(), git: { files: worker('git', [fetchOne]), firstParty: true } },
      folder: { notes: worker('notes') },
      entries: { notes: root => entryFor(root, { granted: [read, calls('git')], class: 1 }) },
    })
    await made.loader.start()
    expect((await stored(made, 'git')).class).toBe(4)
    expect(await stored(made, 'notes')).toMatchObject({ class: 4, firstUse: [calls('git')] })
  })
})
