import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecurityList, StagedSource } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import type { Change } from '../api/changes.ts'
import type { Caller } from '../api/envelope.ts'
import { folderManifest } from '../api/manifest.ts'
import type { StagedRead, Staging, Stagings } from '../backend/plugins-manager/header.ts'
import { cleanup, entryFor, filesFor, harness, workerManifest } from './plugins-manager-fakes.ts'

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
    ...rest,
  }
}

// The stagings as main will hold them: each by its handle, what install was asked for and what was dropped. An install
// drops its staging as main's does
function fakeStagings(plugins: StagedRead[], source: StagedSource = { kind: 'zip', path: '/tmp/p.zip' }) {
  const held = new Map<string, Staging>([['s1', { source, plugins }]])
  const installed: { handle: string, plugins: unknown }[] = []
  const unstaged: string[] = []
  const stagings: Stagings = {
    held: handle => held.get(handle) ?? null,
    install: async (handle, ticked) => {
      installed.push({ handle, plugins: ticked })
      held.delete(handle)
    },
    unstage: handle => {
      unstaged.push(handle)
      held.delete(handle)
    },
  }
  return { held, installed, unstaged, stagings }
}

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
    expect(made.fake.installed).toEqual([])
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
    const fake = fakeStagings([staged('search')], { kind: 'link', link: 'https://github.com/someone/plugins', asset: 'plugins.zip', tag: 'v2' })
    const made = await harness({ pluginsManager: { stagings: fake.stagings } })
    await made.pluginsManager.start()
    heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    const list = await made.pluginsManager.serve({ callId: 'c1', caller: trusted, root: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 }) as SecurityList
    expect(list.requests[0].notes[0]).toBe('From "plugins.zip" in the release "v2" of "https://github.com/someone/plugins"')
  })

  it('installs on its Confirm, after the Confirm record, from the staging with each plugin\'s digest', async () => {
    const made = await started([staged('search'), staged('tags')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    await made.pluginsManager.confirm(id, {})
    expect(made.fake.installed).toEqual([{ handle: 's1', plugins: [{ id: 'search', digest: DIGEST }] }])
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
    expect(made.fake.installed).toEqual([])
  })
})

describe('an install whose staging moved', () => {
  it('answers stale and installs nothing when the staging went before the Confirm', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    made.fake.held.delete('s1')
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('stale')
    expect(made.fake.installed).toEqual([])
    expect(made.pluginsManager.pending()).toEqual([])
  })

  it('answers stale when the staging holds another manifest under the handle by the Confirm', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    made.fake.held.set('s1', { source: { kind: 'zip', path: '/tmp/p.zip' }, plugins: [staged('search', { digest: OTHER })] })
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('stale')
    expect(made.fake.installed).toEqual([])
  })

  // A plugin of that id approved from the plugin folder, or its entry edited outside hetu, while the Confirm waited
  it('answers stale when the entry of a plugin it installs was written before the Confirm', async () => {
    const made = await started([staged('search')])
    const id = heldId(await made.pluginsManager.request(install([{ id: 'search', digest: DIGEST }]), trusted))
    await mkdir(path.join(made.dataDir, 'state', 'plugins'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'state', 'plugins', 'search.json'), 'planted')
    expect(await code(made.pluginsManager.confirm(id, {}))).toBe('stale')
    expect(made.fake.installed).toEqual([])
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

  it('applies nothing for a digest that isn\'t the staged manifest\'s, however it reaches apply', async () => {
    const made = await started([staged('search')])
    expect(await code(made.pluginsManager.apply(install([{ id: 'search', digest: OTHER }])))).not.toBe('none')
    expect(made.fake.installed).toEqual([])
    await made.pluginsManager.apply(install([{ id: 'search', digest: DIGEST }]))
    expect(made.fake.installed).toHaveLength(1)
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
    expect(made.fake.installed).toEqual([])
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
