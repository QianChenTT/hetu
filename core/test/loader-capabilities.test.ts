import { afterEach, describe, expect, it } from 'vitest'
import type { HeldRequest, SecurityList } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import path from 'node:path'
import {
  cleanup, coreInstall, entryFor, filesFor, harness, hostManifest, reasonOf, stateOf, until, workerManifest, writeFolder, type Files,
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
    expect(request.notes).toContain('Plugins that read and are connected to it through plugin.call or events: notes')
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
    expect(request.notes).toContain('Plugins that read and are connected to it through plugin.call or events: reader')
    await made.loader.apply({ kind: 'grant.widen', plugin: 'bridge', capability: { type: 'ui.view' } })
    expect((await made.store.load()).state.plugins.bridge.class).toBe(4)
  })
})

// Publishing needs no grant, so a reader can signal a plugin that hears its topics by when it publishes
describe('the plugins linked by a subscription to another plugin\'s topics', () => {
  it('count as connected, so a network plugin hearing a reader\'s topic is class 4 and names the reader', async () => {
    const hears = { type: 'events.subscribe', topics: ['reader.done'] } as Capability
    const made = await harness({
      install: withCapabilities(),
      folder: { reader: worker('reader'), sender: worker('sender', [fetchOne, hears]) },
      entries: { reader: root => entryFor(root, { granted: [read], class: 1 }) },
    })
    await made.loader.start()
    const request = await approved(made, 'sender')
    const entry = (await made.store.load()).state.plugins.sender
    expect(entry.class).toBe(4)
    expect(entry.firstUse).toEqual([fetchOne])
    expect(request.notes).toContain('Plugins that read and are connected to it through plugin.call or events: reader')
  })

  it('ask at the first use of the subscription that closes a reader\'s pair with no network of its own', async () => {
    const hears = { type: 'events.subscribe', topics: ['sender.sent'] } as Capability
    const made = await harness({
      install: withCapabilities(),
      folder: { reader: worker('reader', [read, hears]), sender: worker('sender') },
      entries: { sender: root => entryFor(root, { granted: [fetchOne], class: 3 }) },
    })
    await made.loader.start()
    await approved(made, 'reader')
    const entry = (await made.store.load()).state.plugins.reader
    expect(entry.class).toBe(4)
    expect(entry.firstUse).toEqual([hears])
  })

  it('leave a plugin hearing only its own topics unlinked', async () => {
    const own = { type: 'events.subscribe', topics: ['sender.sent'] } as Capability
    const made = await harness({
      install: withCapabilities(),
      folder: { reader: worker('reader'), sender: worker('sender', [fetchOne, own]) },
      entries: { reader: root => entryFor(root, { granted: [read], class: 1 }) },
    })
    await made.loader.start()
    await approved(made, 'sender')
    expect((await made.store.load()).state.plugins.sender.class).toBe(3)
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
