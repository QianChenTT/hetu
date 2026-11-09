import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIRST_PARTY_SIGNER } from '../api/install.ts'
import {
  cleanup, coreInstall, entryFor, filesFor, firstPartyEntry, harness, hashOf, manifest, plant, reasonOf, stateOf, workerManifest,
  type Files,
} from './loader-fakes.ts'

afterEach(cleanup)

const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const outline = () => filesFor(workerManifest('outline'))
const git = () => filesFor(workerManifest('git'))

// The install with a bundled first-party copy of git beside the core
const withGit = (files: Files = git()) => ({ ...coreInstall(), git: { files, firstParty: true } })

describe('a plugin-folder plugin\'s bytes', () => {
  it('are refused tampered when they don\'t match the entry, and the plugin never starts', async () => {
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger', { requires: ['outline'] })) },
      entries: { outline: signed(), tagger: signed() },
    })
    await writeFile(path.join(made.dataDir, 'plugins', 'outline', 'worker.js'), 'evil()')
    await made.loader.start()
    expect(stateOf(made.loader, 'outline')).toBe('refused')
    expect(reasonOf(made.loader, 'outline')).toBe('tampered')
    expect(made.link.events('plugin.checked')).toContainEqual({ plugin: 'outline', from: 'folder', result: 'tampered' })
    expect(made.link.events('plugin.refused')).toContainEqual({ plugin: 'outline', reason: 'tampered' })
    expect(made.runtime.order()).not.toContain('outline')
    expect(reasonOf(made.loader, 'tagger')).toBe('dependency:outline:refused')
  })

  it('count a file added beside the plugin\'s own, which changes the hash', async () => {
    const made = await harness({ folder: { outline: outline() }, entries: { outline: signed() } })
    await writeFile(path.join(made.dataDir, 'plugins', 'outline', 'extra.js'), 'more()')
    await made.loader.start()
    expect(reasonOf(made.loader, 'outline')).toBe('tampered')
  })

  it('are refused missing when the entry names a folder that is gone', async () => {
    const made = await harness({ entries: { outline: firstPartyEntry('d'.repeat(64), { signer: 'sigstore:someone' }) } })
    await made.loader.start()
    expect(reasonOf(made.loader, 'outline')).toBe('missing')
  })
})

describe('where a plugin\'s code came from', () => {
  it.each([
    ['a host entry', { entries: { host: 'host.js' } }],
    ['a page entry', { entries: { worker: 'worker.js', page: 'page.js' } }],
    ['guards', { entries: { worker: 'worker.js' }, capabilities: [{ type: 'guard.hook' }], guards: ['luoshu.write'] }],
    ['Node built-ins', { entries: { worker: 'worker.js' }, node: ['fs'] }],
    ['an install-only type', { entries: { worker: 'worker.js' }, capabilities: [{ type: 'guard.hook' }] }],
  ])('refuses %s from the plugin folder with install-only, however the entry reads', async (_name, extra) => {
    const made = await harness({ folder: { outline: filesFor(manifest('outline', extra)) }, entries: { outline: signed() } })
    await made.loader.start()
    expect(stateOf(made.loader, 'outline')).toBe('refused')
    expect(reasonOf(made.loader, 'outline')).toBe('install-only')
    expect(made.runtime.started).toEqual(made.runtime.started.filter(start => start.id !== 'outline'))
  })

  it('refuses a host entry in dev mode and with skipVerification too, since a switch never gives a folder plugin Node', async () => {
    const made = await harness({
      folder: { outline: filesFor(manifest('outline', { entries: { host: 'host.js' } })) },
      entries: { outline: signed({ signer: null }) },
      switches: { devMode: ['outline'], skipVerification: true },
    })
    await made.loader.start()
    expect(reasonOf(made.loader, 'outline')).toBe('install-only')
  })

  it('refuses a manifest outside the schema and one whose entry names a file it doesn\'t hold', async () => {
    const made = await harness({
      folder: {
        outline: { 'hetu-plugin.json': '{"id":"outline","id":"outline"}' },
        tagger: { 'hetu-plugin.json': JSON.stringify(workerManifest('tagger')) },
      },
      entries: { outline: signed(), tagger: signed() },
    })
    await made.loader.start()
    expect(reasonOf(made.loader, 'outline')).toBe('invalid')
    expect(reasonOf(made.loader, 'tagger')).toBe('invalid')
  })

  it('refuses a manifest that names another id than its folder and entry, since the entry wins', async () => {
    const made = await harness({ folder: { outline: filesFor(workerManifest('tagger')) }, entries: { outline: signed() } })
    await made.loader.start()
    expect(reasonOf(made.loader, 'outline')).toBe('id')
    expect(made.loader.plugin('tagger')).toBe(null)
  })

  it('refuses an api range outside this core with api, and its dependents wait on that', async () => {
    const made = await harness({
      folder: { outline: filesFor(workerManifest('outline', { api: '^1' })), tagger: filesFor(workerManifest('tagger', { requires: ['outline'] })) },
      entries: { outline: signed(), tagger: signed() },
    })
    await made.loader.start()
    expect(reasonOf(made.loader, 'outline')).toBe('api')
    expect(reasonOf(made.loader, 'tagger')).toBe('dependency:outline:api')
  })
})

describe('reserved ids in the plugin folder', () => {
  it.each(['gate', 'luoshu', 'leases', 'hidden-marks', 'editor', 'cache', 'core', 'events'])('refuses %s with reserved-id and keeps it apart from the install', async id => {
    const made = await harness({ folder: { [id]: filesFor(workerManifest(id)) }, entries: { [id]: signed() } })
    await made.loader.start()
    expect(made.loader.list()).toContainEqual({ id, from: 'folder', place: 'sandboxed', state: 'refused', reason: 'reserved-id', incarnation: 0 })
    expect(made.link.events('plugin.refused')).toContainEqual({ plugin: id, reason: 'reserved-id' })
    expect(made.runtime.started.filter(start => start.half === 'worker')).toEqual([])
    // The install's own plugin of that id, if there is one, is untouched
    if (id === 'gate') {
      expect(made.loader.plugin('gate')?.place).toBe('host')
      expect(made.loader.slot('gate')).toBe('on')
    }
  })

  it('refuses an entry for an install id with no folder, so it never stands in for the install\'s', async () => {
    const made = await harness({ entries: { gate: firstPartyEntry('d'.repeat(64), { signer: 'sigstore:someone' }) } })
    await made.loader.start()
    expect(made.loader.slot('gate')).toBe('on')
    expect(made.loader.list().filter(row => row.id === 'gate').map(row => row.from).sort()).toEqual(['folder', 'install'])
  })

  it('loads a first-party id only as the install\'s own copy, its entry carrying the first-party signer', async () => {
    const made = await harness({
      install: withGit(),
      folder: { git: git() },
      entries: { git: async root => firstPartyEntry(await hashOf(root)) },
    })
    await made.loader.start()
    expect(stateOf(made.loader, 'git')).toBe('ready')
  })

  it('refuses a first-party copy whose bytes no longer equal the install\'s, even when they match its entry', async () => {
    const made = await harness({
      install: withGit(filesFor(workerManifest('git'), { 'worker.js': 'the install has moved on()' })),
      folder: { git: git() },
      entries: { git: async root => firstPartyEntry(await hashOf(root)) },
    })
    await made.loader.start()
    expect(reasonOf(made.loader, 'git')).toBe('reserved-id')
  })

  it('refuses a community plugin holding a first-party id and never overwrites it', async () => {
    const made = await harness({
      install: withGit(),
      folder: { git: filesFor(workerManifest('git'), { 'worker.js': 'not hetu\'s git()' }) },
      entries: { git: signed() },
    })
    await made.loader.start()
    expect(reasonOf(made.loader, 'git')).toBe('reserved-id')
    expect(await readFile(path.join(made.dataDir, 'plugins', 'git', 'worker.js'), 'utf8')).toBe('not hetu\'s git()')
    expect(made.link.events('plugin.collision')).toEqual([{ plugin: 'git' }])
  })

  it('refuses a first-party copy when the install holds no copy of it', async () => {
    const made = await harness({ folder: { git: git() }, entries: { git: async root => firstPartyEntry(await hashOf(root)) } })
    await made.loader.start()
    expect(reasonOf(made.loader, 'git')).toBe('reserved-id')
  })

  it('refuses the first-party signer on any other id with signer', async () => {
    const made = await harness({ folder: { outline: outline() }, entries: { outline: async root => firstPartyEntry(await hashOf(root)) } })
    await made.loader.start()
    expect(reasonOf(made.loader, 'outline')).toBe('signer')
  })
})

describe('the signer pairing', () => {
  it('refuses a null signer unless allowUnsigned names the build by its hash', async () => {
    const refused = await harness({ folder: { outline: outline() }, entries: { outline: signed({ signer: null }) } })
    await refused.loader.start()
    expect(reasonOf(refused.loader, 'outline')).toBe('unsigned')

    const base = await harness({ folder: { outline: outline() } })
    const hash = await hashOf(path.join(base.dataDir, 'plugins', 'outline'))
    const allowed = await harness({ folder: { outline: outline() }, entries: { outline: signed({ signer: null }) }, switches: { allowUnsigned: [hash] } })
    await allowed.loader.start()
    expect(stateOf(allowed.loader, 'outline')).toBe('ready')
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
    await made.loader.start()
    expect(reasonOf(made.loader, 'outline')).toBe('unsigned')
  })

  it('takes a signer that is neither null nor the first-party one as pinned at approval', async () => {
    const made = await harness({ folder: { outline: outline() }, entries: { outline: signed({ signer: 'https://github.com/someone/outline' }) } })
    await made.loader.start()
    expect(stateOf(made.loader, 'outline')).toBe('ready')
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
    await made.loader.start()
    expect(stateOf(made.loader, 'outline')).toBe('ready')
    expect(made.link.events('plugin.checked')).toContainEqual({ plugin: 'outline', from: 'folder', result: 'dev' })
    expect(made.runtime.started.find(start => start.id === 'outline')?.code).toBe('work in progress()')
    // A reserved id stays refused in dev mode
    expect(made.loader.list()).toContainEqual(expect.objectContaining({ id: 'luoshu', from: 'folder', reason: 'reserved-id' }))
    expect(stateOf(made.loader, 'tagger')).toBe('ready')
  })

  it('dev mode on one plugin leaves another plugin\'s failed check standing', async () => {
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger')) },
      entries: { outline: signed(), tagger: signed() },
      switches: { devMode: ['outline'] },
    })
    await writeFile(path.join(made.dataDir, 'plugins', 'tagger', 'worker.js'), 'changed()')
    await made.loader.start()
    expect(reasonOf(made.loader, 'tagger')).toBe('tampered')
  })

  it('dev mode lets a first-party copy differ from the install\'s, its entry still naming the first-party signer', async () => {
    const made = await harness({
      install: withGit(),
      folder: { git: git() },
      entries: { git: async root => firstPartyEntry(await hashOf(root)) },
      switches: { devMode: ['git'] },
    })
    await writeFile(path.join(made.dataDir, 'plugins', 'git', 'worker.js'), 'hacking on git()')
    await made.loader.start()
    expect(stateOf(made.loader, 'git')).toBe('ready')
  })

  it('switched off, a plugin reads off whatever its check says and its dependents wait', async () => {
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger', { requires: ['outline'] })) },
      entries: { outline: signed({ enabled: false }), tagger: signed() },
    })
    await writeFile(path.join(made.dataDir, 'plugins', 'outline', 'worker.js'), 'changed()')
    await made.loader.start()
    expect(stateOf(made.loader, 'outline')).toBe('off')
    expect(reasonOf(made.loader, 'tagger')).toBe('dependency:outline:off')
    expect(made.link.events('plugin.checked')).toContainEqual({ plugin: 'outline', from: 'folder', result: 'tampered' })
  })
})

describe('the scan', () => {
  it('finds a folder with no entry, records plugin.found and starts nothing, its dependents waiting on it', async () => {
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger', { requires: ['outline'] })) },
      entries: { tagger: signed() },
    })
    await made.loader.start()
    expect(stateOf(made.loader, 'outline')).toBe('found')
    expect(reasonOf(made.loader, 'outline')).toBe('new')
    expect(made.link.events('plugin.found')).toEqual([{ plugin: 'outline' }])
    expect(reasonOf(made.loader, 'tagger')).toBe('dependency:outline:new')
    expect(made.runtime.order()).not.toContain('outline')
  })

  it('refuses a plugin whose entry failed its check, and one whose entry is in a newer format', async () => {
    const entry = (dataDir: string, id: string) => path.join(dataDir, 'state', 'plugins', `${id}.json`)
    const made = await harness({
      folder: { outline: outline(), tagger: filesFor(workerManifest('tagger')), mapper: filesFor(workerManifest('mapper')) },
      entries: { mapper: signed() },
      before: async ({ dataDir }) => {
        await plant(entry(dataDir, 'outline'), '{"format":2,"version":"1.0.0"}')
        await plant(entry(dataDir, 'tagger'), '{"format":3}')
        // An edit by something that doesn't know hetu leaves the old hash line
        const file = entry(dataDir, 'mapper')
        await writeFile(file, (await readFile(file, 'utf8')).replace('"enabled": true', '"enabled": false'))
      },
    })
    await made.loader.start()
    expect(reasonOf(made.loader, 'outline')).toBe('entry')
    expect(reasonOf(made.loader, 'tagger')).toBe('newer')
    expect(reasonOf(made.loader, 'mapper')).toBe('entry')
    expect(made.runtime.order()).toEqual(['gate'])
  })

  it('counts what in the plugin folder is no plugin folder, a file or a bad name, without reading it', async () => {
    const made = await harness({ folder: { outline: outline() }, entries: { outline: signed() } })
    await writeFile(path.join(made.dataDir, 'plugins', 'notes.txt'), 'x')
    await mkdir(path.join(made.dataDir, 'plugins', 'Bad Name'))
    await writeFile(path.join(made.dataDir, 'plugins', '.DS_Store'), '')
    await made.loader.start()
    expect(made.link.events('plugin.checked')).toContainEqual({ plugin: null, from: 'folder', result: 'bad-name', count: 2 })
    expect(stateOf(made.loader, 'outline')).toBe('ready')
  })

  it('names the first-party signer the copies carry, which no community entry can borrow', () => {
    expect(FIRST_PARTY_SIGNER).toBe('hetu first-party')
  })
})
