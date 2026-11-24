import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecurityList, StagedSource } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import type { Change } from '../api/changes.ts'
import type { Caller } from '../api/envelope.ts'
import { folderManifest } from '../api/manifest.ts'
import type { StagedRead, Staging, Stagings } from '../backend/plugins-manager/header.ts'
import { hashFiles } from '../lib/hash-files.ts'
import type { Read } from '../backend/plugins-manager/verify.ts'
import { cleanup, entryFor, filesFor, harness, until, workerManifest } from './plugins-manager-fakes.ts'

afterEach(cleanup)

const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const notes: Capability = { type: 'luoshu.read', paths: ['notes/**'] }
const fetch: Capability = { type: 'net.fetch', hosts: ['example.com'] }
const DIGEST = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const UNSIGNED = 'Unsigned: nothing proves who made these plugins. Install only what comes from a source you trust'

// One plugin of a staging as the core read it: a manifest that checks out unless a problem is named
function staged(id: string, extra: Partial<StagedRead> & { asks?: Capability[], name?: string, version?: string } = {}): StagedRead {
  const { asks, name, version, ...rest } = extra
  return {
    id,
    digest: DIGEST,
    manifest: folderManifest.parse(workerManifest(id, { ...(name === undefined ? {} : { name }), ...(version === undefined ? {} : { version }), ...(asks === undefined ? {} : { capabilities: asks }) })),
    problem: null,
    removedTypes: [],
    ...rest,
  }
}

// One staged plugin's bytes as main reads them again for the install: its manifest and worker as written
function bytesOf(plugin: StagedRead): Read {
  const files = Object.entries(filesFor({ ...plugin.manifest })).map(([name, text]) => ({ path: name, bytes: Buffer.from(text) }))
  return { files, hash: hashFiles(files), manifest: plugin.manifest, problem: null, removedTypes: [] }
}

// The stagings as main holds them: each by its handle, the plugins read again for an install and the stagings dropped
function fakeStagings(plugins: StagedRead[], source: StagedSource = { kind: 'zip', path: '/tmp/p.zip' }) {
  const held = new Map<string, Staging>([['s1', { source, plugins }]])
  const reads: string[] = []
  const unstaged: string[] = []
  const stagings: Stagings = {
    held: handle => held.get(handle) ?? null,
    read: async (handle, id) => {
      reads.push(id)
      const plugin = held.get(handle)?.plugins.find(one => one.id === id)
      return plugin === undefined || plugin.manifest === null ? null : bytesOf(plugin)
    },
    findRelease: async () => ({ problem: 'offline' }),
    stageRelease: async () => ({ problem: 'offline' }),
    unstage: handle => {
      unstaged.push(handle)
      held.delete(handle)
    },
    close: async () => {},
  }
  return { held, reads, unstaged, stagings }
}

// The plugins with an entry, which only an install writes in these tests
const entries = async (made: { store: { load(): Promise<{ state: { plugins: Record<string, unknown> } }> } }) =>
  Object.keys((await made.store.load()).state.plugins).sort()

const install = (plugins: { id: string, digest: string }[], handle = 's1'): Change => ({ kind: 'plugin.install', staged: handle, plugins })
const heldId = (answer: { applied: true } | { held: string }) => {
  if (!('held' in answer)) throw new Error('applied, not held')
  return answer.held
}
const code = (work: Promise<unknown>) => work.then(() => 'none', (err: { code?: string }) => err.code ?? String(err))

async function started(plugins: StagedRead[], options: Parameters<typeof harness>[0] = {}) {
  const fake = fakeStagings(plugins)
  const made = await harness({ ...options, pluginsManager: { stagings: fake.stagings } })
  await made.pluginsManager.start()
  const list = async () => await made.pluginsManager.serve({
    callId: 'c1', caller: trusted, root: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000,
  }) as SecurityList
  return { ...made, fake, list }
}

describe('the Install button\'s Confirm', () => {
  it('waits as a held request in the plugins manager\'s words: the source, unsigned, then each plugin with its grants and class', async () => {
    const made = await started([staged('search', { name: 'Search', version: '1.2.0', asks: [notes, fetch] })])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    expect(made.pluginsManager.pending()).toEqual([{ id, kind: 'plugin.install', plugin: null }])
    const [request] = (await made.list()).requests
    expect(request).toMatchObject({ id, kind: 'plugin.install', text: 'Install search into the plugin folder and approve it with the grants its manifest asks for' })
    expect(request.notes).toEqual([
      'From the zip "/tmp/p.zip"', UNSIGNED, '"Search" (search), version 1.2.0',
      'search: Read the notes at "notes/**"', 'search: Send data to and get data from "example.com" over the network',
      'search: Class 4, Powerful: it can read notes and reach the network, so it could send notes out',
    ])
    expect(await entries(made)).toEqual([])
  })

  it('names each plugin it installs in the order ticked, what one replaces and one that asks for nothing', async () => {
    const made = await started([staged('alpha', { version: '2.0.0' }), staged('tags', { asks: [{ type: 'ui.view' }] })], {
      folder: { alpha: filesFor(workerManifest('alpha')) }, entries: { alpha: root => entryFor(root) },
    })
    heldId(await made.pluginsManager.request(install([{ id: 'tags', digest: DIGEST }, { id: 'alpha', digest: DIGEST }]), trusted))
    const [request] = (await made.list()).requests.filter(one => one.kind === 'plugin.install')
    expect(request.text).toBe('Install tags, alpha into the plugin folder and approve each with the grants its manifest asks for')
    expect(request.notes.slice(2)).toEqual([
      '"tags" (tags), version 1.0.0', 'tags: Show panes and items of its own in the editor window', 'tags: Class 0, Contained',
      '"alpha" (alpha), version 2.0.0, replacing version 1.0.0', 'alpha: It asks for nothing', 'alpha: Class 0, Contained',
    ])
  })

  it('names the release a link\'s zip came from', async () => {
    const fake = fakeStagings([staged('search')], { kind: 'link', link: 'https://github.com/someone/plugins', asset: 'plugins.zip', tag: 'v2', verified: true })
    const made = await harness({ pluginsManager: { stagings: fake.stagings } })
    await made.pluginsManager.start()
    heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    const list = await made.pluginsManager.serve({ callId: 'c1', caller: trusted, root: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 }) as SecurityList
    expect(list.requests[0].notes[0]).toBe('From "plugins.zip" in the release "v2" of "https://github.com/someone/plugins", matching the checksum GitHub lists for it')
  })

  it('installs on its Confirm, after the Confirm record, from the staging with each plugin\'s digest', async () => {
    const made = await started([staged('search'), staged('tags')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    await made.pluginsManager.confirm(id, {})
    expect(await entries(made)).toEqual(['search'])
    expect(made.fake.reads).toEqual(['search'])
    const order = made.link.records.map(record => record.event).filter(event => event.startsWith('security.'))
    expect(order).toEqual(['security.request', 'security.confirm', 'security.applied'])
    expect(made.link.events('security.applied')).toMatchObject([{ kind: 'plugin.install', target: 'search', by: 'confirm' }])
    expect(made.pluginsManager.pending()).toEqual([])
  })

  it('records the plugins it installs as its target, never the staging or its source', async () => {
    const made = await started([staged('search'), staged('tags')])
    heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }, { id: 'tags', digest: DIGEST }]), trusted))
    const [record] = made.link.events('security.request')
    expect(record).toMatchObject({ kind: 'plugin.install', target: 'search,tags', window: 'trusted' })
    expect(JSON.stringify(record)).not.toContain('s1')
    expect(JSON.stringify(record)).not.toContain('p.zip')
  })

  it('applies nothing before the Confirm from the editor window either', async () => {
    const made = await started([staged('search')])
    heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), editor))
    expect(await entries(made)).toEqual([])
  })
})

describe('an install whose staging moved', () => {
  it('answers stale and installs nothing when the staging went before the Confirm', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    made.fake.held.delete('s1')
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('stale')
    expect(await entries(made)).toEqual([])
    expect(made.pluginsManager.pending()).toEqual([])
  })

  it('answers stale when the staging holds another manifest under the handle by the Confirm', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    made.fake.held.set('s1', { source: { kind: 'zip', path: '/tmp/p.zip' }, plugins: [staged('search', { digest: OTHER })] })
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('stale')
    expect(await entries(made)).toEqual([])
  })

  // A plugin of that id approved from the plugin folder, or its entry edited outside hetu, while the Confirm waited
  it('answers stale when the entry of a plugin it installs was written before the Confirm', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    await mkdir(path.join(made.dataDir, 'state', 'plugins'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'state', 'plugins', 'search.json'), 'planted')
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('stale')
    expect(await entries(made)).toEqual([])
  })

  it('refuses at once a digest that isn\'t the staged manifest\'s, a plugin not in the staging and one that can\'t install', async () => {
    const made = await started([staged('search'), staged('odd', { manifest: null, problem: 'invalid' }), staged('kept', { problem: 'reserved' })])
    expect(await code(made.pluginsManager.request(install([{ id: 'search', digest: OTHER }]), trusted))).toBe('stale')
    expect(await code(made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }, { id: 'gone', digest: DIGEST }]), trusted))).toBe('stale')
    expect(await code(made.pluginsManager.request(install([{ id: 'odd', digest: DIGEST }]), trusted))).toBe('invalid')
    expect(await code(made.pluginsManager.request(install([{ id: 'kept', digest: DIGEST }]), trusted))).toBe('invalid')
    expect(await code(made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }], 's9'), trusted))).toBe('not-found')
    expect(made.pluginsManager.pending()).toEqual([])
    expect(made.link.events('security.request')).toEqual([])
  })

  it('applies nothing for a digest that isn\'t the staged manifest\'s, however it reaches apply, dropping the staging', async () => {
    const made = await started([staged('search')])
    expect(await code(made.pluginsManager.apply(install([{ id: 'search', digest: OTHER }])))).toBe('stale')
    expect(await entries(made)).toEqual([])
    expect(made.fake.unstaged).toEqual(['s1'])
    expect(await code(made.pluginsManager.apply(install([{ id: 'search', digest: DIGEST }])))).toBe('not-found')
  })

  it('answers not-found with no stagings to install from', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    expect(await code(made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))).toBe('not-found')
  })
})

describe('an install the human cancelled', () => {
  it('drops its staging with nothing installed', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    await made.pluginsManager.cancel(id)
    expect(made.fake.unstaged).toEqual(['s1'])
    expect(await entries(made)).toEqual([])
    expect(made.link.events('security.cancel')).toMatchObject([{ kind: 'plugin.install', target: 'search' }])
  })
})

// main's stagings are code the plugins manager doesn't own, so a throw there keeps the trusted window drawing
describe('stagings that throw', () => {
  it('leave the list drawn, the held install unworded and a new one not-found', async () => {
    const made = await started([staged('search')])
    heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    made.fake.stagings.held = () => {
      throw new Error('main threw')
    }
    const [request] = (await made.list()).requests
    expect(request).toMatchObject({ kind: 'plugin.install', notes: [] })
    expect(await code(made.pluginsManager.request(install([{ id: 'search', digest: OTHER }]), trusted))).toBe('not-found')
  })

  it('still drop a cancelled install', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    made.fake.stagings.unstage = () => {
      throw new Error('main threw')
    }
    await made.pluginsManager.cancel(id)
    expect(made.pluginsManager.pending()).toEqual([])
  })
})

const calls = (...targets: string[]): Capability => ({ type: 'plugin.call', targets })
const hears = (...topics: string[]): Capability => ({ type: 'events.subscribe', topics })
const PAIR = 'Class 4, Powerful: it can read notes and reach the network, so it could send notes out'

// The Install button's Confirm for the plugins ticked, the lines under each id by that id
async function wordsOf(made: Awaited<ReturnType<typeof started>>, ids: string[]): Promise<Map<string, string[]>> {
  heldId(await made.pluginsManager.request(install(ids.map(id => ({ id, digest: DIGEST }))), trusted))
  const [request] = (await made.list()).requests.filter(one => one.kind === 'plugin.install')
  return new Map(ids.map(id => [id, request.notes.filter(line => line.startsWith(`${id}: `)).map(line => line.slice(id.length + 2))]))
}

// Links between plugins are declared in their manifests and enforced by the router, so the plugins installed together
// are classed with each other's links and grants as if installed
describe('an install of several plugins', () => {
  it('classes each with the others\' plugin.call links and grants, so the pair shows on the one Confirm', async () => {
    const made = await started([staged('reader', { asks: [notes, calls('sender')] }), staged('sender', { asks: [fetch] })])
    const words = await wordsOf(made, ['reader', 'sender'])
    expect(words.get('reader')).toContain(PAIR)
    expect(words.get('sender')).toContain(PAIR)
    expect(words.get('sender')).toContain('Plugins that read and are connected to it through plugin.call: reader')
  })

  it('follows a subscription from the plugin that owns the topic to the one that hears it', async () => {
    const made = await started([staged('speaker', { asks: [notes] }), staged('listener', { asks: [hears('speaker.changed'), fetch] })])
    const words = await wordsOf(made, ['speaker', 'listener'])
    expect(words.get('listener')).toContain(PAIR)
    expect(words.get('listener')).toContain('Plugins that read and can reach it through events: speaker')
    expect(words.get('speaker')).toContain(PAIR)
    expect(words.get('speaker')).toContain('Plugins with network it can reach through events: listener')
  })

  it('never follows a subscription back, so a reader hearing a network plugin makes no pair', async () => {
    const made = await started([staged('quiet', { asks: [notes, hears('noisy.changed')] }), staged('noisy', { asks: [fetch] })])
    const words = await wordsOf(made, ['quiet', 'noisy'])
    expect(words.get('quiet')).toContain('Class 1, Reader')
    expect(words.get('noisy')).toContain('Class 3, Network')
  })

  it('counts no link the manifests don\'t declare', async () => {
    const made = await started([staged('reader', { asks: [notes] }), staged('sender', { asks: [fetch] })])
    const words = await wordsOf(made, ['reader', 'sender'])
    expect(words.get('reader')).toEqual(['Read the notes at "notes/**"', 'Class 1, Reader'])
    expect(words.get('sender')).toEqual(['Send data to and get data from "example.com" over the network', 'Class 3, Network'])
  })

  it('counts the plugins installed as well, as a single install does', async () => {
    const made = await started([staged('reader', { asks: [notes, calls('mail')] }), staged('tags', { asks: [{ type: 'ui.view' }] })], {
      folder: { mail: filesFor(workerManifest('mail', { capabilities: [fetch] })) },
      entries: { mail: root => entryFor(root, { granted: [fetch], class: 3 }) },
    })
    const words = await wordsOf(made, ['reader', 'tags'])
    expect(words.get('reader')).toContain(PAIR)
    expect(words.get('reader')).toContain('Raises mail from class 3, Network to class 4, Powerful')
    expect(words.get('tags')).toEqual(['Show panes and items of its own in the editor window', 'Class 0, Contained'])
  })

  it('counts a plugin it updates with the grants its new version asks for', async () => {
    const made = await started([staged('reader', { asks: [notes, calls('alpha')] }), staged('alpha', { version: '2.0.0', asks: [fetch] })], {
      folder: { alpha: filesFor(workerManifest('alpha')) }, entries: { alpha: root => entryFor(root, { class: 0 }) },
    })
    const words = await wordsOf(made, ['reader', 'alpha'])
    expect(words.get('reader')).toContain(PAIR)
    expect(words.get('alpha')).toContain(PAIR)
  })
})

describe('an install of one plugin', () => {
  it('is classed against the plugins installed, never another plugin of its staging left unticked', async () => {
    const made = await started([staged('reader', { asks: [notes, calls('sender')] }), staged('sender', { asks: [fetch] })])
    const words = await wordsOf(made, ['reader'])
    expect(words.get('reader')).toEqual(['Read the notes at "notes/**"', 'Call the plugin "sender"', 'Class 1, Reader'])
  })
})

// The class each plugin is stored with, from the entry the install wrote
const storedClass = async (made: Awaited<ReturnType<typeof started>>, id: string) => (await made.store.load()).state.plugins[id]?.class
// The class number the Confirm showed under a plugin's id
const shownClass = (words: Map<string, string[]>, id: string) => Number(/^Class (\d)/.exec(words.get(id)!.find(line => line.startsWith('Class ')) ?? '')?.[1])

describe('an install confirmed', () => {
  it('writes each plugin into the plugin folder, approves it with the class the Confirm showed, allows its build and starts it', async () => {
    const made = await started([staged('search', { asks: [notes, fetch] })])
    const words = await wordsOf(made, ['search'])
    const [request] = (await made.list()).requests
    await made.pluginsManager.confirm(request.id, {})
    const { state } = await made.store.load()
    const entry = state.plugins.search
    expect(entry).toMatchObject({ version: '1.0.0', signer: null, granted: [notes, fetch], enabled: true })
    expect(entry.class).toBe(shownClass(words, 'search'))
    expect(entry.class).toBe(4)
    expect(entry.contentHash).toBe(bytesOf(staged('search', { asks: [notes, fetch] })).hash)
    expect(state.switches.allowUnsigned).toContain(entry.contentHash)
    expect(await readFile(path.join(made.dataDir, 'plugins', 'search', 'hetu-plugin.json'), 'utf8')).toContain('"search"')
    await until(() => made.runtime.order().includes('search'))
    expect(made.pluginsManager.plugin('search')?.state).not.toBe('refused')
    expect(made.fake.unstaged).toEqual(['s1'])
  })

  // Approving each alone, or classing each once the others were written, would store reader as class 1
  it('stores the classes the Confirm showed for plugins linked to each other in one install', async () => {
    const made = await started([staged('reader', { asks: [notes, calls('sender')] }), staged('sender', { asks: [fetch] })])
    const words = await wordsOf(made, ['reader', 'sender'])
    const [request] = (await made.list()).requests
    await made.pluginsManager.confirm(request.id, {})
    expect(await storedClass(made, 'reader')).toBe(shownClass(words, 'reader'))
    expect(await storedClass(made, 'sender')).toBe(shownClass(words, 'sender'))
    expect([await storedClass(made, 'reader'), await storedClass(made, 'sender')]).toEqual([4, 4])
  })

  it('writes a plugin it updates from its own class, never from what another plugin made of it before the install', async () => {
    const made = await started([staged('alpha', { version: '2.0.0', asks: [fetch] }), staged('reader', { asks: [notes, calls('alpha')] })], {
      folder: { alpha: filesFor(workerManifest('alpha')) }, entries: { alpha: root => entryFor(root, { class: 0 }) },
    })
    const words = await wordsOf(made, ['alpha', 'reader'])
    const [request] = (await made.list()).requests
    await made.pluginsManager.confirm(request.id, {})
    const { state } = await made.store.load()
    expect(state.plugins.alpha).toMatchObject({ version: '2.0.0', granted: [fetch], class: shownClass(words, 'alpha') })
    expect(state.plugins.reader.class).toBe(shownClass(words, 'reader'))
  })

  it('answers stale when a change since the request would store another class than the one asked about', async () => {
    const made = await started([staged('sender', { asks: [fetch] })], {
      folder: { mail: filesFor(workerManifest('mail', { capabilities: [notes] })) },
      entries: { mail: root => entryFor(root, { granted: [notes], class: 1 }) },
    })
    const words = await wordsOf(made, ['sender'])
    expect(shownClass(words, 'sender')).toBe(3)
    const [request] = (await made.list()).requests
    await made.pluginsManager.apply({ kind: 'grant.widen', plugin: 'mail', capability: calls('sender') })
    expect(await code(made.pluginsManager.confirm(request.id, {}))).toBe('stale')
    expect(await storedClass(made, 'sender')).toBeUndefined()
  })

  it('fails and installs nothing when the staged bytes no longer hash to what was shown', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    made.fake.stagings.read = async () => null
    // A refusal past the Confirm's record answers failed, as every change that can't apply does
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('failed')
    expect(made.link.events('security.failed')).toMatchObject([{ kind: 'plugin.install', target: 'search' }])
    expect(await entries(made)).toEqual([])
    expect(made.fake.unstaged).toEqual(['s1'])
    expect(made.runtime.order()).not.toContain('search')
  })

  it('replaces a running plugin: stopped, started again on the new bytes, its old build no longer allowed', async () => {
    const made = await started([staged('alpha', { version: '2.0.0', asks: [{ type: 'ui.view' }] })], {
      folder: { alpha: filesFor(workerManifest('alpha')) }, entries: { alpha: root => entryFor(root, { class: 0 }) },
    })
    await until(() => made.runtime.order().includes('alpha'))
    const old = (await made.store.load()).state.plugins.alpha.contentHash
    const id = heldId(await made.pluginsManager.request(install([{ id: 'alpha', digest: DIGEST }]), trusted))
    await made.pluginsManager.confirm(id, {})
    await until(() => made.runtime.order().filter(one => one === 'alpha').length === 2)
    const { state } = await made.store.load()
    expect(state.plugins.alpha).toMatchObject({ version: '2.0.0', granted: [{ type: 'ui.view' }] })
    expect(state.switches.allowUnsigned).not.toContain(old)
    expect(state.switches.allowUnsigned).toContain(state.plugins.alpha.contentHash)
  })

  it('refuses at once two plugins that would hold one role, or one taking a role another plugin holds', async () => {
    const door: Capability = { type: 'door.handle' }
    const made = await started([staged('one', { asks: [door] }), staged('two', { asks: [door] })], {
      folder: { held: filesFor(workerManifest('held', { capabilities: [door] })) },
      entries: { held: root => entryFor(root, { granted: [door] }) },
    })
    expect(await code(made.pluginsManager.request(install([{ id: 'one', digest: DIGEST }]), trusted))).toBe('invalid')
    const fresh = await started([staged('one', { asks: [door] }), staged('two', { asks: [door] })])
    expect(await code(fresh.pluginsManager.request(install([{ id: 'one', digest: DIGEST }, { id: 'two', digest: DIGEST }]), trusted))).toBe('invalid')
    heldId(await fresh.pluginsManager.request(install([{ id: 'one', digest: DIGEST }]), trusted))
  })

  // A folder put in the plugin folder by hand, or found at start and never approved, is no install's to replace
  it('refuses a plugin whose folder is there with no entry and leaves that folder as it was', async () => {
    const made = await started([staged('search')], { folder: { search: filesFor(workerManifest('search', { version: '0.1.0' })) } })
    const before = await readFile(path.join(made.dataDir, 'plugins', 'search', 'hetu-plugin.json'), 'utf8')
    expect(await code(made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))).toBe('invalid')
    expect(await code(made.pluginsManager.apply(install([{ id: 'search', digest: DIGEST }])))).toBe('invalid')
    expect(await readFile(path.join(made.dataDir, 'plugins', 'search', 'hetu-plugin.json'), 'utf8')).toBe(before)
    expect(await entries(made)).toEqual([])
    expect(made.pluginsManager.pending().map(one => one.kind)).toEqual(['plugin.approve'])
  })

  it('refuses a folder put there after the start just the same', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    await mkdir(path.join(made.dataDir, 'plugins', 'search'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'plugins', 'search', 'planted.js'), 'planted')
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('failed')
    expect(await readFile(path.join(made.dataDir, 'plugins', 'search', 'planted.js'), 'utf8')).toBe('planted')
    expect(await entries(made)).toEqual([])
  })

  it('leaves a plugin written before a later write failed with its build not allowed, refused unsigned and not run', async () => {
    const made = await started([staged('search'), staged('tags')])
    const write = made.store.writePlugin.bind(made.store)
    made.store.writePlugin = async (id, entry) => {
      if (id === 'tags') throw new Error('disk full')
      return write(id, entry)
    }
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }, { id: 'tags', digest: DIGEST }]), trusted))
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('failed')
    const { state } = await made.store.load()
    expect(Object.keys(state.plugins)).toEqual(['search'])
    expect(state.switches.allowUnsigned).not.toContain(state.plugins.search.contentHash)
    expect(made.pluginsManager.list().find(row => row.id === 'search')).toMatchObject({ state: 'refused', reason: 'unsigned' })
    expect(made.runtime.order()).toEqual([])
    expect(made.fake.unstaged).toEqual(['s1'])
  })

  it('runs nothing when allowing the builds fails, every entry written refused unsigned', async () => {
    const made = await started([staged('search')])
    made.store.writeSwitches = async () => {
      throw new Error('disk full')
    }
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('failed')
    expect(await entries(made)).toEqual(['search'])
    expect(made.pluginsManager.list().find(row => row.id === 'search')).toMatchObject({ state: 'refused', reason: 'unsigned' })
    expect(made.runtime.order()).toEqual([])
    expect(made.fake.unstaged).toEqual(['s1'])
  })

  it('installs nothing once shutdown began and drops the staging', async () => {
    const made = await started([staged('search')])
    await made.pluginsManager.shutdown()
    expect(await code(made.pluginsManager.apply(install([{ id: 'search', digest: DIGEST }])))).toBe('stopped')
    expect(await entries(made)).toEqual([])
    expect(made.fake.unstaged).toEqual(['s1'])
  })
})

// The startup flow is decided at start from the plugin folder and ends once a plugin is installed. A folder emptied
// later in the run leaves it ended until the next start
describe('the startup flow', () => {
  it('is due at a start with no plugin in the plugin folder, in the list and for main alike', async () => {
    const made = await started([staged('search')])
    expect(made.pluginsManager.startupDue()).toBe(true)
    expect((await made.list()).startupDue).toBe(true)
  })

  it('is not due at a start with a plugin in the plugin folder', async () => {
    const made = await started([], { folder: { alpha: filesFor(workerManifest('alpha')) }, entries: { alpha: root => entryFor(root) } })
    expect(made.pluginsManager.startupDue()).toBe(false)
    expect((await made.list()).startupDue).toBe(false)
  })

  it('ends once a plugin is installed and stays ended when every plugin is removed again', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    await made.pluginsManager.confirm(id, {})
    expect(made.pluginsManager.startupDue()).toBe(false)
    expect((await made.list()).startupDue).toBe(false)
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'search' })
    expect((await made.list()).plugins.filter(plugin => plugin.from === 'folder')).toEqual([])
    expect(made.pluginsManager.startupDue()).toBe(false)
    expect((await made.list()).startupDue).toBe(false)
  })
})
