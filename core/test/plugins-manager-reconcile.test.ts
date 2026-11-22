import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIRST_PARTY_SIGNER } from '../api/install.ts'
import { boot } from '../backend/boot/boot.ts'
import { StateStore } from '../backend/boot/state.ts'
import { PluginsManager } from '../backend/plugins-manager/plugins-manager.ts'
import type { Landing } from '../backend/plugins-manager/header.ts'
import { readInstalled, writeInstalled } from '../backend/plugins-manager/folders.ts'
import {
  cleanup, coreInstall, coreModules, filesFor, firstPartyEntry, harness, hashOf, plant, reasonOf, stateOf, until, wire, workerManifest,
  type Files, type Listing,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

const exists = (file: string) => stat(file).then(() => true, () => false)
const gitFiles = (version = '1.0.0', extra: Files = {}) =>
  filesFor(workerManifest('git', { version, capabilities: [{ type: 'history', access: 'commit', paths: ['**'] }] }), extra)
const bundled = (files: Files): Listing => ({ files, firstParty: true })
const installWith = (plugins: Record<string, Files>) =>
  ({ ...coreInstall(), ...Object.fromEntries(Object.entries(plugins).map(([id, files]) => [id, bundled(files)])) })
const entryFile = (dataDir: string, id: string) => path.join(dataDir, 'state', 'plugins', `${id}.json`)
const folderOf = (dataDir: string, id: string) => path.join(dataDir, 'plugins', id)

describe('the first-party reconcile', () => {
  it('copies a first-party plugin with no entry and no tombstone, through staging, a swap and the entry last', async () => {
    const made = await harness({ install: installWith({ git: gitFiles() }) })
    const seen: { copied: boolean, folder: boolean }[] = []
    const writePlugin = made.store.writePlugin.bind(made.store)
    made.store.writePlugin = async (id, entry) => {
      seen.push({ copied: made.link.events('plugin.copied').length === 1, folder: await exists(folderOf(made.dataDir, id)) })
      return writePlugin(id, entry)
    }
    await made.pluginsManager.start()
    // The record came first, then the folder, then the entry
    expect(seen).toEqual([{ copied: true, folder: true }])
    const installHash = await hashOf(path.join(made.installDir, 'plugins', 'git'))
    expect(await hashOf(folderOf(made.dataDir, 'git'))).toBe(installHash)
    const loaded = await new StateStore(made.dataDir).load()
    expect(loaded.state.plugins.git).toEqual({
      version: '1.0.0', contentHash: installHash, signer: FIRST_PARTY_SIGNER,
      // The grant risk classifier classes the copy, a commit to history asking nothing at its first use
      granted: [{ type: 'history', access: 'commit', paths: ['**'] }], class: 2, enabled: true,
    })
    expect(made.link.events('plugin.copied')).toEqual([{ plugin: 'git', version: '1.0.0' }])
    expect(stateOf(made.pluginsManager, 'git')).toBe('ready')
    expect(await readdir(path.join(made.dataDir, 'staging'))).toEqual([])
    // An applied change, so the grants snapshot moved on
    expect(made.pluginsManager.view()).toBe(2)
  })

  // Hidden marks ran in the editor page as a core plugin before it became a first-party worker, so a data folder from
  // then holds it in the record of the install's core plugins and nothing in the plugin folder. Its own manifest, so
  // the grants it ships with reach ready
  it('copies a plugin the last run held as a core plugin as it copies any first-party plugin, with no update heard', async () => {
    const real = JSON.parse(await readFile(path.join(import.meta.dirname, '..', '..', 'core-plugins', 'hidden-marks', 'hetu-plugin.json'), 'utf8')) as Record<string, unknown>
    const marks = filesFor(real)
    const made = await harness({ install: installWith({ 'hidden-marks': marks }) })
    await writeInstalled(made.dataDir, { 'hidden-marks': { version: '0.1.0', hash: 'c'.repeat(64) } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'hidden-marks')).toBe('ready')
    expect((await new StateStore(made.dataDir).load()).state.plugins['hidden-marks'].granted).toEqual([
      { type: 'ui.read', paths: ['**'] }, { type: 'ui.edit', paths: ['**'] }, { type: 'ui.decoration' }, { type: 'ui.command' }, { type: 'ui.view' },
      { type: 'storage' },
    ])
    expect(made.link.events('plugin.copied')).toEqual([{ plugin: 'hidden-marks', version: '0.1.0' }])
    expect(made.link.events('plugin.updated')).toEqual([])
    expect(Object.keys(await readInstalled(made.dataDir))).toEqual([])
  })

  it('copies nothing the human removed, whose tombstone stands', async () => {
    const made = await harness({ install: installWith({ git: gitFiles(), notify: filesFor(workerManifest('notify')) }), switches: { removed: ['git'] } })
    await made.pluginsManager.start()
    expect(await exists(folderOf(made.dataDir, 'git'))).toBe(false)
    expect(made.pluginsManager.plugin('git')).toBe(null)
    expect(stateOf(made.pluginsManager, 'notify')).toBe('ready')
  })

  it('in a boot that lost the tombstones, copies no plugin that has no entry and writes a tombstone for each instead', async () => {
    const made = await harness({
      install: installWith({ git: gitFiles(), notify: filesFor(workerManifest('notify', { version: '2.0.0' })) }),
      entries: { notify: firstPartyEntry('e'.repeat(64)) },
      removedKnown: false,
    })
    await made.pluginsManager.start()
    expect(await exists(folderOf(made.dataDir, 'git'))).toBe(false)
    expect((await new StateStore(made.dataDir).load()).state.switches.removed).toEqual(['git'])
    expect(made.link.events('plugin.tombstone')).toEqual([{ plugin: 'git' }])
    // A plugin that kept its entry is still brought up to the install's version
    expect(made.link.events('plugin.copied')).toEqual([{ plugin: 'notify', version: '2.0.0' }])
    expect(stateOf(made.pluginsManager, 'notify')).toBe('ready')
  })

  it('holds a first-party plugin back after boot found the switches gone, until plugin.restore', async () => {
    const first = await harness({ install: installWith({ git: gitFiles() }) })
    const options = { packaged: false, installDir: first.installDir, env: { HETU_DATA_DIR: first.dataDir }, platform: process.platform }
    const once = await boot(options)
    await once.release()
    await rm(path.join(first.dataDir, 'state', 'switches.json'))
    const booted = await boot(options)
    try {
      expect(booted.removedKnown).toBe(false)
      const modules = coreModules({ dataDir: first.dataDir, installDir: first.installDir }, first.link, { gate: first.gate })
      const pluginsManager = new PluginsManager({ booted, installDir: first.installDir, link: first.link, recording: first.link, runtime: first.runtime, modules })
      wire(pluginsManager, modules, first.link)
      await pluginsManager.start()
      expect(await exists(folderOf(first.dataDir, 'git'))).toBe(false)
      expect((await new StateStore(first.dataDir).load()).state.switches.removed).toEqual(['git'])
      await pluginsManager.apply({ kind: 'plugin.restore', plugin: 'git' })
      await pluginsManager.settled()
      expect(pluginsManager.plugin('git')?.state).toBe('ready')
      expect((await new StateStore(first.dataDir).load()).state.switches.removed).toEqual([])
      await pluginsManager.shutdown()
    } finally {
      await booted.release()
    }
  })

  it('copies a newer bundled version and keeps the human\'s switch, clearing the cache and passing previousVersion', async () => {
    const off = await harness({
      install: installWith({ git: gitFiles('1.1.0') }),
      folder: { git: gitFiles('1.0.0') },
      entries: { git: async root => firstPartyEntry(await hashOf(root), { enabled: false }) },
    })
    await off.pluginsManager.start()
    const entry = (await new StateStore(off.dataDir).load()).state.plugins.git
    expect(entry.version).toBe('1.1.0')
    expect(entry.enabled).toBe(false)
    expect(stateOf(off.pluginsManager, 'git')).toBe('off')

    const on = await harness({
      install: installWith({ git: gitFiles('1.1.0') }),
      folder: { git: gitFiles('1.0.0') },
      entries: { git: async root => firstPartyEntry(await hashOf(root)) },
      before: async ({ dataDir }) => {
        await mkdir(path.join(dataDir, 'cache', 'git'), { recursive: true })
        await writeFile(path.join(dataDir, 'cache', 'git', 'index'), 'old')
      },
    })
    await on.pluginsManager.start()
    expect(on.runtime.half('git').got('init')[0].previousVersion).toBe('1.0.0')
    expect(await exists(path.join(on.dataDir, 'cache', 'git', 'index'))).toBe(false)
  })

  // A new version can change an item's paths, so an item of a type the human switched one off in starts off unless it
  // is exactly an item that was on
  it('keeps the items the human switched off across a newer bundled version, and starts a changed item of that type off', async () => {
    const read = { type: 'luoshu.read' as const, paths: ['notes/**'] }
    const write = { type: 'luoshu.write' as const, paths: ['notes/**'] }
    const wider = { type: 'luoshu.write' as const, paths: ['**'] }
    const panel = { type: 'ui.view' as const }
    const granted = (version: string, capabilities: object[]) => filesFor(workerManifest('git', { version, capabilities }))
    const made = await harness({
      install: installWith({ git: granted('1.1.0', [read, wider, panel]) }),
      folder: { git: granted('1.0.0', [read, write, panel]) },
      entries: { git: async root => firstPartyEntry(await hashOf(root), { granted: [read, write, panel], off: [write, panel] }) },
    })
    await made.pluginsManager.start()
    const entry = (await new StateStore(made.dataDir).load()).state.plugins.git
    expect(entry.version).toBe('1.1.0')
    expect(entry.off).toEqual([wider, panel])
  })

  it('copies a release that changed only the patch number', async () => {
    const made = await harness({
      install: installWith({ git: gitFiles('1.0.1') }),
      folder: { git: gitFiles('1.0.0') },
      entries: { git: async root => firstPartyEntry(await hashOf(root)) },
    })
    await made.pluginsManager.start()
    expect((await new StateStore(made.dataDir).load()).state.plugins.git.version).toBe('1.0.1')
    expect(made.link.events('plugin.copied')).toEqual([{ plugin: 'git', version: '1.0.1' }])
    expect(stateOf(made.pluginsManager, 'git')).toBe('ready')
  })

  it('leaves a copy alone when the install\'s version is the same or older', async () => {
    const made = await harness({
      install: installWith({ git: gitFiles('1.0.0') }),
      folder: { git: gitFiles('1.2.0') },
      entries: { git: async root => firstPartyEntry(await hashOf(root), { version: '1.2.0' }) },
    })
    const before = await hashOf(folderOf(made.dataDir, 'git'))
    await made.pluginsManager.start()
    expect(await hashOf(folderOf(made.dataDir, 'git'))).toBe(before)
    expect(made.link.events('plugin.copied')).toEqual([])
  })

  it('never writes over an entry that failed its check, since a rewrite would reset enabled', async () => {
    const made = await harness({
      install: installWith({ git: gitFiles('2.0.0') }),
      folder: { git: gitFiles('1.0.0') },
      before: async ({ dataDir }) => {
        await mkdir(path.dirname(entryFile(dataDir, 'git')), { recursive: true })
        await writeFile(entryFile(dataDir, 'git'), '{"format":2,"enabled":false}\nnot a hash\n')
      },
    })
    const before = await readFile(entryFile(made.dataDir, 'git'))
    await made.pluginsManager.start()
    expect(await readFile(entryFile(made.dataDir, 'git'))).toEqual(before)
    expect(made.link.events('plugin.copied')).toEqual([])
    expect(reasonOf(made.pluginsManager, 'git')).toBe('entry')
  })

  it('counts an entry in a newer format as present and writes nothing over it', async () => {
    const made = await harness({
      install: installWith({ git: gitFiles() }),
      before: ({ dataDir }) => plant(entryFile(dataDir, 'git'), '{"format":4,"anything":true}'),
    })
    await made.pluginsManager.start()
    expect(await exists(folderOf(made.dataDir, 'git'))).toBe(false)
    expect(reasonOf(made.pluginsManager, 'git')).toBe('newer')
  })

  it('never overwrites or adopts a community plugin holding a first-party id, entry or no entry', async () => {
    const withEntry = await harness({
      install: installWith({ git: gitFiles('9.0.0') }),
      folder: { git: gitFiles('1.0.0', { 'worker.js': 'someone else\'s git()' }) },
      entries: { git: async root => firstPartyEntry(await hashOf(root), { signer: 'https://github.com/someone/git' }) },
    })
    await withEntry.pluginsManager.start()
    expect(await readFile(path.join(folderOf(withEntry.dataDir, 'git'), 'worker.js'), 'utf8')).toBe('someone else\'s git()')
    expect(withEntry.link.events('plugin.collision')).toEqual([{ plugin: 'git' }])
    expect(reasonOf(withEntry.pluginsManager, 'git')).toBe('reserved-id')

    const bare = await harness({
      install: installWith({ git: gitFiles() }),
      folder: { git: gitFiles('1.0.0', { 'worker.js': 'dropped in()' }) },
    })
    await bare.pluginsManager.start()
    expect(await readFile(path.join(folderOf(bare.dataDir, 'git'), 'worker.js'), 'utf8')).toBe('dropped in()')
    expect((await new StateStore(bare.dataDir).load()).state.plugins.git).toBeUndefined()
    expect(reasonOf(bare.pluginsManager, 'git')).toBe('reserved-id')
  })

  it('never copies a bundled copy whose bytes fail the install list', async () => {
    const made = await harness({ install: { ...coreInstall(), git: { ...bundled(gitFiles()), hash: 'f'.repeat(64) } } })
    await made.pluginsManager.start()
    expect(await exists(folderOf(made.dataDir, 'git'))).toBe(false)
    expect(made.link.events('plugin.checked')).toContainEqual({ plugin: 'git', from: 'bundled', result: 'tampered' })
  })
})

describe('a copy and its record', () => {
  it('applies only once plugin.copied has landed', async () => {
    const made = await harness({ install: installWith({ git: gitFiles() }) })
    let land!: (landing: Landing) => void
    made.link.landing = event => event === 'plugin.copied' ? new Promise(resolve => { land = resolve }) : 'landed'
    const starting = made.pluginsManager.start()
    await until(() => made.link.events('plugin.copied').length === 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await exists(folderOf(made.dataDir, 'git'))).toBe(false)
    expect((await new StateStore(made.dataDir).load()).state.plugins.git).toBeUndefined()
    land('landed')
    await starting
    expect(stateOf(made.pluginsManager, 'git')).toBe('ready')
  })

  it('applies nothing when the record is lost and leaves no staging behind', async () => {
    const made = await harness({ install: installWith({ git: gitFiles() }) })
    made.link.landing = event => event === 'plugin.copied' ? 'lost' : 'landed'
    await made.pluginsManager.start()
    expect(await exists(folderOf(made.dataDir, 'git'))).toBe(false)
    expect(await readdir(path.join(made.dataDir, 'staging'))).toEqual([])
    expect(made.pluginsManager.plugin('git')).toBe(null)
  })

  it('gives up on plugin.copied at the deadline, withdraws it and starts the rest', async () => {
    const made = await harness({ install: installWith({ git: gitFiles() }) })
    made.link.limits.readyMs = 100
    let signal: AbortSignal | undefined
    made.link.landing = (event, _fields, given) => {
      if (event !== 'plugin.copied') return 'landed'
      signal = given
      return new Promise<Landing>(() => {})
    }
    await made.pluginsManager.start()
    expect(signal?.aborted).toBe(true)
    expect(await exists(folderOf(made.dataDir, 'git'))).toBe(false)
    expect(await readdir(path.join(made.dataDir, 'staging'))).toEqual([])
    expect(made.pluginsManager.plugin('git')).toBe(null)
  })

  it('applies at once while the human turned recording off, with nothing recorded at all', async () => {
    const made = await harness({ install: installWith({ git: gitFiles() }), switches: { off: ['recording'] } })
    made.link.landing = () => new Promise<Landing>(() => {})
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'git')).toBe('ready')
    expect(made.modules.state('recording')).toBe('off')
    expect(made.link.records).toEqual([])
  })

  it('records again once recording is back on', async () => {
    const made = await harness({ switches: { off: ['recording'] } })
    await made.pluginsManager.start()
    expect(made.link.records).toEqual([])
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: 'recording' })
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'gate' })
    expect(made.link.events('policy-job.state')).toContainEqual({ policyJob: 'gate', state: 'off' })
  })
})

describe('removing and restoring a first-party plugin', () => {
  it('clears what the plugin stored and cached with its code', async () => {
    const made = await harness({
      install: installWith({ git: gitFiles() }),
      before: async ({ dataDir }) => {
        for (const kind of ['storage', 'cache']) {
          await mkdir(path.join(dataDir, kind, 'git'), { recursive: true })
          await writeFile(path.join(dataDir, kind, 'git', 'kept'), 'x')
        }
        await mkdir(path.join(dataDir, 'storage', 'other'), { recursive: true })
      },
    })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'git' })
    expect(await exists(path.join(made.dataDir, 'storage', 'git'))).toBe(false)
    expect(await exists(path.join(made.dataDir, 'cache', 'git'))).toBe(false)
    expect(await exists(path.join(made.dataDir, 'storage', 'other'))).toBe(true)
  })

  it('stops a running copy it restores and ends its way before the new incarnation starts', async () => {
    const made = await harness({ install: installWith({ git: gitFiles() }) })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'git')).toBe('ready')
    await made.pluginsManager.apply({ kind: 'plugin.restore', plugin: 'git' })
    await made.pluginsManager.settled()
    expect(made.runtime.half('git', 1).got('stop')).toHaveLength(1)
    expect(made.link.ended.map(ended => ended.caller)).toContainEqual(expect.objectContaining({ id: 'git', incarnation: 1 }))
    const { timeline } = made.link
    expect(timeline.indexOf('end git')).toBeGreaterThan(-1)
    expect(timeline.indexOf('end git')).toBeLessThan(timeline.lastIndexOf('init git'))
    expect(made.pluginsManager.plugin('git')?.incarnation).toBe(2)
    expect(stateOf(made.pluginsManager, 'git')).toBe('ready')
  })

  it('removes the entry first, then the code, leaving a tombstone that keeps the next start from copying it back', async () => {
    const made = await harness({ install: installWith({ git: gitFiles() }) })
    await made.pluginsManager.start()
    const order: string[] = []
    const removePlugin = made.store.removePlugin.bind(made.store)
    made.store.removePlugin = async id => {
      order.push(`entry ${await exists(folderOf(made.dataDir, id)) ? 'with code' : 'after code'}`)
      return removePlugin(id)
    }
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'git' })
    expect(order).toEqual(['entry with code'])
    expect(await exists(folderOf(made.dataDir, 'git'))).toBe(false)
    expect(made.pluginsManager.plugin('git')).toBe(null)
    const loaded = await new StateStore(made.dataDir).load()
    expect(loaded.state.switches.removed).toEqual(['git'])
    expect(loaded.state.plugins.git).toBeUndefined()

    const next = await harness({ base: path.join(made.base, 'again'), install: installWith({ git: gitFiles() }), switches: { removed: ['git'] } })
    await next.pluginsManager.start()
    expect(await exists(folderOf(next.dataDir, 'git'))).toBe(false)
  })

  // A tombstone holds with an entry beside it, which a remove stopped between its two writes leaves
  it('keeps a removed first-party plugin out though an entry with the install\'s bytes sits beside its tombstone', async () => {
    const made = await harness({
      install: installWith({ git: gitFiles() }),
      folder: { git: gitFiles() },
      entries: { git: async root => firstPartyEntry(await hashOf(root), { enabled: true }) },
      switches: { removed: ['git'] },
    })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'git')).toBe('refused')
    expect(reasonOf(made.pluginsManager, 'git')).toBe('removed')
    expect(made.runtime.order()).not.toContain('git')
    // Only the human brings it back
    await made.pluginsManager.apply({ kind: 'plugin.restore', plugin: 'git' })
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'git')).toBe('ready')
    expect((await new StateStore(made.dataDir).load()).state.switches.removed).toEqual([])
  })

  it('restores the install\'s bytes over a copy whose check failed, keeping its switch and the items switched off', async () => {
    const commit = { type: 'history' as const, access: 'commit' as const, paths: ['**'] }
    const made = await harness({
      install: installWith({ git: gitFiles() }),
      folder: { git: gitFiles() },
      entries: { git: async root => firstPartyEntry(await hashOf(root), { enabled: true, granted: [commit], off: [commit] }) },
    })
    await writeFile(path.join(folderOf(made.dataDir, 'git'), 'worker.js'), 'edited()')
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'git')).toBe('tampered')
    await made.pluginsManager.apply({ kind: 'plugin.restore', plugin: 'git' })
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'git')).toBe('ready')
    expect(made.link.events('plugin.restored')).toEqual([{ plugin: 'git', version: '1.0.0' }])
    expect(await hashOf(folderOf(made.dataDir, 'git'))).toBe(await hashOf(path.join(made.installDir, 'plugins', 'git')))
    expect((await new StateStore(made.dataDir).load()).state.plugins.git.off).toEqual([commit])
  })

  it('gives up on plugin.restored at the deadline, withdraws it and applies the next change', async () => {
    const made = await harness({
      install: installWith({ git: gitFiles() }),
      folder: { git: gitFiles() },
      entries: { git: async root => firstPartyEntry(await hashOf(root), { enabled: true }) },
    })
    await writeFile(path.join(folderOf(made.dataDir, 'git'), 'worker.js'), 'edited()')
    await made.pluginsManager.start()
    made.link.limits.readyMs = 100
    let signal: AbortSignal | undefined
    made.link.landing = (event, _fields, given) => {
      if (event !== 'plugin.restored') return 'landed'
      signal = given
      return new Promise<Landing>(() => {})
    }
    await expect(made.pluginsManager.apply({ kind: 'plugin.restore', plugin: 'git' })).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
    expect(reasonOf(made.pluginsManager, 'git')).toBe('tampered')
    await made.pluginsManager.apply({ kind: 'confirmOff', on: true })
    expect((await new StateStore(made.dataDir).load()).state.switches.confirmOff).toBe(true)
  })

  it('refuses to restore over a community plugin holding the id', async () => {
    const made = await harness({
      install: installWith({ git: gitFiles() }),
      folder: { git: gitFiles('1.0.0', { 'worker.js': 'theirs()' }) },
      entries: { git: async root => firstPartyEntry(await hashOf(root), { signer: 'https://github.com/someone/git' }) },
    })
    await made.pluginsManager.start()
    await expect(made.pluginsManager.apply({ kind: 'plugin.restore', plugin: 'git' })).rejects.toThrow()
    expect(await readFile(path.join(folderOf(made.dataDir, 'git'), 'worker.js'), 'utf8')).toBe('theirs()')
  })
})
