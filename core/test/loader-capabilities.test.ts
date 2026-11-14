import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { HeldRequest, SecurityList } from '../api/actions.ts'
import { capabilityKey, type Capability } from '../api/capabilities.ts'
import type { Change } from '../api/changes.ts'
import type { Caller } from '../api/envelope.ts'
import path from 'node:path'
import type { Plugin, Switches } from '../backend/boot/state.ts'
import type { Capabilities } from '../api/slots.ts'
import {
  allowAll, cleanup, coreInstall, entryFor, filesFor, firstPartyEntry, harness, hashOf, hostManifest, reasonOf, stateOf, tempBase, tick, until,
  workerManifest, writeFolder, type Files, type Listing, type Message,
} from './loader-fakes.ts'
import { createCapabilities } from '../../plugins/capabilities/src/capabilities.ts'
import { createGate } from '../../plugins/gate/src/gate.ts'

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

const DOWN = 'The capabilities plugin is down, so the class is unknown and counted as 4: every item asks at its first use'

// A capabilities role that throws once broken, so its plugin stays ready while every classing fails
function breakable(): Capabilities & { broken: boolean } {
  const real = createCapabilities()
  const fail = (): never => {
    throw new Error('broken')
  }
  const role = {
    broken: false,
    classify: (...args: Parameters<Capabilities['classify']>) => (role.broken ? fail() : real.classify(...args)),
    firstUse: (...args: Parameters<Capabilities['firstUse']>) => (role.broken ? fail() : real.firstUse(...args)),
    screen: (...args: Parameters<Capabilities['screen']>) => (role.broken ? fail() : real.screen(...args)),
    moves: (...args: Parameters<NonNullable<Capabilities['moves']>>) => (role.broken ? fail() : real.moves!(...args)),
    alerts: (...args: Parameters<NonNullable<Capabilities['alerts']>>) => (role.broken ? fail() : real.alerts!(...args)),
  }
  return role
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
    ['a class above 0', { class: 1, granted: [read] }, withCapabilities(), [read]],
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

// The changed plugin's own list is classed as an approval of the same grants would class it, less the items the human
// confirmed under the grants it held: an item's ask rests on every item the plugin holds and on its links
describe('a widened or narrowed grant\'s own first-use list', () => {
  type Made = Awaited<ReturnType<typeof harness>>
  type Seeded = Record<string, [Capability[], number | null, Capability[]?]>
  const hears = (...topics: string[]): Capability => ({ type: 'events.subscribe', topics })
  const calls = (...targets: string[]): Capability => ({ type: 'plugin.call', targets })
  const fetchTwo: Capability = { type: 'net.fetch', hosts: ['example.org'] }
  const stored = async (made: Made, id: string) => (await made.store.load()).state.plugins[id]
  const shape = (entry: { class: number | null, firstUse?: Capability[] }) => ({ class: entry.class, firstUse: entry.firstUse ?? [] })
  const asking = (gate: ReturnType<typeof allowAll>, id: string) =>
    gate.seen.at(-1)!.plugins[id].filter(item => item.firstUse).map(item => item.capability)

  // Plugin-folder plugins each stored with what it holds, its class and its list, started with the slot on unless down
  async function seeded(entries: Seeded, gate = allowAll(), down = false): Promise<Made> {
    const made = await harness({
      install: down ? coreInstall() : withCapabilities(),
      behave: { gate: { exports: { gate } } },
      folder: Object.fromEntries(Object.keys(entries).map(id => [id, worker(id)])),
      entries: Object.fromEntries(Object.entries(entries).map(([id, [granted, n, firstUse]]) =>
        [id, (root: string) => entryFor(root, { granted, class: n, ...(firstUse === undefined ? {} : { firstUse }) })])),
    })
    await made.loader.start()
    return made
  }

  // The entry an approval of granted writes for id beside the other plugins as stored
  async function approvalOf(others: Seeded, id: string, granted: Capability[]) {
    const made = await harness({
      install: withCapabilities(),
      folder: { ...Object.fromEntries(Object.keys(others).map(other => [other, worker(other)])), [id]: worker(id, granted) },
      entries: Object.fromEntries(Object.entries(others).map(([other, [held, n]]) => [other, (root: string) => entryFor(root, { granted: held, class: n })])),
    })
    await made.loader.start()
    await approved(made, id)
    return await stored(made, id)
  }

  it.each([
    ['a read', {}, read, [fetchOne]],
    ['a plugin.call to a reader', { reader: [[read], 1] }, calls('reader'), [fetchOne]],
    ['a subscription to a reader\'s topic', { reader: [[read], 1] }, hears('reader.done'), [fetchOne, hears('reader.done')]],
  ] as [string, Seeded, Capability, Capability[]][])('makes the plugin\'s own fetch ask once a widened %s closes the pair, as an approval lists it', async (_name, others, capability, expected) => {
    const gate = allowAll()
    const made = await seeded({ ...others, sync: [[fetchOne], 3] }, gate)
    await made.loader.request({ kind: 'grant.widen', plugin: 'sync', capability }, editor)
    const request = (await listed(made)).requests.find(held => held.kind === 'grant.widen')!
    expect(request.notes).toContain('Class 4, Powerful: it can read notes and reach the network, so it could send notes out')
    await made.loader.apply({ kind: 'grant.widen', plugin: 'sync', capability })
    const entry = await stored(made, 'sync')
    expect(shape(entry)).toEqual({ class: 4, firstUse: expected })
    expect(asking(gate, 'sync')).toEqual(expected)
    expect(shape(entry)).toEqual(shape(await approvalOf(others, 'sync', [fetchOne, capability])))
  })

  it('adds a widened fetch that closes the pair on a plugin that already reads', async () => {
    const made = await seeded({ tool: [[read], 1] })
    await made.loader.apply({ kind: 'grant.widen', plugin: 'tool', capability: fetchOne })
    expect(shape(await stored(made, 'tool'))).toEqual({ class: 4, firstUse: [fetchOne] })
  })

  it('keeps a fetch the human confirmed from asking again when a widen adds another that asks', async () => {
    const gate = allowAll()
    const made = await seeded({ sync: [[read, fetchOne], 4, [fetchOne]] }, gate)
    await made.loader.apply({ kind: 'item.on', plugin: 'sync', capability: fetchOne })
    await made.loader.apply({ kind: 'grant.widen', plugin: 'sync', capability: fetchTwo })
    expect(shape(await stored(made, 'sync'))).toEqual({ class: 4, firstUse: [fetchTwo] })
    expect(asking(gate, 'sync')).toEqual([fetchTwo])
  })

  it('takes off a subscription a widened read makes stop asking and keeps the confirmed fetch confirmed', async () => {
    const made = await seeded({ reader: [[read], 4], sync: [[fetchOne, hears('reader.done')], 4, [fetchOne, hears('reader.done')]] })
    await made.loader.apply({ kind: 'item.on', plugin: 'sync', capability: fetchOne })
    await made.loader.apply({ kind: 'grant.widen', plugin: 'sync', capability: read })
    expect(shape(await stored(made, 'sync'))).toEqual({ class: 4, firstUse: [] })
  })

  it('makes the plugin.call that still brings the network in ask once the plugin\'s own fetch is narrowed', async () => {
    const gate = allowAll()
    const made = await seeded({ sender: [[fetchTwo], 3], tool: [[read, fetchOne, calls('sender')], 4, [fetchOne]] }, gate)
    await made.loader.apply({ kind: 'grant.narrow', plugin: 'tool', capability: fetchOne })
    expect(shape(await stored(made, 'tool'))).toEqual({ class: 4, firstUse: [calls('sender')] })
    expect(asking(gate, 'tool')).toEqual([calls('sender')])
  })

  it('stops the fetch asking once the read that paired it is narrowed, with no word', async () => {
    const gate = allowAll()
    const made = await seeded({ tool: [[read, fetchOne], 4, [fetchOne]] }, gate)
    await made.loader.apply({ kind: 'grant.narrow', plugin: 'tool', capability: read })
    const entry = await stored(made, 'tool')
    expect(entry.class).toBe(3)
    expect(entry.firstUse).toBeUndefined()
    expect(asking(gate, 'tool')).toEqual([])
  })

  it('makes every item ask with the slot down, as an approval and a copy do then', async () => {
    const made = await seeded({ tool: [[read], null, []] }, allowAll(), true)
    expect(made.loader.slot('capabilities')).toBe('absent')
    await made.loader.apply({ kind: 'grant.widen', plugin: 'tool', capability: { type: 'storage' } })
    expect(shape(await stored(made, 'tool'))).toEqual({ class: null, firstUse: [read, { type: 'storage' }] })
  })

  // An update keeps the grants, so under the same links the same items ask and a confirmed one stays confirmed
  it('keeps the list through an update, an item asking and a confirmed one confirmed', async () => {
    const made = await seeded({ tool: [[read, fetchOne, exec], 4, [fetchOne, exec]] })
    await made.loader.apply({ kind: 'item.on', plugin: 'tool', capability: exec })
    const dir = path.join(made.dataDir, 'staging', 'tool-next')
    await writeFolder(dir, filesFor(workerManifest('tool', { version: '1.1.0', capabilities: [read, fetchOne, exec] })))
    expect(await made.loader.update('tool', dir)).toMatchObject({ outcome: 'confirm' })
    await made.loader.apply({ kind: 'plugin.update', plugin: 'tool' })
    expect(await stored(made, 'tool')).toMatchObject({ version: '1.1.0', class: 4, firstUse: [fetchOne] })
  })

  // The widened plugin's own move is named with the line every other plugin a change moves gets, first, from the grants
  // the widen asks for and never twice. A move down and a class not known, counted as 4, show no line
  describe('the widened plugin\'s own move on the Confirm', () => {
    const raises = (notes: string[]) => notes.filter(line => line.startsWith('Raises'))
    const commit: Capability = { type: 'history', access: 'commit', paths: ['notes/**'] }

    // The notes on the Confirm of a widen the editor window asks for, the change not applied
    async function widening(made: Made, plugin: string, capability: Capability): Promise<string[]> {
      await made.loader.request({ kind: 'grant.widen', plugin, capability }, editor)
      return (await listed(made)).requests.find(held => held.kind === 'grant.widen' && held.plugin === plugin)!.notes
    }

    // tool stored with what it holds and a class the start can't correct, since its entry can't be written then
    async function stuck(granted: Capability[], n: number | null): Promise<Made> {
      const made = await harness({
        install: withCapabilities(), folder: { tool: worker('tool') }, entries: { tool: root => entryFor(root, { granted, class: n }) },
      })
      const write = made.store.writePlugin.bind(made.store)
      made.store.writePlugin = async (id, entry) => (id === 'tool' ? Promise.reject(new Error('disk full')) : write(id, entry))
      await made.loader.start()
      made.store.writePlugin = write
      expect((await stored(made, 'tool')).class).toBe(n)
      return made
    }

    it.each([
      ['a read', {}, read, []],
      ['a plugin.call to a reader', { reader: [[read], 1] }, calls('reader'), ['Raises reader from class 1, Reader to class 4, Powerful']],
      ['a subscription to a reader\'s topic', { reader: [[read], 1] }, hears('reader.done'), ['Raises reader from class 1, Reader to class 4, Powerful']],
    ] as [string, Seeded, Capability, string[]][])('names the plugin\'s own move into 4 once, before the others, when a widened %s closes the pair', async (_name, others, capability, theirs) => {
      const made = await seeded({ ...others, sync: [[fetchOne], 3] })
      const notes = await widening(made, 'sync', capability)
      expect(raises(notes)).toEqual(['Raises sync from class 3, Network to class 4, Powerful', ...theirs])
      expect((await stored(made, 'sync')).class).toBe(3)
    })

    it('names a move up below 4 and adds no item that asks at first use', async () => {
      const made = await seeded({ tool: [[read], 1] })
      expect(raises(await widening(made, 'tool', commit))).toEqual(['Raises tool from class 1, Reader to class 2, Writer'])
      await made.loader.apply({ kind: 'grant.widen', plugin: 'tool', capability: commit })
      expect(shape(await stored(made, 'tool'))).toEqual({ class: 2, firstUse: [] })
    })

    it('names nothing for a widen that leaves the class where it is', async () => {
      const made = await seeded({ sync: [[read, fetchOne], 4, [fetchOne]] })
      expect(raises(await widening(made, 'sync', fetchTwo))).toEqual([])
    })

    it('names nothing for a widen that leaves the class below the one its entry holds and stores the lower one', async () => {
      const made = await stuck([read, commit], 4)
      expect(raises(await widening(made, 'tool', { type: 'storage' }))).toEqual([])
      await made.loader.apply({ kind: 'grant.widen', plugin: 'tool', capability: { type: 'storage' } })
      expect((await stored(made, 'tool')).class).toBe(2)
    })

    it('names nothing for a plugin whose entry holds a class not known, counted as 4', async () => {
      const made = await stuck([read], null)
      expect(raises(await widening(made, 'tool', fetchOne))).toEqual([])
    })

    it('names nothing with the slot down, whose own line stands for every class', async () => {
      const made = await seeded({ sync: [[fetchOne], null] }, allowAll(), true)
      const notes = await widening(made, 'sync', read)
      expect(raises(notes)).toEqual([])
      expect(notes).toContain('The capabilities plugin is down, so the class is unknown and counted as 4: every item asks at its first use')
    })

    it('applies a narrow with no Confirm, so its move down is named nowhere', async () => {
      const made = await seeded({ sync: [[read, fetchOne], 4, [fetchOne]] })
      expect(await made.loader.request({ kind: 'grant.narrow', plugin: 'sync', capability: read }, editor)).toEqual({ applied: true })
      expect((await listed(made)).requests).toEqual([])
      expect((await stored(made, 'sync')).class).toBe(3)
    })

    it('names no own move on a first approval, which has no class before it', async () => {
      const made = await harness({ install: withCapabilities(), folder: { sync: worker('sync', [read, fetchOne]) } })
      await made.loader.start()
      const request = await approved(made, 'sync')
      expect(raises(request.notes)).toEqual([])
      expect((await stored(made, 'sync')).class).toBe(4)
    })
  })
})

// A listener holding a fetch and one subscription item naming a reader's topic and a clock's. The reader's approval
// pairs it, which moves it into class 4 and makes the subscription ask at first use while it is live
describe('a live subscription its plugin\'s move into class 4 makes ask', () => {
  const hears: Capability = { type: 'events.subscribe', topics: ['reader.done', 'clock.tick'] }
  const signalled = (inbox: Message[]) => inbox.filter(message => message.kind === 'event')
    .map(message => (Array.isArray(message.topics) ? `${message.topic}[${message.topics}]` : message.topic))

  async function moved() {
    const made = await harness({
      install: withCapabilities(),
      behave: { gate: { exports: { gate: createGate() } } },
      folder: {
        listener: worker('listener', [fetchOne, hears]),
        reader: filesFor(workerManifest('reader', { capabilities: [read], provides: { topics: ['done'] } })),
        clock: filesFor(workerManifest('clock', { provides: { topics: ['tick'] } })),
      },
      entries: {
        listener: root => entryFor(root, { granted: [fetchOne, hears], class: 3 }),
        clock: root => entryFor(root, { granted: [], class: 0 }),
      },
      switches: { devMode: ['reader'] },
    })
    await made.loader.start()
    await tick(30)
    const listener = made.runtime.half('listener')
    const clock = made.runtime.half('clock')
    expect((await listener.ask('events.subscribe', { topics: ['reader.done', 'clock.tick'] }))?.result).toEqual({ standing: [] })
    await clock.ask('events.publish', { topic: 'clock.tick' })
    await until(() => signalled(listener.inbox).length === 1)
    await made.loader.apply({ kind: 'plugin.approve', plugin: 'reader' })
    expect((await made.store.load()).state.plugins.listener).toMatchObject({ class: 4, firstUse: [fetchOne, hears] })
    // Nothing reaches it while it waits
    await clock.ask('events.publish', { topic: 'clock.tick' })
    await made.runtime.half('reader').ask('events.publish', { topic: 'reader.done' })
    await tick(30)
    expect(signalled(listener.inbox)).toEqual(['clock.tick'])
    return { made, listener, clock }
  }

  it('waits with nothing delivered and holds the item\'s Confirm for the human, then goes on after it with one events.dropped', async () => {
    const { made, listener, clock } = await moved()
    const asked = made.loader.pending().filter(request => request.kind === 'item.on')
    expect(asked).toEqual([expect.objectContaining({ kind: 'item.on', plugin: 'listener' })])
    await made.loader.apply({ kind: 'item.on', plugin: 'listener', capability: hears })
    await clock.ask('events.publish', { topic: 'clock.tick' })
    await until(() => signalled(listener.inbox).length === 3)
    await tick(30)
    expect(signalled(listener.inbox)).toEqual(['clock.tick', 'events.dropped[reader.done,clock.tick]', 'clock.tick'])
  })

  it('ends once the human declines the Confirm and tells the plugin, whose subscribe again is refused as declined', async () => {
    const { made, listener, clock } = await moved()
    const [asked] = made.loader.pending().filter(request => request.kind === 'item.on')
    await made.loader.cancel(asked.id)
    await clock.ask('events.publish', { topic: 'clock.tick' })
    await until(() => signalled(listener.inbox).length === 2)
    await tick(30)
    expect(signalled(listener.inbox)).toEqual(['clock.tick', 'events.ended[reader.done,clock.tick]'])
    const again = await listener.ask('events.subscribe', { topics: ['reader.done', 'clock.tick'] })
    expect(again?.refusal).toMatchObject({ code: 'not-granted', reason: 'declined' })
  })
})

describe('the plugin list', () => {
  // With the slot down the start classes nothing again, so each stored class stands
  it('shows each plugin-folder plugin\'s class, null for none known', async () => {
    const made = await harness({
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

// At start every plugin-folder entry is classed again from the graph as it stands, before any plugin-folder plugin
// runs. An item asks unless the entry records that the human confirmed it
describe('the classes at start', () => {
  type Made = Awaited<ReturnType<typeof harness>>
  type Gate = ReturnType<typeof allowAll>
  const hears = (...topics: string[]): Capability => ({ type: 'events.subscribe', topics })
  const entryFile = (made: Made, id: string) => readFile(path.join(made.dataDir, 'state', 'plugins', `${id}.json`))
  const stored = async (made: Made, id: string) => (await made.store.load()).state.plugins[id]
  const folder = () => ({ listener: worker('listener', [fetchOne, hears('reader.done')]), reader: worker('reader', [read]) })
  // A network listener stored as it was classed before the reader it hears was there: class 3 and nothing asking
  const stale = {
    listener: (root: string) => entryFor(root, { granted: [fetchOne, hears('reader.done')], class: 3 }),
    reader: (root: string) => entryFor(root, { granted: [read], class: 1 }),
  }
  const asking = (gate: Gate, view = gate.seen.at(-1)) => view!.plugins.listener.map(item => item.firstUse)

  // The ids written to the plugin entries from here on
  function writes(made: Made): string[] {
    const seen: string[] = []
    const write = made.store.writePlugin.bind(made.store)
    made.store.writePlugin = async (id, entry) => {
      seen.push(id)
      return write(id, entry)
    }
    return seen
  }

  // The gate's StateView as it stood when the listener's worker was started
  function atStart(made: Made, gate: Gate): () => Gate['seen'][number] | undefined {
    let view: Gate['seen'][number] | undefined
    const startWorker = made.runtime.startWorker.bind(made.runtime)
    made.runtime.startWorker = start => {
      if (start.id === 'listener') view = gate.seen.at(-1)
      startWorker(start)
    }
    return () => view
  }

  // A first start that approves the listener and then the reader, so both entries are right
  async function approvedBoth(): Promise<Made> {
    const made = await harness({ install: withCapabilities(), folder: folder() })
    await made.loader.start()
    await approved(made, 'listener')
    await approved(made, 'reader')
    return made
  }

  it('raises a stale network listener to 4 with its fetch and subscription asking before it starts, on a first start', async () => {
    const gate = allowAll()
    const made = await harness({ install: withCapabilities(), behave: { gate: { exports: { gate } } }, folder: folder(), entries: stale })
    const seen = atStart(made, gate)
    await made.loader.start()
    expect(await stored(made, 'listener')).toMatchObject({ class: 4, firstUse: [fetchOne, hears('reader.done')] })
    expect(stateOf(made.loader, 'listener')).toBe('ready')
    expect(asking(gate, seen())).toEqual([true, true])
    expect(asking(gate)).toEqual([true, true])
  })

  it('raises a stale network listener to 4 with its fetch and subscription asking on a start whose install the last start recorded', async () => {
    const first = await harness({ install: withCapabilities(), folder: folder() })
    await first.loader.start()
    await first.loader.shutdown()
    const made = await harness({ base: first.base, install: withCapabilities(), folder: folder(), entries: stale })
    await made.loader.start()
    expect(await stored(made, 'listener')).toMatchObject({ class: 4, firstUse: [fetchOne, hears('reader.done')] })
  })

  it('writes no entry that is right and leaves each file byte for byte', async () => {
    const first = await approvedBoth()
    await first.loader.shutdown()
    const before = { listener: await entryFile(first, 'listener'), reader: await entryFile(first, 'reader') }
    const made = await harness({ base: first.base, install: withCapabilities(), folder: folder() })
    const seen = writes(made)
    await made.loader.start()
    expect(seen).toEqual([])
    expect((await entryFile(made, 'listener')).equals(before.listener)).toBe(true)
    expect((await entryFile(made, 'reader')).equals(before.reader)).toBe(true)
  })

  it('keeps an item the human confirmed from asking again on a start whose install the last start recorded', async () => {
    const first = await approvedBoth()
    await first.loader.apply({ kind: 'item.on', plugin: 'listener', capability: fetchOne })
    expect((await stored(first, 'listener')).firstUse).toEqual([hears('reader.done')])
    await first.loader.shutdown()
    const before = await entryFile(first, 'listener')
    const made = await harness({ base: first.base, install: withCapabilities(), folder: folder() })
    await made.loader.start()
    expect(await stored(made, 'listener')).toMatchObject({ class: 4, firstUse: [hears('reader.done')] })
    expect((await entryFile(made, 'listener')).equals(before)).toBe(true)
  })

  // An install plugin whose topics the listener hears, holding capabilities at version
  const speaker = (version: string, capabilities: Capability[]) => ({ ...withCapabilities(), http: { files: filesFor(hostManifest('http', { version, capabilities })) } })

  it('asks for the items an app update to an install plugin makes ask in an entry already at 4, while one that asks with no links stays confirmed', async () => {
    const listener = () => ({ listener: worker('listener', [fetchOne, exec, hears('http.done')]) })
    const first = await harness({ install: speaker('1.0.0', []), folder: listener() })
    await first.loader.start()
    await approved(first, 'listener')
    expect(await stored(first, 'listener')).toMatchObject({ class: 4, firstUse: [exec] })
    await first.loader.apply({ kind: 'item.on', plugin: 'listener', capability: exec })
    await first.loader.shutdown()
    const made = await harness({ base: first.base, install: speaker('1.1.0', [read]), folder: listener() })
    await made.loader.start()
    expect(await stored(made, 'listener')).toMatchObject({ class: 4, firstUse: [fetchOne, hears('http.done')] })
  })

  // The second start's install and switches, from the first start's folders
  type Next = (first: Made) => Promise<{ install: ReturnType<typeof withCapabilities>, switches?: Partial<Switches> }>
  // http's bytes changed while its list still names the hash the last start recorded
  const tampered: Next = async first => {
    const recorded = await hashOf(path.join(first.installDir, 'plugins', 'http'))
    return { install: { ...withCapabilities(), http: { files: filesFor(hostManifest('http', { capabilities: [{ type: 'storage' }] })), hash: recorded } } }
  }
  it.each([
    ['a new version', async () => ({ install: speaker('1.1.0', []) })],
    ['new bytes under the same version', async () => ({ install: speaker('1.0.0', [{ type: 'storage' }]) })],
    ['an install plugin gone', async () => ({ install: withCapabilities() })],
    ['bytes that differ from the list', tampered],
    ['dev mode on an install plugin', async () => ({ install: speaker('1.0.0', []), switches: { devMode: ['http'] } })],
    ['skipVerification on', async () => ({ install: speaker('1.0.0', []), switches: { skipVerification: true } })],
  ] as [string, Next][])('keeps a confirmed item that asks only through its links confirmed whatever the install: %s', async (_name, next) => {
    const first = await harness({ install: speaker('1.0.0', []), folder: folder() })
    await first.loader.start()
    await approved(first, 'listener')
    await approved(first, 'reader')
    await first.loader.apply({ kind: 'item.on', plugin: 'listener', capability: fetchOne })
    expect((await stored(first, 'listener')).firstUse).toEqual([hears('reader.done')])
    await first.loader.shutdown()
    const made = await harness({ base: first.base, ...await next(first), folder: folder() })
    await made.loader.start()
    expect(await stored(made, 'listener')).toMatchObject({ class: 4, firstUse: [hears('reader.done')], confirmed: [fetchOne] })
  })

  it('writes nothing when the slot is down at start, so each entry keeps its class and list', async () => {
    const made = await harness({
      folder: { ...folder(), other: worker('other', [{ type: 'storage' }]) },
      entries: { ...stale, other: root => entryFor(root, { granted: [{ type: 'storage' }], class: 4, firstUse: [{ type: 'storage' }] }) },
    })
    const files = { listener: await entryFile(made, 'listener'), other: await entryFile(made, 'other') }
    const seen = writes(made)
    await made.loader.start()
    expect(made.loader.slot('capabilities')).toBe('absent')
    expect(seen).toEqual([])
    expect((await entryFile(made, 'listener')).equals(files.listener)).toBe(true)
    expect((await entryFile(made, 'other')).equals(files.other)).toBe(true)
  })

  it('asks for a raised item in the run when its entry can\'t be written and still starts', async () => {
    const gate = allowAll()
    const made = await harness({ install: withCapabilities(), behave: { gate: { exports: { gate } } }, folder: folder(), entries: stale })
    made.store.writePlugin = async () => Promise.reject(new Error('disk full'))
    await made.loader.start()
    expect(made.link.events('fault')).toContainEqual({ plugin: 'listener', step: 'reclass' })
    expect(asking(gate)).toEqual([true, true])
    expect(stateOf(made.loader, 'listener')).toBe('ready')
  })
})

// One function decides every class change from its cause, whether a Confirm for it is on screen and the capabilities
// slot's state: on, switched off by the human, or down any other way. Each row reads one plugin after the change: its
// stored class, what asks, what the human confirmed, the mark of an entry written while off, the Raises lines and the
// class lines the Confirm showed and what the gate is handed. Off passes with nothing about classes and nothing asking.
// Down is strict: the class not known and every item asking
describe('a class change, by its cause, its Confirm and the slot', () => {
  type Slot = 'on' | 'off' | 'down'
  type Seeded = Record<string, [Capability[], number | null, Capability[]?]>
  const hears = (...topics: string[]): Capability => ({ type: 'events.subscribe', topics })
  const calls = (...targets: string[]): Capability => ({ type: 'plugin.call', targets })
  const fetchTwo: Capability = { type: 'net.fetch', hosts: ['example.org'] }
  const listens = hears('reader.done')
  const commit: Capability = { type: 'history', access: 'commit', paths: ['notes/**'] }

  type Scenario = {
    seeded?: Seeded
    folder?: Record<string, Capability[]>
    install?: Record<string, Listing>
    // Items the human confirms with the slot on, before the slot takes its state
    confirm?: [string, Capability][]
    // The change, none for the classing at start
    change?: Change
    staged?: Capability[]
    // The slot takes its state at start, for the first-party copy and the pass at start
    atStart?: boolean
    subject: string
  }

  const bundledGit = (capabilities: Capability[]): Listing => ({ files: worker('git', capabilities), firstParty: true })
  const scenarios: Record<string, Scenario> = {
    'a first approval': { folder: { sync: [read, fetchOne] }, change: { kind: 'plugin.approve', plugin: 'sync' }, subject: 'sync' },
    'an approval that moves another plugin up': {
      folder: { reader: [read] }, seeded: { listener: [[fetchOne, listens], 3] }, change: { kind: 'plugin.approve', plugin: 'reader' }, subject: 'listener',
    },
    'a widen that moves its own plugin up': { seeded: { sync: [[fetchOne], 3] }, change: { kind: 'grant.widen', plugin: 'sync', capability: read }, subject: 'sync' },
    'a widen that moves nothing': {
      seeded: { sync: [[read, fetchOne], 4, [fetchOne]] }, confirm: [['sync', fetchOne]], change: { kind: 'grant.widen', plugin: 'sync', capability: fetchTwo }, subject: 'sync',
    },
    'a narrow that moves its own plugin down': {
      seeded: { sync: [[read, fetchOne], 4, [fetchOne]] }, confirm: [['sync', fetchOne]], change: { kind: 'grant.narrow', plugin: 'sync', capability: read }, subject: 'sync',
    },
    'a remove that moves another plugin down': {
      seeded: { listener: [[fetchOne, listens], 4, [fetchOne, listens]], reader: [[read], 4] }, confirm: [['listener', fetchOne]],
      change: { kind: 'plugin.remove', plugin: 'reader' }, subject: 'listener',
    },
    'a reset that moves another plugin down': {
      seeded: { listener: [[fetchOne, listens], 4, [fetchOne, listens]], reader: [[read], 4] }, confirm: [['listener', fetchOne]],
      change: { kind: 'plugin.reset', plugin: 'reader' }, subject: 'listener',
    },
    'a restore that moves its own plugin up': { install: { git: bundledGit([read, fetchOne]) }, change: { kind: 'plugin.restore', plugin: 'git' }, subject: 'git' },
    'an update that moves nothing': {
      seeded: { tool: [[read, fetchOne], 4, [fetchOne]] }, confirm: [['tool', fetchOne]], change: { kind: 'plugin.update', plugin: 'tool' }, staged: [read, fetchOne],
      subject: 'tool',
    },
    'a first-party copy at start that moves another plugin up': {
      install: { git: bundledGit([fetchOne]) }, seeded: { notes: [[read, calls('git')], 1] }, atStart: true, subject: 'notes',
    },
    'a first-party copy at start that moves another plugin from 0 to 4': {
      install: { git: bundledGit([read, fetchOne]) }, seeded: { notes: [[{ type: 'ui.view' }, calls('git')], 0] }, atStart: true, subject: 'notes',
    },
    'a first-party copy at start that moves another plugin within 1 to 3': {
      install: { git: bundledGit([fetchOne]) }, seeded: { notes: [[commit, calls('git')], 2] }, atStart: true, subject: 'notes',
    },
    'the pass at start, a move up': { seeded: { listener: [[fetchOne, listens], 3], reader: [[read], 1] }, atStart: true, subject: 'listener' },
    'the pass at start, a move from 0 to 4': { seeded: { listener: [[fetchOne, listens], 0], reader: [[read], 1] }, atStart: true, subject: 'listener' },
    'the pass at start, a move down': { seeded: { listener: [[fetchOne, listens], 4, [fetchOne, listens]] }, atStart: true, subject: 'listener' },
  }

  type Expected = {
    class: number | null
    firstUse: Capability[]
    confirmed?: Capability[]
    unclassed?: true
    // The Raises lines on the change's Confirm and whether it showed the class line, the down line or neither
    raises?: string[]
    shows?: 'class' | 'down' | 'nothing'
    // The notices raised for a move up with no Confirm on screen that crosses where the policy alerts
    alerted?: string[]
  }
  const raised = (id: string, from: string, to: string) => [`Raises ${id} from ${from} to ${to}`]
  const alerted = (id: string, from: string, to: string) => [`${JSON.stringify(id)} moved from ${from} to ${to} with no Confirm on screen`]
  const rows: [string, Slot, Expected][] = [
    ['a first approval', 'on', { class: 4, firstUse: [fetchOne], raises: [], shows: 'class' }],
    ['a first approval', 'off', { class: null, firstUse: [read, fetchOne], unclassed: true, raises: [], shows: 'nothing' }],
    ['a first approval', 'down', { class: null, firstUse: [read, fetchOne], raises: [], shows: 'down' }],
    ['an approval that moves another plugin up', 'on', {
      class: 4, firstUse: [fetchOne, listens], raises: raised('listener', 'class 3, Network', 'class 4, Powerful'), shows: 'class',
    }],
    ['an approval that moves another plugin up', 'off', { class: 3, firstUse: [fetchOne, listens], unclassed: true, raises: [], shows: 'nothing' }],
    ['an approval that moves another plugin up', 'down', { class: null, firstUse: [fetchOne, listens], raises: [], shows: 'down' }],
    ['a widen that moves its own plugin up', 'on', { class: 4, firstUse: [fetchOne], raises: raised('sync', 'class 3, Network', 'class 4, Powerful'), shows: 'class' }],
    ['a widen that moves its own plugin up', 'off', { class: 3, firstUse: [fetchOne, read], unclassed: true, raises: [], shows: 'nothing' }],
    ['a widen that moves its own plugin up', 'down', { class: null, firstUse: [fetchOne, read], raises: [], shows: 'down' }],
    ['a widen that moves nothing', 'on', { class: 4, firstUse: [fetchTwo], confirmed: [fetchOne], raises: [], shows: 'class' }],
    ['a widen that moves nothing', 'off', { class: 4, firstUse: [read, fetchTwo], confirmed: [fetchOne], unclassed: true, raises: [], shows: 'nothing' }],
    ['a widen that moves nothing', 'down', { class: null, firstUse: [read, fetchOne, fetchTwo], confirmed: [fetchOne], raises: [], shows: 'down' }],
    ['a narrow that moves its own plugin down', 'on', { class: 3, firstUse: [], confirmed: [fetchOne] }],
    ['a narrow that moves its own plugin down', 'off', { class: 4, firstUse: [], confirmed: [fetchOne], unclassed: true }],
    ['a narrow that moves its own plugin down', 'down', { class: null, firstUse: [fetchOne], confirmed: [fetchOne] }],
    ['a remove that moves another plugin down', 'on', { class: 3, firstUse: [], confirmed: [fetchOne], raises: [], shows: 'nothing' }],
    ['a remove that moves another plugin down', 'off', { class: 4, firstUse: [listens], confirmed: [fetchOne], unclassed: true, raises: [], shows: 'nothing' }],
    ['a remove that moves another plugin down', 'down', { class: null, firstUse: [fetchOne, listens], confirmed: [fetchOne], raises: [], shows: 'nothing' }],
    ['a reset that moves another plugin down', 'on', { class: 3, firstUse: [], confirmed: [fetchOne], raises: [], shows: 'nothing' }],
    ['a reset that moves another plugin down', 'off', { class: 4, firstUse: [listens], confirmed: [fetchOne], unclassed: true, raises: [], shows: 'nothing' }],
    ['a reset that moves another plugin down', 'down', { class: null, firstUse: [fetchOne, listens], confirmed: [fetchOne], raises: [], shows: 'nothing' }],
    ['a restore that moves its own plugin up', 'on', { class: 4, firstUse: [fetchOne], raises: raised('git', 'class 1, Reader', 'class 4, Powerful'), shows: 'class' }],
    ['a restore that moves its own plugin up', 'off', { class: 1, firstUse: [read, fetchOne], unclassed: true, raises: [], shows: 'nothing' }],
    ['a restore that moves its own plugin up', 'down', { class: null, firstUse: [read, fetchOne], raises: [], shows: 'down' }],
    ['an update that moves nothing', 'on', { class: 4, firstUse: [], confirmed: [fetchOne], raises: [], shows: 'class' }],
    ['an update that moves nothing', 'off', { class: 4, firstUse: [read], confirmed: [fetchOne], unclassed: true, raises: [], shows: 'nothing' }],
    ['an update that moves nothing', 'down', { class: null, firstUse: [read, fetchOne], confirmed: [fetchOne], raises: [], shows: 'down' }],
    ['a first-party copy at start that moves another plugin up', 'on', { class: 4, firstUse: [calls('git')], alerted: alerted('notes', 'class 1, Reader', 'class 4, Powerful') }],
    ['a first-party copy at start that moves another plugin up', 'off', { class: 1, firstUse: [read, calls('git')], unclassed: true }],
    ['a first-party copy at start that moves another plugin up', 'down', { class: null, firstUse: [read, calls('git')] }],
    ['a first-party copy at start that moves another plugin from 0 to 4', 'on', {
      class: 4, firstUse: [calls('git')], alerted: alerted('notes', 'class 0, Contained', 'class 4, Powerful'),
    }],
    ['a first-party copy at start that moves another plugin from 0 to 4', 'off', { class: 0, firstUse: [{ type: 'ui.view' }, calls('git')], unclassed: true }],
    ['a first-party copy at start that moves another plugin from 0 to 4', 'down', { class: null, firstUse: [{ type: 'ui.view' }, calls('git')] }],
    ['a first-party copy at start that moves another plugin within 1 to 3', 'on', { class: 3, firstUse: [] }],
    ['a first-party copy at start that moves another plugin within 1 to 3', 'off', { class: 2, firstUse: [commit, calls('git')], unclassed: true }],
    ['a first-party copy at start that moves another plugin within 1 to 3', 'down', { class: null, firstUse: [commit, calls('git')] }],
    ['the pass at start, a move up', 'on', { class: 4, firstUse: [fetchOne, listens], alerted: alerted('listener', 'class 3, Network', 'class 4, Powerful') }],
    ['the pass at start, a move up', 'off', { class: 3, firstUse: [] }],
    ['the pass at start, a move up', 'down', { class: null, firstUse: [fetchOne, listens] }],
    ['the pass at start, a move from 0 to 4', 'on', { class: 4, firstUse: [fetchOne, listens], alerted: alerted('listener', 'class 0, Contained', 'class 4, Powerful') }],
    ['the pass at start, a move from 0 to 4', 'off', { class: 0, firstUse: [] }],
    ['the pass at start, a move from 0 to 4', 'down', { class: null, firstUse: [fetchOne, listens] }],
    ['the pass at start, a move down', 'on', { class: 3, firstUse: [] }],
    ['the pass at start, a move down', 'off', { class: 4, firstUse: [fetchOne, listens] }],
    ['the pass at start, a move down', 'down', { class: null, firstUse: [fetchOne, listens] }],
  ]

  // The scenario run with the slot in its state: from start for one with no change and otherwise just before the change
  async function run(scenario: Scenario, slot: Slot) {
    const gate = allowAll()
    const role = breakable()
    const seeded = scenario.seeded ?? {}
    const ids = [...new Set([...Object.keys(seeded), ...Object.keys(scenario.folder ?? {})])]
    const entries: Record<string, (root: string) => Promise<Plugin>> = Object.fromEntries(Object.entries(seeded).map(([id, [granted, n, firstUse]]) =>
      [id, (root: string) => entryFor(root, { granted, class: n, ...(firstUse === undefined ? {} : { firstUse }) })]))
    const install: Record<string, Listing> = { ...withCapabilities(), ...scenario.install }
    const folder: Record<string, Files> = Object.fromEntries(ids.map(id => [id, worker(id, scenario.folder?.[id] ?? seeded[id]?.[0] ?? [])]))
    // A narrowed git: its entry holds read alone at class 1 while the install's copy asks for read and fetch
    if (scenario.change?.kind === 'plugin.restore') {
      const scratch = path.join(await tempBase(), 'git')
      await writeFolder(scratch, install.git!.files)
      const hash = await hashOf(scratch)
      folder.git = install.git!.files
      entries.git = async () => firstPartyEntry(hash, { granted: [read], class: 1 })
    }
    if (slot === 'down' && scenario.atStart === true) role.broken = true
    const made = await harness({
      install, folder, entries,
      behave: { gate: { exports: { gate } }, capabilities: { exports: { capabilities: role } } },
      switches: slot === 'off' && scenario.atStart === true ? { off: ['capabilities'] } : {},
    })
    await made.loader.start()
    for (const [id, item] of scenario.confirm ?? []) await made.loader.apply({ kind: 'item.on', plugin: id, capability: item })
    if (scenario.atStart !== true && slot === 'off') await made.loader.apply({ kind: 'plugin.off', plugin: 'capabilities' })
    if (scenario.atStart !== true && slot === 'down') role.broken = true
    let notes: string[] | null = null
    const { change } = scenario
    if (change !== undefined) {
      if (change.kind === 'plugin.update') {
        const dir = path.join(made.dataDir, 'staging', `${change.plugin}-next`)
        await writeFolder(dir, filesFor(workerManifest(change.plugin, { version: '1.1.0', capabilities: scenario.staged ?? [] })))
        expect(await made.loader.update(change.plugin, dir)).toMatchObject({ outcome: 'confirm' })
      } else {
        await made.loader.request(change, editor)
      }
      const held = (await listed(made)).requests.find(request => request.kind === change.kind && 'plugin' in change && request.plugin === change.plugin)
      notes = held?.notes ?? null
      if (held !== undefined) await made.loader.apply(change)
    }
    const entry = (await made.store.load()).state.plugins[scenario.subject]!
    return {
      notes,
      got: {
        class: entry.class,
        firstUse: entry.firstUse ?? [],
        ...(entry.confirmed === undefined ? {} : { confirmed: entry.confirmed }),
        ...(entry.unclassed === undefined ? {} : { unclassed: entry.unclassed }),
      },
      gated: (gate.seen.at(-1)!.plugins[scenario.subject] ?? []).filter(item => item.firstUse).map(item => item.capability),
      others: made.loader.pending().filter(request => request.plugin === scenario.subject && request.kind !== change?.kind && request.kind !== 'class.raised'),
      alerted: (await listed(made)).requests.filter(request => request.kind === 'class.raised' && request.plugin === scenario.subject).map(request => request.text),
    }
  }

  it.each(rows)('%s with the slot %s', async (name, slot, expected) => {
    const { got, notes, gated, others, alerted: notices } = await run(scenarios[name]!, slot)
    const { raises, shows, alerted: expectedNotices, ...stored } = expected
    expect(got).toEqual(stored)
    // Off: nothing asks while it is off. Otherwise the gate is handed what the entry lists
    expect(gated).toEqual(slot === 'off' ? [] : expected.firstUse)
    if (raises !== undefined) expect(notes?.filter(line => line.startsWith('Raises')) ?? []).toEqual(raises)
    if (shows !== undefined) {
      const lines = notes ?? []
      expect(lines.some(line => line.startsWith('Class '))).toBe(shows === 'class')
      expect(lines.includes(DOWN)).toBe(shows === 'down')
    }
    expect(others).toEqual([])
    expect(notices).toEqual(expectedNotices ?? [])
  })
})

// An entry records the first-use items the human confirmed. An item asks unless the record names it, so nothing reads
// an item's absence from the list as a confirmation, whatever the class, the install or the rules were before
describe('what the human confirmed, recorded in the entry', () => {
  type Made = Awaited<ReturnType<typeof harness>>
  const hears = (...topics: string[]): Capability => ({ type: 'events.subscribe', topics })
  const commit: Capability = { type: 'history', access: 'commit', paths: ['notes/**'] }
  const stored = async (made: Made, id: string) => (await made.store.load()).state.plugins[id]!
  const shape = (entry: Plugin) => ({ class: entry.class, firstUse: entry.firstUse ?? [] })
  async function closed(made: Made): Promise<void> {
    await made.loader.shutdown().catch(() => {})
    made.carrier.close()
    made.link.carrier?.close()
  }

  it('records an item the human lets the plugin use once it asks and takes it off the list', async () => {
    const made = await harness({ install: withCapabilities(), folder: { sync: worker('sync', [read, fetchOne]) } })
    await made.loader.start()
    await approved(made, 'sync')
    await made.loader.apply({ kind: 'item.on', plugin: 'sync', capability: fetchOne })
    expect(await stored(made, 'sync')).toMatchObject({ class: 4, confirmed: [fetchOne] })
    expect((await stored(made, 'sync')).firstUse ?? []).toEqual([])
  })

  it('confirms nothing for an item switched on that wasn\'t asking', async () => {
    const made = await harness({
      install: withCapabilities(), folder: { tool: worker('tool') },
      entries: { tool: root => entryFor(root, { granted: [read], class: 1, off: [read] }) },
    })
    await made.loader.start()
    await made.loader.apply({ kind: 'item.on', plugin: 'tool', capability: read })
    expect((await stored(made, 'tool')).confirmed).toBeUndefined()
  })

  it('makes every item of an entry with no record ask once more, since it has confirmed nothing', async () => {
    const made = await harness({
      install: withCapabilities(), folder: { sync: worker('sync') },
      entries: { sync: root => entryFor(root, { granted: [read, fetchOne], class: 4 }) },
    })
    await made.loader.start()
    expect(shape(await stored(made, 'sync'))).toEqual({ class: 4, firstUse: [fetchOne] })
  })

  // A copy's new version names the same type with another scope: a new item, which asks
  it('counts two items as one only when type and scope are the same, so a confirmed fetch whose hosts change asks again', async () => {
    const wider: Capability = { type: 'net.fetch', hosts: ['example.com', 'example.org'] }
    const bundled = (version: string, capabilities: Capability[]) => ({ ...withCapabilities(), git: { files: filesFor(workerManifest('git', { version, capabilities })), firstParty: true } })
    const first = await harness({ install: bundled('1.0.0', [read, fetchOne]) })
    await first.loader.start()
    await first.loader.apply({ kind: 'item.on', plugin: 'git', capability: fetchOne })
    await closed(first)
    const same = await harness({ base: first.base, install: bundled('1.1.0', [read, fetchOne, { type: 'storage' }]) })
    await same.loader.start()
    expect(await stored(same, 'git')).toMatchObject({ class: 4, confirmed: [fetchOne] })
    expect((await stored(same, 'git')).firstUse ?? []).toEqual([])
    await closed(same)
    const changed = await harness({ base: first.base, install: bundled('1.2.0', [read, wider]) })
    await changed.loader.start()
    const entry = await stored(changed, 'git')
    expect(shape(entry)).toEqual({ class: 4, firstUse: [wider] })
    expect(entry.confirmed).toBeUndefined()
  })

  // Five ways an item nobody confirmed read as confirmed at a start, each from an entry at class 4 or
  // null with nothing listed. A listener holds exec the human confirmed, a fetch and a subscription to an install
  // plugin's topic, which an app update makes a reader
  const listenerGrants = [exec, fetchOne, hears('http.done')]
  const speaker = (version: string, capabilities: Capability[], extra: Partial<Listing> = {}): Listing =>
    ({ files: filesFor(hostManifest('http', { version, capabilities, provides: { topics: ['done'] } })), ...extra })
  const installOf = (http: Listing) => ({ ...withCapabilities(), http })

  // The first run under the install before the update: the listener at class 4 for exec, which the human confirmed
  async function confirmedExec(base: string, http = speaker('1.0.0', []), switches: Partial<Switches> = {}): Promise<void> {
    const made = await harness({ base, install: installOf(http), switches, folder: { listener: worker('listener', listenerGrants) } })
    await made.loader.start()
    await approved(made, 'listener')
    await made.loader.apply({ kind: 'item.on', plugin: 'listener', capability: exec })
    expect(shape(await stored(made, 'listener'))).toEqual({ class: 4, firstUse: [] })
    await closed(made)
  }
  const updated = () => installOf(speaker('1.1.0', [read]))
  const pairAsks = { class: 4, firstUse: [fetchOne, hears('http.done')] }

  it('asks once the process died after the install record moved on and before the pass', async () => {
    const base = await tempBase()
    await confirmedExec(base)
    const crashed = await harness({ base, install: updated() })
    ;(crashed.loader as unknown as { reconcile: () => Promise<void> }).reconcile = async () => {
      throw new Error('the process died here')
    }
    await crashed.loader.start().catch(() => {})
    await closed(crashed)
    const made = await harness({ base, install: updated() })
    await made.loader.start()
    expect(shape(await stored(made, 'listener'))).toEqual(pairAsks)
  })

  it('asks once the first start after an app update ran with the slot off', async () => {
    const base = await tempBase()
    await confirmedExec(base)
    const off = await harness({ base, install: updated(), switches: { off: ['capabilities'] } })
    await off.loader.start()
    await closed(off)
    const made = await harness({ base, install: updated() })
    await made.loader.start()
    expect(shape(await stored(made, 'listener'))).toEqual(pairAsks)
  })

  it('asks for an item new rules make ask on its own in an entry already at 4, keeping the confirmed one', async () => {
    const base = await tempBase()
    const granted = [exec, commit]
    const first = await harness({ base, install: withCapabilities(), folder: { tool: worker('tool', granted) } })
    await first.loader.start()
    await approved(first, 'tool')
    await first.loader.apply({ kind: 'item.on', plugin: 'tool', capability: exec })
    expect(shape(await stored(first, 'tool'))).toEqual({ class: 4, firstUse: [] })
    await closed(first)
    const real = createCapabilities()
    const stricter: Capabilities = {
      ...real,
      firstUse: (held, reachable, flow) => [...real.firstUse(held, reachable, flow), ...held.filter(item => item.type === 'history')],
    }
    const made = await harness({
      base, install: { ...coreInstall(), capabilities: { files: filesFor(hostManifest('capabilities', { version: '1.1.0' })) } },
      behave: { capabilities: { exports: { capabilities: stricter } } },
    })
    await made.loader.start()
    expect(await stored(made, 'tool')).toMatchObject({ class: 4, firstUse: [commit], confirmed: [exec] })
  })

  it('asks once an install plugin ran in dev mode from bytes that read nothing and dev mode went off', async () => {
    const base = await tempBase()
    const real = speaker('1.0.0', [read])
    const scratch = path.join(await tempBase(), 'http')
    await writeFolder(scratch, real.files)
    await confirmedExec(base, speaker('1.0.0', [], { hash: await hashOf(scratch) }), { devMode: ['http'] })
    const made = await harness({ base, install: installOf(real) })
    await made.loader.start()
    expect(shape(await stored(made, 'listener'))).toEqual(pairAsks)
  })

  it('asks once an update was applied with the slot off, at the next start with it on', async () => {
    const base = await tempBase()
    const granted = [fetchOne, hears('reader.done')]
    const off = await harness({
      base, install: withCapabilities(), switches: { off: ['capabilities'] },
      folder: { listener: worker('listener', granted), reader: worker('reader', [read]) },
      entries: { listener: root => entryFor(root, { granted, class: 3 }), reader: root => entryFor(root, { granted: [read], class: 1 }) },
    })
    await off.loader.start()
    const dir = path.join(off.dataDir, 'staging', 'listener-next')
    await writeFolder(dir, filesFor(workerManifest('listener', { version: '1.1.0', capabilities: granted })))
    await off.loader.update('listener', dir)
    await off.loader.apply({ kind: 'plugin.update', plugin: 'listener' })
    await closed(off)
    const made = await harness({ base, install: withCapabilities(), switches: { off: [] } })
    await made.loader.start()
    expect(shape(await stored(made, 'listener'))).toEqual({ class: 4, firstUse: granted })
  })

  it('classes an entry written while off from nothing at the next start with the slot on and drops its mark', async () => {
    const base = await tempBase()
    const off = await harness({ base, install: withCapabilities(), switches: { off: ['capabilities'] }, folder: { sync: worker('sync', [read, fetchOne]) } })
    await off.loader.start()
    await approved(off, 'sync')
    expect(await stored(off, 'sync')).toMatchObject({ class: null, unclassed: true })
    await closed(off)
    const made = await harness({ base, install: withCapabilities(), switches: { off: [] } })
    await made.loader.start()
    const entry = await stored(made, 'sync')
    expect(shape(entry)).toEqual({ class: 4, firstUse: [fetchOne] })
    expect(entry.unclassed).toBeUndefined()
  })
})

// With the capabilities plugin switched off by the human, changes pass: nothing is shown about classes, nothing asks
// and the gate is handed no first-use flags. Down any other way stays strict
describe('the capabilities plugin switched off by the human', () => {
  type Made = Awaited<ReturnType<typeof harness>>
  const stored = async (made: Made, id: string) => (await made.store.load()).state.plugins[id]!
  const flags = (gate: ReturnType<typeof allowAll>, id: string) => (gate.seen.at(-1)!.plugins[id] ?? []).filter(item => item.firstUse).map(item => item.capability)

  async function asking(): Promise<{ made: Made, gate: ReturnType<typeof allowAll> }> {
    const gate = allowAll()
    const made = await harness({
      install: withCapabilities(), behave: { gate: { exports: { gate } } }, folder: { sync: worker('sync', [read, fetchOne]) },
    })
    await made.loader.start()
    await approved(made, 'sync')
    expect(flags(gate, 'sync')).toEqual([fetchOne])
    return { made, gate }
  }

  it('hands the gate no first-use flags while it is off and the stored ones again once it is switched on', async () => {
    const { made, gate } = await asking()
    await made.loader.apply({ kind: 'plugin.off', plugin: 'capabilities' })
    expect(flags(gate, 'sync')).toEqual([])
    await made.loader.apply({ kind: 'plugin.on', plugin: 'capabilities' })
    expect(flags(gate, 'sync')).toEqual([fetchOne])
  })

  it('makes every item an entry written while off doesn\'t name as confirmed ask once it is switched on, until the pass that follows classes it', async () => {
    const gate = allowAll()
    const made = await harness({
      install: withCapabilities(), behave: { gate: { exports: { gate } } }, switches: { off: ['capabilities'] }, folder: { sync: worker('sync', [read, fetchOne]) },
    })
    await made.loader.start()
    await approved(made, 'sync')
    expect(flags(gate, 'sync')).toEqual([])
    await made.loader.apply({ kind: 'plugin.on', plugin: 'capabilities' })
    expect(flags(gate, 'sync')).toEqual([read, fetchOne])
    await until(() => flags(gate, 'sync').length === 1)
    expect(flags(gate, 'sync')).toEqual([fetchOne])
    const entry = await stored(made, 'sync')
    expect(entry).toMatchObject({ class: 4, firstUse: [fetchOne] })
    expect(entry.unclassed).toBeUndefined()
    // A class not known counts as 4, so leaving it alerts nobody
    expect(made.loader.pending().filter(request => request.kind === 'class.raised')).toEqual([])
  })

  it('classes every entry once it is switched on again in the run and raises a notice for each move up that alerts', async () => {
    const hears: Capability = { type: 'events.subscribe', topics: ['reader.done'] }
    const made = await harness({
      install: withCapabilities(), switches: { off: ['capabilities'] },
      folder: { listener: worker('listener'), reader: worker('reader'), tool: worker('tool'), sender: worker('sender') },
      entries: {
        listener: root => entryFor(root, { granted: [fetchOne, hears], class: 3 }),
        reader: root => entryFor(root, { granted: [read], class: 1 }),
        tool: root => entryFor(root, { granted: [{ type: 'history', access: 'commit', paths: ['notes/**'] }, { type: 'plugin.call', targets: ['sender'] }], class: 2 }),
        sender: root => entryFor(root, { granted: [fetchOne], class: 3 }),
      },
    })
    await made.loader.start()
    expect(made.loader.slot('capabilities')).toBe('off')
    await made.loader.apply({ kind: 'plugin.on', plugin: 'capabilities' })
    await until(() => made.loader.pending().some(request => request.kind === 'class.raised'))
    expect(await stored(made, 'listener')).toMatchObject({ class: 4, firstUse: [fetchOne, hears] })
    expect((await stored(made, 'tool')).class).toBe(3)
    const notices = (await listed(made)).requests.filter(request => request.kind === 'class.raised')
    const why = ['Why: the capabilities plugin switched on again', 'Its new class and the items that ask at first use are in place already. Confirm only says you saw it']
    expect(notices.map(request => [request.plugin, request.text, request.notes])).toEqual([
      ['listener', '"listener" moved from class 3, Network to class 4, Powerful with no Confirm on screen', why],
      ['reader', '"reader" moved from class 1, Reader to class 4, Powerful with no Confirm on screen', why],
    ])
  })

  it('keeps a capabilities plugin that crashed strict, its class not known and every item asking, before hetu quits', async () => {
    const gate = allowAll()
    const made = await harness({
      install: withCapabilities(), behave: { gate: { exports: { gate } } }, folder: { sync: worker('sync', [read, fetchOne]) },
      loader: { onFailure: () => {} },
    })
    await made.loader.start()
    made.loader.crashed({ kind: 'plugin', id: 'capabilities', half: 'host', incarnation: 1 }, 'closed')
    expect(made.loader.slot('capabilities')).toBe('failed')
    const request = await approved(made, 'sync')
    expect(request.notes).toContain(DOWN)
    expect(await stored(made, 'sync')).toMatchObject({ class: null, firstUse: [read, fetchOne] })
    expect((await stored(made, 'sync')).unclassed).toBeUndefined()
    expect(flags(gate, 'sync')).toEqual([read, fetchOne])
  })

  it('drops the mark at start from an entry written while off whose class and list come out as stored', async () => {
    const made = await harness({
      install: withCapabilities(), folder: { tool: worker('tool') },
      entries: { tool: root => entryFor(root, { granted: [exec], class: 4, firstUse: [exec], unclassed: true }) },
    })
    await made.loader.start()
    const entry = await stored(made, 'tool')
    expect(entry).toMatchObject({ class: 4, firstUse: [exec] })
    expect(entry.unclassed).toBeUndefined()
  })

  it('says on its own switch-off that nothing asks while it is off', async () => {
    const { made } = await asking()
    await made.loader.request({ kind: 'plugin.off', plugin: 'capabilities' }, trusted)
    const request = (await listed(made)).requests.find(held => held.kind === 'plugin.off')!
    expect(request.notes).toContain('Plugins then go unclassified and nothing asks at its first use until it is on again')
  })
})

// A move up applied with no Confirm on screen that crosses where the policy alerts raises a notice of its own in the
// trusted window. The higher class and its asks are stored already, so the notice is answered and never approved
describe('a move up with no Confirm on screen', () => {
  type Made = Awaited<ReturnType<typeof harness>>
  const commit: Capability = { type: 'history', access: 'commit', paths: ['notes/**'] }
  const stored = async (made: Made, id: string) => (await made.store.load()).state.plugins[id]!
  const notices = async (made: Made) => (await listed(made)).requests.filter(request => request.kind === 'class.raised')

  async function confirmOff(entries: Record<string, [Capability[], number]>): Promise<Made> {
    const made = await harness({
      install: withCapabilities(), switches: { confirmOff: true },
      folder: Object.fromEntries(Object.keys(entries).map(id => [id, worker(id)])),
      entries: Object.fromEntries(Object.entries(entries).map(([id, [granted, n]]) => [id, (root: string) => entryFor(root, { granted, class: n })])),
    })
    await made.loader.start()
    return made
  }

  it('raises a notice for a widen Confirm-off applied that moves its plugin into 4, its class and asks stored already', async () => {
    const made = await confirmOff({ sync: [[fetchOne], 3] })
    expect(await made.loader.request({ kind: 'grant.widen', plugin: 'sync', capability: read }, trusted)).toEqual({ applied: true })
    expect(await stored(made, 'sync')).toMatchObject({ class: 4, firstUse: [fetchOne] })
    expect((await notices(made)).map(request => [request.plugin, request.text, request.notes])).toEqual([[
      'sync', '"sync" moved from class 3, Network to class 4, Powerful with no Confirm on screen',
      ['Why: a grant given to "sync" without a Confirm', 'Its new class and the items that ask at first use are in place already. Confirm only says you saw it'],
    ]])
  })

  it('names the plugin a Confirm-off change moves through its links, with the plugin changed', async () => {
    const made = await confirmOff({ a: [[read, { type: 'plugin.call', targets: ['b'] }], 1], b: [[{ type: 'storage' }], 1] })
    await made.loader.request({ kind: 'grant.widen', plugin: 'b', capability: fetchOne }, trusted)
    expect((await notices(made)).map(request => [request.plugin, request.text, request.notes[0]])).toEqual([
      ['b', '"b" moved from class 1, Reader to class 4, Powerful with no Confirm on screen', 'Why: a grant given to "b" without a Confirm'],
      ['a', '"a" moved from class 1, Reader to class 4, Powerful with no Confirm on screen', 'Why: a grant given to "b" without a Confirm'],
    ])
  })

  it('raises nothing for a move up inside 1 to 3 that nobody confirmed', async () => {
    const made = await confirmOff({ tool: [[read], 1] })
    await made.loader.request({ kind: 'grant.widen', plugin: 'tool', capability: commit }, trusted)
    expect((await stored(made, 'tool')).class).toBe(2)
    expect(await notices(made)).toEqual([])
  })

  it('raises a notice for every move up a slot with no rule on alerts would show, inside 1 to 3 too', async () => {
    const role: Capabilities = { ...createCapabilities() }
    delete role.alerts
    const made = await harness({
      install: withCapabilities(), switches: { confirmOff: true }, behave: { capabilities: { exports: { capabilities: role } } },
      folder: { tool: worker('tool') }, entries: { tool: root => entryFor(root, { granted: [read], class: 1 }) },
    })
    await made.loader.start()
    await made.loader.request({ kind: 'grant.widen', plugin: 'tool', capability: commit }, trusted)
    expect((await notices(made)).map(request => request.text)).toEqual(['"tool" moved from class 1, Reader to class 2, Writer with no Confirm on screen'])
  })

  it('raises nothing for the same widen through the Confirm, which shows the move', async () => {
    const made = await harness({ install: withCapabilities(), folder: { sync: worker('sync') }, entries: { sync: root => entryFor(root, { granted: [fetchOne], class: 3 }) } })
    await made.loader.start()
    await made.loader.request({ kind: 'grant.widen', plugin: 'sync', capability: read }, trusted)
    const [held] = (await listed(made)).requests
    await made.loader.confirm(held!.id, {})
    expect((await stored(made, 'sync')).class).toBe(4)
    expect(await notices(made)).toEqual([])
  })

  it.each(['confirm', 'cancel'] as const)('changes nothing but what the entry owes when the human answers it with %s and the notice goes', async answer => {
    const made = await confirmOff({ sync: [[fetchOne], 3] })
    await made.loader.request({ kind: 'grant.widen', plugin: 'sync', capability: read }, trusted)
    const before = await made.store.load()
    const [notice] = await notices(made)
    if (answer === 'confirm') await made.loader.confirm(notice!.id, {})
    else await made.loader.cancel(notice!.id)
    expect(await notices(made)).toEqual([])
    expect(before.state.plugins.sync!.owed).toEqual({ from: 3, cause: 'widen', by: 'sync' })
    delete before.state.plugins.sync!.owed
    expect((await made.store.load()).state).toEqual(before.state)
  })

  it('takes no notice a window asks for, since only the core raises one', async () => {
    const made = await confirmOff({ sync: [[fetchOne], 3] })
    await expect(made.loader.request({ kind: 'class.raised', plugin: 'sync', from: 0, to: 4, cause: 'start', by: null } as unknown as Change, editor))
      .rejects.toMatchObject({ code: 'invalid' })
    expect(await notices(made)).toEqual([])
  })
})

// A pass over every entry leaves an entry as stored only with the capabilities plugin switched off by the human. A role
// that fails for an entry while the slot reads on stores that entry strict: the class not known and every item asking
describe('a pass whose role fails for one entry', () => {
  type Made = Awaited<ReturnType<typeof harness>>
  const hears: Capability = { type: 'events.subscribe', topics: ['reader.done'] }
  const stored = async (made: Made, id: string) => (await made.store.load()).state.plugins[id]!
  // The real policy, throwing for any plugin that holds a subscription
  function failingFor(): Capabilities {
    const real = createCapabilities()
    const hearing = (granted: readonly Capability[]) => granted.some(item => item.type === 'events.subscribe')
    return {
      ...real,
      classify: (granted, reachable, flow) => {
        if (hearing(granted)) throw new Error('broken for this one')
        return real.classify(granted, reachable, flow)
      },
    }
  }
  const setup = (switches: Partial<Switches> = {}) => harness({
    install: withCapabilities(), switches, behave: { capabilities: { exports: { capabilities: failingFor() } } },
    folder: { listener: worker('listener'), reader: worker('reader') },
    entries: {
      listener: root => entryFor(root, { granted: [fetchOne, hears], class: 3 }),
      reader: root => entryFor(root, { granted: [read], class: 1 }),
    },
  })

  it('stores that entry strict at start and classes the others', async () => {
    const made = await setup()
    await made.loader.start()
    expect(made.loader.slot('capabilities')).toBe('on')
    const listener = await stored(made, 'listener')
    expect({ class: listener.class, firstUse: listener.firstUse }).toEqual({ class: null, firstUse: [fetchOne, hears] })
    expect(listener.unclassed).toBeUndefined()
    expect((await stored(made, 'reader')).class).toBe(4)
    expect(made.link.events('fault')).toContainEqual({ plugin: 'capabilities', step: 'classify' })
  })

  it('stores that entry strict in the pass when the slot is switched on again', async () => {
    const made = await setup({ off: ['capabilities'] })
    await made.loader.start()
    expect((await stored(made, 'listener')).class).toBe(3)
    await made.loader.apply({ kind: 'plugin.on', plugin: 'capabilities' })
    await until(() => made.loader.slot('capabilities') === 'on')
    await made.loader.settled()
    await tick(30)
    expect(await stored(made, 'listener')).toMatchObject({ class: null, firstUse: [fetchOne, hears] })
  })
})

// An update of a plugin's code that applies with no Confirm on screen takes no confirmation with it: the new code asks
// again for every item that asks
describe('an update applied with no Confirm', () => {
  type Made = Awaited<ReturnType<typeof harness>>
  const hears: Capability = { type: 'events.subscribe', topics: ['reader.done'] }
  const calls: Capability = { type: 'plugin.call', targets: ['relay'] }
  const stored = async (made: Made, id: string) => (await made.store.load()).state.plugins[id]!
  const staged = async (made: Made, id: string, capabilities: Capability[]) => {
    const dir = path.join(made.dataDir, 'staging', `${id}-next`)
    await writeFolder(dir, filesFor(workerManifest(id, { version: '1.1.0', capabilities })))
    return made.loader.update(id, dir)
  }

  it('empties the record of a class 0 plugin whose update applied alone, so its items ask once the network comes back', async () => {
    const made = await harness({
      install: withCapabilities(), folder: { mid: worker('mid'), reader: worker('reader'), relay: worker('relay') },
      entries: {
        mid: root => entryFor(root, { granted: [hears, calls], class: 4 }),
        reader: root => entryFor(root, { granted: [read], class: 4 }),
        relay: root => entryFor(root, { granted: [fetchOne], class: 4 }),
      },
    })
    await made.loader.start()
    expect(await stored(made, 'mid')).toMatchObject({ class: 4, firstUse: [hears, calls] })
    await made.loader.apply({ kind: 'item.on', plugin: 'mid', capability: hears })
    await made.loader.apply({ kind: 'item.on', plugin: 'mid', capability: calls })
    await made.loader.apply({ kind: 'grant.narrow', plugin: 'relay', capability: fetchOne })
    expect(await stored(made, 'mid')).toMatchObject({ class: 0, confirmed: [hears, calls] })
    expect(await staged(made, 'mid', [hears, calls])).toEqual({ outcome: 'applied' })
    expect((await stored(made, 'mid')).confirmed).toBeUndefined()
    await made.loader.apply({ kind: 'grant.widen', plugin: 'relay', capability: fetchOne })
    expect(await stored(made, 'mid')).toMatchObject({ version: '1.1.0', class: 4, firstUse: [hears, calls] })
  })

  it('empties the record when the update applies Confirm-off and keeps it through a Confirm', async () => {
    for (const confirmOff of [true, false]) {
      const made = await harness({
        install: withCapabilities(), switches: { confirmOff }, folder: { tool: worker('tool') },
        entries: { tool: root => entryFor(root, { granted: [read, fetchOne], class: 4 }) },
      })
      await made.loader.start()
      await made.loader.apply({ kind: 'item.on', plugin: 'tool', capability: fetchOne })
      expect(await staged(made, 'tool', [read, fetchOne])).toMatchObject({ outcome: 'confirm' })
      const answer = await made.loader.request({ kind: 'plugin.update', plugin: 'tool' }, trusted)
      if (!confirmOff) await made.loader.confirm((answer as { held: string }).held, {})
      const entry = await stored(made, 'tool')
      expect(entry.version).toBe('1.1.0')
      expect({ firstUse: entry.firstUse ?? [], confirmed: entry.confirmed ?? [] })
        .toEqual(confirmOff ? { firstUse: [fetchOne], confirmed: [] } : { firstUse: [], confirmed: [fetchOne] })
      await cleanup()
    }
  })
})

// A notice for a move up with no Confirm on screen is owed in the plugin's entry, written with the class, and raised
// again at every start until the human answers it. Notices hold places of their own, and one that found no place is
// raised when one frees or at the next start
describe('a notice owed until the human answers it', () => {
  type Made = Awaited<ReturnType<typeof harness>>
  const hears = (...topics: string[]): Capability => ({ type: 'events.subscribe', topics })
  const calls = (...targets: string[]): Capability => ({ type: 'plugin.call', targets })
  const http = (version: string, capabilities: Capability[]): Listing =>
    ({ files: filesFor(hostManifest('http', { version, capabilities, provides: { topics: ['done'] } })) })
  const v1 = () => ({ ...withCapabilities(), http: http('1.0.0', []) })
  const fetches = () => ({ ...withCapabilities(), http: http('1.1.0', [fetchOne]) })
  const reads = () => ({ ...withCapabilities(), http: http('1.1.0', [read]) })
  const stored = async (made: Made, id: string) => (await made.store.load()).state.plugins[id]!
  const notices = async (made: Made) => (await listed(made)).requests.filter(held => held.kind === 'class.raised').map(held => held.text)
  const notice = (id: string, from: string, to: string) => `${JSON.stringify(id)} moved from ${from} to ${to} with no Confirm on screen`
  async function closed(made: Made): Promise<void> {
    await made.loader.shutdown().catch(() => {})
    made.carrier.close()
    made.link.carrier?.close()
  }
  // p stored at a class right under the first install, the install then updated
  async function updated(granted: Capability[], n: number, second: () => ReturnType<typeof v1>): Promise<{ base: string, made: Made }> {
    const base = await tempBase()
    const one = await harness({ base, install: v1(), folder: { p: worker('p', granted) }, entries: { p: root => entryFor(root, { granted, class: n }) } })
    await one.loader.start()
    await closed(one)
    const made = await harness({ base, install: second() })
    await made.loader.start()
    return { base, made }
  }

  it.each([
    ['out of 0', [calls('http')], 0, fetches, 'class 0, Contained', 'class 3, Network'],
    ['into 4', [fetchOne, hears('http.done')], 3, reads, 'class 3, Network', 'class 4, Powerful'],
  ] as [string, Capability[], number, () => ReturnType<typeof v1>, string, string][])('raises a notice for a move %s again at a restart nobody answered it in', async (_name, granted, n, second, from, to) => {
    const { base, made } = await updated(granted, n, second)
    expect(await notices(made)).toEqual([notice('p', from, to)])
    expect((await stored(made, 'p')).owed).toEqual({ from: n, cause: 'start', by: null })
    await closed(made)
    const again = await harness({ base, install: second() })
    await again.loader.start()
    expect(await notices(again)).toEqual([notice('p', from, to)])
  })

  it('raises it at the next start when the process died between the class written and the notice', async () => {
    const base = await tempBase()
    const granted = [calls('http')]
    const one = await harness({ base, install: v1(), folder: { p: worker('p', granted) }, entries: { p: root => entryFor(root, { granted, class: 0 }) } })
    await one.loader.start()
    await closed(one)
    const dying = await harness({ base, install: fetches() })
    ;(dying.loader as unknown as { raiseOwed: () => void }).raiseOwed = () => {
      throw new Error('the process died here')
    }
    await dying.loader.start().catch(() => {})
    expect((await stored(dying, 'p')).class).toBe(3)
    await closed(dying)
    const next = await harness({ base, install: fetches() })
    await next.loader.start()
    expect(await notices(next)).toEqual([notice('p', 'class 0, Contained', 'class 3, Network')])
  })

  it.each(['confirm', 'cancel'] as const)('clears what is owed once the human answers with %s, so no restart raises it again', async answer => {
    const { base, made } = await updated([calls('http')], 0, fetches)
    const [held] = (await listed(made)).requests.filter(request => request.kind === 'class.raised')
    if (answer === 'confirm') await made.loader.confirm(held!.id, {})
    else await made.loader.cancel(held!.id)
    expect((await stored(made, 'p')).owed).toBeUndefined()
    expect(await stored(made, 'p')).toMatchObject({ class: 3 })
    await closed(made)
    const again = await harness({ base, install: fetches() })
    await again.loader.start()
    expect(await notices(again)).toEqual([])
  })

  it('keeps one notice per plugin from the class last shown to the one it holds now', async () => {
    const { base, made } = await updated([calls('http')], 0, fetches)
    await closed(made)
    const further = await harness({ base, install: { ...withCapabilities(), http: http('1.2.0', [read, fetchOne]) } })
    await further.loader.start()
    expect(await notices(further)).toEqual([notice('p', 'class 0, Contained', 'class 4, Powerful')])
    expect((await stored(further, 'p')).owed).toEqual({ from: 0, cause: 'start', by: null })
  })

  it('owes nothing once the plugin is back where nothing alerts', async () => {
    const { base, made } = await updated([calls('http')], 0, fetches)
    await closed(made)
    const back = await harness({ base, install: { ...withCapabilities(), http: http('1.2.0', []) } })
    await back.loader.start()
    expect(await stored(back, 'p')).toMatchObject({ class: 0 })
    expect((await stored(back, 'p')).owed).toBeUndefined()
    expect(await notices(back)).toEqual([])
  })
})
