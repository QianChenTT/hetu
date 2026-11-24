import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Plugin } from '../backend/boot/state.ts'
import {
  cleanup, entryFor, filesFor, harness, hashOf, manifest, oldFirstPartyEntry, plant, reasonOf, stateOf, workerManifest,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const outline = () => filesFor(workerManifest('outline'))
// An entry for a folder that isn't there
const noFolder = async (): Promise<Plugin> =>
  ({ version: '1.0.0', contentHash: 'd'.repeat(64), signer: 'sigstore:someone', granted: [], class: null, enabled: true })

describe('a plugin-folder plugin\'s bytes', () => {
  it('are refused tampered when they don\'t match the entry, and the plugin never starts', async () => {
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger', { requires: ['outline'] })) },
      entries: { outline: signed(), tagger: signed() },
    })
    await writeFile(path.join(made.dataDir, 'plugins', 'outline', 'worker.js'), 'evil()')
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'outline')).toBe('refused')
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('tampered')
    expect(made.link.events('plugin.checked')).toContainEqual({ plugin: 'outline', from: 'folder', result: 'tampered' })
    expect(made.link.events('plugin.refused')).toContainEqual({ plugin: 'outline', reason: 'tampered' })
    expect(made.runtime.order()).not.toContain('outline')
    expect(reasonOf(made.pluginsManager, 'tagger')).toBe('dependency:outline:refused')
  })

  it('count a file added beside the plugin\'s own, which changes the hash', async () => {
    const made = await harness({ folder: { outline: outline() }, entries: { outline: signed() } })
    await writeFile(path.join(made.dataDir, 'plugins', 'outline', 'extra.js'), 'more()')
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('tampered')
  })

  it('are refused missing when the entry names a folder that is gone', async () => {
    const made = await harness({ entries: { outline: noFolder } })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('missing')
  })
})

describe('where a plugin\'s code came from', () => {
  it.each([
    ['a host entry', { entries: { host: 'host.js' } }],
    ['guards', { entries: { worker: 'worker.js' }, capabilities: [{ type: 'guard.hook' }], guards: ['luoshu.write'] }],
    ['Node built-ins', { entries: { worker: 'worker.js' }, node: ['fs'] }],
    ['an install-only type', { entries: { worker: 'worker.js' }, capabilities: [{ type: 'guard.hook' }] }],
  ])('refuses %s from the plugin folder with install-only, however the entry reads', async (_name, extra) => {
    const made = await harness({ folder: { outline: filesFor(manifest('outline', extra)) }, entries: { outline: signed() } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'outline')).toBe('refused')
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('install-only')
    expect(made.runtime.started).toEqual(made.runtime.started.filter(start => start.id !== 'outline'))
  })

  it('refuses a host entry in dev mode and with skipVerification too, since a switch never gives a folder plugin Node', async () => {
    const made = await harness({
      folder: { outline: filesFor(manifest('outline', { entries: { host: 'host.js' } })) },
      entries: { outline: signed({ signer: null }) },
      switches: { devMode: ['outline'], skipVerification: true },
    })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('install-only')
  })

  it('refuses a manifest outside the schema and one whose entry names a file it doesn\'t hold', async () => {
    const made = await harness({
      folder: {
        outline: { 'hetu-plugin.json': '{"id":"outline","id":"outline"}' },
        tagger: { 'hetu-plugin.json': JSON.stringify(workerManifest('tagger')) },
      },
      entries: { outline: signed(), tagger: signed() },
    })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('invalid')
    expect(reasonOf(made.pluginsManager, 'tagger')).toBe('invalid')
  })

  it('refuses a manifest that names another id than its folder and entry, since the entry wins', async () => {
    const made = await harness({ folder: { outline: filesFor(workerManifest('tagger')) }, entries: { outline: signed() } })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('id')
    expect(made.pluginsManager.plugin('tagger')).toBe(null)
  })

  // A plugin written for version 2 loads under version 3, which only added, unless it names a type version 3 added
  it('loads a plugin of an older major every major since only added to, and refuses one naming a type added since', async () => {
    const edits = { type: 'ui.edit', paths: ['**'] }
    const made = await harness({
      folder: {
        older: filesFor(workerManifest('older', { api: '^2', capabilities: [{ type: 'luoshu.read', paths: ['**'] }] })),
        mixed: filesFor(workerManifest('mixed', { api: '^2', capabilities: [edits] })),
        newer: filesFor(workerManifest('newer', { api: '^3', capabilities: [edits] })),
      },
      entries: {
        older: signed({ granted: [{ type: 'luoshu.read', paths: ['**'] }] }),
        mixed: signed({ granted: [edits] }),
        newer: signed({ granted: [edits] }),
      },
    })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'older')).toBe(null)
    expect(reasonOf(made.pluginsManager, 'mixed')).toBe('api')
    expect(reasonOf(made.pluginsManager, 'newer')).toBe(null)
  })

  it('refuses an api range outside this core with api, and its dependents wait on that', async () => {
    const made = await harness({
      folder: { outline: filesFor(workerManifest('outline', { api: '^1' })), tagger: filesFor(workerManifest('tagger', { requires: ['outline'] })) },
      entries: { outline: signed(), tagger: signed() },
    })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('api')
    expect(reasonOf(made.pluginsManager, 'tagger')).toBe('dependency:outline:api')
  })

  // A type a later major removed has no place in the schema. A manifest written before that major is refused api, read
  // as written for an older hetu. A type no major ever had, or a removed one named under a range after its removal,
  // stays invalid
  it('refuses a manifest naming a type a later major removed with api and an unknown type with invalid', async () => {
    const named = (api: string, ...types: string[]) => workerManifest('outline', { api, capabilities: types.map(type => ({ type })) })
    const folders: [string, Record<string, unknown>, string][] = [
      ['layout', named('^5', 'ui.view', 'ui.layout'), 'api'],
      ['keys', named('^4', 'ui.keys'), 'api'],
      ['panel', named('^1', 'ui.panel', 'ui.statusBar'), 'api'],
      ['made-up', named('^6', 'ui.tiles'), 'invalid'],
      ['made-up-old', named('^5', 'ui.layout', 'ui.tiles'), 'invalid'],
      ['layout-now', named('^6', 'ui.layout'), 'invalid'],
      ['keys-now', named('^5', 'ui.keys'), 'invalid'],
      ['layout-broken', { ...named('^5', 'ui.layout'), version: '1.0' }, 'invalid'],
    ]
    const made = await harness({
      folder: Object.fromEntries(folders.map(([id, plugin]) => [id, filesFor({ ...plugin, id })])),
      entries: Object.fromEntries(folders.map(([id]) => [id, signed()])),
    })
    await made.pluginsManager.start()
    for (const [id, , reason] of folders) {
      expect([id, reasonOf(made.pluginsManager, id)]).toEqual([id, reason])
      expect(made.link.events('plugin.refused')).toContainEqual({ plugin: id, reason })
    }
    expect(made.runtime.order().filter(id => folders.some(([folder]) => folder === id))).toEqual([])
  })

  it('refuses a manifest naming a removed type under another id with id', async () => {
    const made = await harness({
      folder: { outline: filesFor(workerManifest('tiles', { api: '^5', capabilities: [{ type: 'ui.layout' }] })) },
      entries: { outline: signed() },
    })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('id')
  })
})

describe('reserved ids in the plugin folder', () => {
  it.each(['gate', 'luoshu', 'lock', 'editor', 'cache', 'core', 'events'])('refuses %s with reserved-id and keeps it apart from the install', async id => {
    const made = await harness({ folder: { [id]: filesFor(workerManifest(id)) }, entries: { [id]: signed() } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.list()).toContainEqual({ id, from: 'folder', place: 'sandboxed', state: 'refused', reason: 'reserved-id', incarnation: 0 })
    expect(made.link.events('plugin.refused')).toContainEqual({ plugin: id, reason: 'reserved-id' })
    expect(made.runtime.started.filter(start => start.half === 'worker')).toEqual([])
    // The core's own module of that id, if there is one, is untouched
    if (id === 'gate' || id === 'luoshu') expect(made.modules.state(id)).toBe('on')
    if (id === 'gate') expect(made.pluginsManager.policyJob('gate')).toBe('on')
  })

  it('refuses an entry for a core module\'s id with no folder, so it never stands in for the core\'s', async () => {
    const made = await harness({ entries: { gate: noFolder } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.policyJob('gate')).toBe('on')
    expect(made.pluginsManager.list().filter(row => row.id === 'gate').map(row => [row.from, row.state])).toEqual([['folder', 'refused']])
    expect(made.runtime.order()).toEqual([])
  })

  // The ids first party kept, the plugins that left the install among them
  it.each(['git', 'artifacts', 'notify', 'layout', 'hidden-marks'])('loads %s from the plugin folder as any plugin there', async id => {
    const made = await harness({ folder: { [id]: filesFor(workerManifest(id)) }, entries: { [id]: signed() } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, id)).toBe('ready')
  })

  // Refused for the signer whatever the id, so nothing an older build copied runs unapproved
  it.each(['layout', 'hidden-marks', 'outline'])('refuses %s with signer when its entry carries the first-party signer an older build wrote', async id => {
    const made = await harness({ folder: { [id]: filesFor(workerManifest(id)) }, entries: { [id]: async root => oldFirstPartyEntry(await hashOf(root)) } })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, id)).toBe('signer')
    expect(made.runtime.order()).not.toContain(id)
  })

  it('refuses the first-party signer in dev mode too', async () => {
    const made = await harness({
      folder: { layout: filesFor(workerManifest('layout')) },
      entries: { layout: async root => oldFirstPartyEntry(await hashOf(root)) },
      switches: { devMode: ['layout'] },
    })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'layout')).toBe('signer')
  })
})

describe('the signer pairing', () => {
  it('refuses a null signer unless allowUnsigned names the build by its hash', async () => {
    const refused = await harness({ folder: { outline: outline() }, entries: { outline: signed({ signer: null }) }, switches: { allowUnsigned: [] } })
    await refused.pluginsManager.start()
    expect(reasonOf(refused.pluginsManager, 'outline')).toBe('unsigned')

    const base = await harness({ folder: { outline: outline() } })
    const hash = await hashOf(path.join(base.dataDir, 'plugins', 'outline'))
    const allowed = await harness({ folder: { outline: outline() }, entries: { outline: signed({ signer: null }) }, switches: { allowUnsigned: [hash] } })
    await allowed.pluginsManager.start()
    expect(stateOf(allowed.pluginsManager, 'outline')).toBe('ready')
  })

  it('trusts only the build allowUnsigned names, so changed bytes are refused even with verification skipped', async () => {
    const base = await harness({ folder: { outline: outline() } })
    const hash = await hashOf(path.join(base.dataDir, 'plugins', 'outline'))
    const made = await harness({
      folder: { outline: outline() },
      entries: { outline: signed({ signer: null }) },
      switches: { allowUnsigned: [hash], skipVerification: true },
    })
    await writeFile(path.join(made.dataDir, 'plugins', 'outline', 'worker.js'), 'changed()')
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('unsigned')
  })

  // No signer is taken until provenance lands, so a build runs only as allowUnsigned names it
  it.each(['https://github.com/someone/outline', 'sigstore:someone'])('refuses the signer %j with signer, its build in allowUnsigned and in dev mode too', async signer => {
    const base = await harness({ folder: { outline: outline() } })
    const hash = await hashOf(path.join(base.dataDir, 'plugins', 'outline'))
    const made = await harness({ folder: { outline: outline() }, entries: { outline: signed({ signer }) }, switches: { allowUnsigned: [hash] } })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('signer')
    const dev = await harness({ folder: { outline: outline() }, entries: { outline: signed({ signer }) }, switches: { devMode: ['outline'] } })
    await dev.pluginsManager.start()
    expect(reasonOf(dev.pluginsManager, 'outline')).toBe('signer')
  })
})

describe('the human\'s switches on folder plugins', () => {
  it('dev mode loads changed bytes with a null signer for the plugins it names, and nothing more', async () => {
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger')), luoshu: filesFor(workerManifest('luoshu')) },
      entries: { outline: signed({ signer: null }), tagger: signed(), luoshu: signed() },
      switches: { devMode: ['outline', 'tagger', 'luoshu'] },
    })
    await writeFile(path.join(made.dataDir, 'plugins', 'outline', 'worker.js'), 'work in progress()')
    await writeFile(path.join(made.dataDir, 'plugins', 'tagger', 'worker.js'), 'also changed()')
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'outline')).toBe('ready')
    expect(made.link.events('plugin.checked')).toContainEqual({ plugin: 'outline', from: 'folder', result: 'dev' })
    expect(made.runtime.started.find(start => start.id === 'outline')?.code).toBe('work in progress()')
    // A reserved id stays refused in dev mode
    expect(made.pluginsManager.list()).toContainEqual(expect.objectContaining({ id: 'luoshu', from: 'folder', reason: 'reserved-id' }))
    expect(stateOf(made.pluginsManager, 'tagger')).toBe('ready')
  })

  it('dev mode on one plugin leaves another plugin\'s failed check standing', async () => {
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger')) },
      entries: { outline: signed(), tagger: signed() },
      switches: { devMode: ['outline'] },
    })
    await writeFile(path.join(made.dataDir, 'plugins', 'tagger', 'worker.js'), 'changed()')
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'tagger')).toBe('tampered')
  })

  it('switched off, a plugin reads off whatever its check says and its dependents wait', async () => {
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger', { requires: ['outline'] })) },
      entries: { outline: signed({ enabled: false }), tagger: signed() },
    })
    await writeFile(path.join(made.dataDir, 'plugins', 'outline', 'worker.js'), 'changed()')
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'outline')).toBe('off')
    expect(reasonOf(made.pluginsManager, 'tagger')).toBe('dependency:outline:off')
    expect(made.link.events('plugin.checked')).toContainEqual({ plugin: 'outline', from: 'folder', result: 'tampered' })
  })
})

describe('the scan', () => {
  it('finds a folder with no entry, records plugin.found and starts nothing, its dependents waiting on it', async () => {
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger', { requires: ['outline'] })) },
      entries: { tagger: signed() },
    })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'outline')).toBe('found')
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('new')
    expect(made.link.events('plugin.found')).toEqual([{ plugin: 'outline' }])
    expect(reasonOf(made.pluginsManager, 'tagger')).toBe('dependency:outline:new')
    expect(made.runtime.order()).not.toContain('outline')
  })

  it('refuses a plugin whose entry failed its check, and one whose entry is in a newer format', async () => {
    const entry = (dataDir: string, id: string) => path.join(dataDir, 'state', 'plugins', `${id}.json`)
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger')), mapper: filesFor(workerManifest('mapper')) },
      entries: { mapper: signed() },
      before: async ({ dataDir }) => {
        await plant(entry(dataDir, 'outline'), '{"format":2,"version":"1.0.0"}')
        await plant(entry(dataDir, 'tagger'), '{"format":4}')
        // An edit by something that doesn't know hetu leaves the old hash line
        const file = entry(dataDir, 'mapper')
        await writeFile(file, (await readFile(file, 'utf8')).replace('"enabled": true', '"enabled": false'))
      },
    })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('entry')
    expect(reasonOf(made.pluginsManager, 'tagger')).toBe('newer')
    expect(reasonOf(made.pluginsManager, 'mapper')).toBe('entry')
    expect(made.runtime.order()).toEqual([])
  })

  it('counts what in the plugin folder is no plugin folder, a file or a bad name, without reading it', async () => {
    const made = await harness({ folder: { outline: outline() }, entries: { outline: signed() } })
    await writeFile(path.join(made.dataDir, 'plugins', 'notes.txt'), 'x')
    await mkdir(path.join(made.dataDir, 'plugins', 'Bad Name'))
    await writeFile(path.join(made.dataDir, 'plugins', '.DS_Store'), '')
    await made.pluginsManager.start()
    expect(made.link.events('plugin.checked')).toContainEqual({ plugin: null, from: 'folder', result: 'bad-name', count: 2 })
    expect(stateOf(made.pluginsManager, 'outline')).toBe('ready')
  })
})

describe('removing a plugin-folder plugin', () => {
  const exists = (file: string) => stat(file).then(() => true, () => false)

  it('removes the entry first, then the code, the storage and the cache', async () => {
    const made = await harness({
      folder: { outline: outline() },
      entries: { outline: signed() },
      before: async ({ dataDir }) => {
        for (const kind of ['storage', 'cache']) {
          await mkdir(path.join(dataDir, kind, 'outline'), { recursive: true })
          await writeFile(path.join(dataDir, kind, 'outline', 'kept'), 'x')
        }
        await mkdir(path.join(dataDir, 'storage', 'other'), { recursive: true })
      },
    })
    await made.pluginsManager.start()
    const order: string[] = []
    const removePlugin = made.store.removePlugin.bind(made.store)
    made.store.removePlugin = async id => {
      order.push(`entry ${await exists(path.join(made.dataDir, 'plugins', id)) ? 'with code' : 'after code'}`)
      return removePlugin(id)
    }
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'outline' })
    expect(order).toEqual(['entry with code'])
    expect(made.pluginsManager.plugin('outline')).toBe(null)
    for (const kind of ['plugins', 'storage', 'cache']) expect(await exists(path.join(made.dataDir, kind, 'outline')), kind).toBe(false)
    expect(await exists(path.join(made.dataDir, 'storage', 'other'))).toBe(true)
  })
})
