import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateStore } from '../backend/boot/state.ts'
import type { Landing } from '../backend/plugins-manager/header.ts'
import {
  cleanup, coreInstall, entryFor, filesFor, harness, hashOf, reasonOf, stateOf, until, workerManifest, writeFolder, type Files,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const worker = (id: string, extra: object = {}): Files => filesFor(workerManifest(id, extra))

// alpha with beta requiring it, both running. The grant risk classifier is switched off, so each keeps the class 1 its
// entry holds
async function running(extra: Parameters<typeof harness>[0] = {}) {
  const made = await harness({
    folder: { alpha: worker('alpha'), beta: worker('beta', { requires: ['alpha'] }) },
    entries: { alpha: signed(), beta: signed() },
    switches: { off: ['grant-risk-classifier'] },
    ...extra,
  })
  await made.pluginsManager.start()
  return made
}

async function stage(dataDir: string, files: Files): Promise<string> {
  const dir = path.join(dataDir, 'staging', 'alpha-next')
  await writeFolder(dir, files)
  return dir
}

describe('a staged update', () => {
  it('applies once confirmed and its record has landed: the folder swapped, the entry written last, the old incarnation stopped and the new one started', async () => {
    const made = await running()
    const next = worker('alpha', { version: '1.1.0' })
    const dir = await stage(made.dataDir, next)
    const hash = await hashOf(dir)
    // alpha is class 1, and only a class 0 update loads on its own, so this one waits for a Confirm naming what it
    // stops: the plugin itself and what requires it
    expect(await made.pluginsManager.update('alpha', dir)).toEqual({ outcome: 'confirm', stops: ['alpha', 'beta'] })
    expect(made.pluginsManager.pending()).toMatchObject([{ kind: 'plugin.update', plugin: 'alpha' }])
    expect(made.link.events('plugin.updated')).toEqual([])
    expect(made.pluginsManager.plugin('alpha')?.incarnation).toBe(1)
    await made.pluginsManager.apply({ kind: 'plugin.update', plugin: 'alpha' })
    await made.pluginsManager.settled()
    expect(made.link.events('plugin.updated')).toEqual([{ plugin: 'alpha', from: '1.0.0', to: '1.1.0' }])
    expect(await hashOf(path.join(made.dataDir, 'plugins', 'alpha'))).toBe(hash)
    const entry = (await new StateStore(made.dataDir).load()).state.plugins.alpha
    expect(entry).toMatchObject({ version: '1.1.0', contentHash: hash, signer: 'sigstore:someone' })
    // The old incarnation stopped after its dependent, the new one runs the staged bytes
    const lines = made.link.timeline.filter(line => /^(stop|init) (alpha|beta)$/.test(line))
    expect(lines).toEqual(['init alpha', 'init beta', 'stop beta', 'stop alpha', 'init alpha', 'init beta'])
    expect(made.runtime.started.filter(start => start.id === 'alpha').at(-1)?.code).toBe(next['worker.js'])
    expect(made.runtime.half('alpha', 2).got('init')[0].previousVersion).toBe('1.0.0')
    expect(stateOf(made.pluginsManager, 'beta')).toBe('ready')
    expect(await readdir(path.join(made.dataDir, 'staging'))).toEqual([])
  })

  it('is refused when it would close a cycle with what runs, and nothing changes', async () => {
    const made = await running()
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0', requires: ['beta'] }))
    expect(await made.pluginsManager.update('alpha', dir)).toEqual({ outcome: 'refused', reason: 'cycle' })
    expect(made.link.events('plugin.updated')).toEqual([])
    expect(made.pluginsManager.plugin('alpha')?.incarnation).toBe(1)
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
  })

  it('needs a Confirm naming the plugins it stops when it would leave a running dependent unsatisfied, raised as plugin.update', async () => {
    const made = await running()
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0', requires: ['not-installed'] }))
    expect(await made.pluginsManager.update('alpha', dir)).toEqual({ outcome: 'confirm', stops: ['alpha', 'beta'] })
    expect(made.pluginsManager.pending()).toMatchObject([{ kind: 'plugin.update', plugin: 'alpha' }])
    // Nothing applies until the Confirm
    expect(made.link.events('plugin.updated')).toEqual([])
    expect(stateOf(made.pluginsManager, 'beta')).toBe('ready')

    await made.pluginsManager.apply({ kind: 'plugin.update', plugin: 'alpha' })
    await made.pluginsManager.settled()
    expect(reasonOf(made.pluginsManager, 'alpha')).toBe('dependency:not-installed:absent')
    expect(reasonOf(made.pluginsManager, 'beta')).toBe('dependency:alpha:waiting')
  })

  it('is refused for a manifest that fails its checks, an api range outside this core included', async () => {
    const made = await running()
    expect(await made.pluginsManager.update('alpha', await stage(made.dataDir, worker('alpha', { api: '^1' })))).toEqual({ outcome: 'refused', reason: 'api' })
    expect(await made.pluginsManager.update('alpha', await stage(made.dataDir, filesFor(workerManifest('alpha', { entries: { host: 'host.js' } }))))).toEqual({ outcome: 'refused', reason: 'install-only' })
    expect(await made.pluginsManager.update('nobody', await stage(made.dataDir, worker('nobody')))).toEqual({ outcome: 'refused', reason: 'missing' })
  })

  it('is refused for a first-party copy, which changes only with the install', async () => {
    const made = await harness({ install: { ...coreInstall(), git: { files: worker('git'), firstParty: true } } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'git')).toBe('ready')
    expect(await made.pluginsManager.update('git', await stage(made.dataDir, worker('git', { version: '1.1.0' })))).toEqual({ outcome: 'refused', reason: 'reserved-id' })
  })

  it('waits for plugin.updated to land and applies nothing when it is lost', async () => {
    const made = await running()
    let land!: (landing: Landing) => void
    made.link.landing = event => event === 'plugin.updated' ? new Promise(resolve => { land = resolve }) : 'landed'
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    await made.pluginsManager.update('alpha', dir)
    const updating = made.pluginsManager.apply({ kind: 'plugin.update', plugin: 'alpha' })
    await until(() => made.link.events('plugin.updated').length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.0.0')
    land('lost')
    await expect(updating).rejects.toThrow()
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.0.0')
    expect(made.pluginsManager.plugin('alpha')?.incarnation).toBe(1)
  })

  it('refuses an update whose record waits past the deadline, withdraws the record and applies the next change', async () => {
    const made = await running()
    made.link.limits.readyMs = 100
    let signal: AbortSignal | undefined
    made.link.landing = (event, _fields, given) => {
      if (event !== 'plugin.updated') return 'landed'
      signal = given
      return new Promise<Landing>(() => {})
    }
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    await made.pluginsManager.update('alpha', dir)
    await expect(made.pluginsManager.apply({ kind: 'plugin.update', plugin: 'alpha' })).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.0.0')
    expect(made.pluginsManager.plugin('alpha')?.incarnation).toBe(1)
    await made.pluginsManager.apply({ kind: 'confirmOff', on: true })
    expect((await new StateStore(made.dataDir).load()).state.switches.confirmOff).toBe(true)
  })

  it('reads as a failed check at the next boot when it stopped between the swap and the entry, the old incarnation running on meanwhile', async () => {
    const made = await running()
    const writePlugin = made.store.writePlugin.bind(made.store)
    made.store.writePlugin = async () => { throw new Error('the disk went away') }
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    await made.pluginsManager.update('alpha', dir)
    await expect(made.pluginsManager.apply({ kind: 'plugin.update', plugin: 'alpha' })).rejects.toThrow('the disk went away')
    made.store.writePlugin = writePlugin
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    expect(made.pluginsManager.plugin('alpha')?.incarnation).toBe(1)
    expect(await readFile(path.join(made.dataDir, 'plugins', 'alpha', 'hetu-plugin.json'), 'utf8')).toContain('1.1.0')

    const next = await harness({ base: made.base, install: undefined })
    await next.pluginsManager.start()
    expect(reasonOf(next.pluginsManager, 'alpha')).toBe('tampered')
    expect(reasonOf(next.pluginsManager, 'beta')).toBe('dependency:alpha:refused')
  })

  it('applies to a plugin switched off without starting it, once confirmed with nothing to stop', async () => {
    const made = await running({ entries: { alpha: signed({ enabled: false }), beta: signed() } })
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    expect(await made.pluginsManager.update('alpha', dir)).toEqual({ outcome: 'confirm', stops: [] })
    expect(made.link.events('plugin.updated')).toEqual([])
    await made.pluginsManager.apply({ kind: 'plugin.update', plugin: 'alpha' })
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.1.0')
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('off')
    expect(made.runtime.order()).not.toContain('alpha')
  })

  // An old release with a known hole can't be swapped back in. Going back is a remove and a new approval
  it.each([['the same', '1.0.0'], ['an older', '0.9.0']])('is refused for %s version, and nothing changes', async (_name, version) => {
    const made = await running()
    const dir = await stage(made.dataDir, worker('alpha', { version }))
    expect(await made.pluginsManager.update('alpha', dir)).toEqual({ outcome: 'refused', reason: 'not-newer' })
    await expect(made.pluginsManager.apply({ kind: 'plugin.update', plugin: 'alpha' })).rejects.toThrow()
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.0.0')
  })

  it('puts in place the bytes it hashed, whatever the staged folder holds by the Confirm', async () => {
    const made = await running()
    const next = worker('alpha', { version: '1.1.0' })
    const dir = await stage(made.dataDir, next)
    const hash = await hashOf(dir)
    await made.pluginsManager.update('alpha', dir)
    await writeFile(path.join(dir, 'worker.js'), 'swapped()')
    await made.pluginsManager.apply({ kind: 'plugin.update', plugin: 'alpha' })
    await made.pluginsManager.settled()
    expect(await readFile(path.join(made.dataDir, 'plugins', 'alpha', 'worker.js'), 'utf8')).toBe(next['worker.js'])
    expect(await hashOf(path.join(made.dataDir, 'plugins', 'alpha'))).toBe(hash)
    expect(made.runtime.started.filter(start => start.id === 'alpha').at(-1)?.code).toBe(next['worker.js'])
    expect(await readdir(path.join(made.dataDir, 'staging'))).toEqual([])
    const again = await harness({ base: made.base, install: undefined })
    await again.pluginsManager.start()
    expect(stateOf(again.pluginsManager, 'alpha')).toBe('ready')
  })
})

// A second staged update kept the first one's request, so its Confirm applied a version the human never saw
describe('the request for an update', () => {
  const trusted = { kind: 'window' as const, role: 'trusted' as const, n: 1 }
  const call = (action: string) => ({ callId: 'c1', caller: trusted, root: trusted, action, args: undefined, deadline: Date.now() + 30_000 })

  it('names the version it goes from and to', async () => {
    const made = await running()
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    await made.pluginsManager.update('alpha', dir)
    const list = await made.pluginsManager.serve(call('security.list')) as { requests: { kind: string, notes: string[] }[] }
    expect(list.requests[0].notes).toContain('From 1.0.0 to 1.1.0')
  })

  it('is withdrawn when a newer update is staged, which raises a request of its own', async () => {
    const made = await running()
    await made.pluginsManager.update('alpha', await stage(made.dataDir, worker('alpha', { version: '1.1.0' })))
    const [first] = made.pluginsManager.pending()
    const later = path.join(made.dataDir, 'staging', 'alpha-later')
    await writeFolder(later, worker('alpha', { version: '1.2.0' }))
    await made.pluginsManager.update('alpha', later)
    const [second] = made.pluginsManager.pending()
    expect(made.pluginsManager.pending()).toHaveLength(1)
    expect(second.id).not.toBe(first.id)
    await expect(made.pluginsManager.confirm(first.id, {})).rejects.toEqual({ code: 'not-found' })
  })
})
