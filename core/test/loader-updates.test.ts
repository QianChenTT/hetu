import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateStore } from '../backend/boot/state.ts'
import type { Landing } from '../backend/loader/seams.ts'
import {
  cleanup, coreInstall, entryFor, filesFor, harness, hashOf, reasonOf, stateOf, until, workerManifest, writeFolder, type Files,
} from './loader-fakes.ts'

afterEach(cleanup)

const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const worker = (id: string, extra: object = {}): Files => filesFor(workerManifest(id, extra))

// alpha with beta requiring it, both running
async function running(extra: Parameters<typeof harness>[0] = {}) {
  const made = await harness({
    folder: { alpha: worker('alpha'), beta: worker('beta', { requires: ['alpha'] }) },
    entries: { alpha: signed(), beta: signed() },
    ...extra,
  })
  await made.loader.start()
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
    // Only a class 0 update may load on its own and nothing reads a class yet, so every update waits for a Confirm
    // naming what it stops: the plugin itself and what requires it
    expect(await made.loader.update('alpha', dir)).toEqual({ outcome: 'confirm', stops: ['alpha', 'beta'] })
    expect(made.loader.pending()).toMatchObject([{ kind: 'plugin.update', plugin: 'alpha' }])
    expect(made.link.events('plugin.updated')).toEqual([])
    expect(made.loader.plugin('alpha')?.incarnation).toBe(1)
    await made.loader.apply({ kind: 'plugin.update', plugin: 'alpha' })
    await made.loader.settled()
    expect(made.link.events('plugin.updated')).toEqual([{ plugin: 'alpha', from: '1.0.0', to: '1.1.0' }])
    expect(await hashOf(path.join(made.dataDir, 'plugins', 'alpha'))).toBe(hash)
    const entry = (await new StateStore(made.dataDir).load()).state.plugins.alpha
    expect(entry).toMatchObject({ version: '1.1.0', contentHash: hash, signer: 'sigstore:someone' })
    // The old incarnation stopped after its dependent, the new one runs the staged bytes
    const lines = made.link.timeline.filter(line => /^(stop|init) (alpha|beta)$/.test(line))
    expect(lines).toEqual(['init alpha', 'init beta', 'stop beta', 'stop alpha', 'init alpha', 'init beta'])
    expect(made.runtime.started.filter(start => start.id === 'alpha').at(-1)?.code).toBe(next['worker.js'])
    expect(made.runtime.half('alpha', 2).got('init')[0].previousVersion).toBe('1.0.0')
    expect(stateOf(made.loader, 'beta')).toBe('ready')
    expect(await readdir(path.join(made.dataDir, 'staging'))).toEqual([])
  })

  it('is refused when it would close a cycle with what runs, and nothing changes', async () => {
    const made = await running()
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0', requires: ['beta'] }))
    expect(await made.loader.update('alpha', dir)).toEqual({ outcome: 'refused', reason: 'cycle' })
    expect(made.link.events('plugin.updated')).toEqual([])
    expect(made.loader.plugin('alpha')?.incarnation).toBe(1)
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
  })

  it('needs a Confirm naming the plugins it stops when it would leave a running dependent unsatisfied, raised as plugin.update', async () => {
    const made = await running()
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0', requires: ['not-installed'] }))
    expect(await made.loader.update('alpha', dir)).toEqual({ outcome: 'confirm', stops: ['alpha', 'beta'] })
    expect(made.loader.pending()).toMatchObject([{ kind: 'plugin.update', plugin: 'alpha' }])
    // Nothing applies until the Confirm
    expect(made.link.events('plugin.updated')).toEqual([])
    expect(stateOf(made.loader, 'beta')).toBe('ready')

    await made.loader.apply({ kind: 'plugin.update', plugin: 'alpha' })
    await made.loader.settled()
    expect(reasonOf(made.loader, 'alpha')).toBe('dependency:not-installed:absent')
    expect(reasonOf(made.loader, 'beta')).toBe('dependency:alpha:waiting')
  })

  it('is refused for a manifest that fails its checks, an api range outside this core included', async () => {
    const made = await running()
    expect(await made.loader.update('alpha', await stage(made.dataDir, worker('alpha', { api: '^2' })))).toEqual({ outcome: 'refused', reason: 'api' })
    expect(await made.loader.update('alpha', await stage(made.dataDir, filesFor(workerManifest('alpha', { entries: { host: 'host.js' } }))))).toEqual({ outcome: 'refused', reason: 'install-only' })
    expect(await made.loader.update('nobody', await stage(made.dataDir, worker('nobody')))).toEqual({ outcome: 'refused', reason: 'missing' })
  })

  it('is refused for a first-party copy, which changes only with the install', async () => {
    const made = await harness({ install: { ...coreInstall(), git: { files: worker('git'), firstParty: true } } })
    await made.loader.start()
    expect(stateOf(made.loader, 'git')).toBe('ready')
    expect(await made.loader.update('git', await stage(made.dataDir, worker('git', { version: '1.1.0' })))).toEqual({ outcome: 'refused', reason: 'reserved-id' })
  })

  it('waits for plugin.updated to land and applies nothing when it is lost', async () => {
    const made = await running()
    let land!: (landing: Landing) => void
    made.link.landing = event => event === 'plugin.updated' ? new Promise(resolve => { land = resolve }) : 'landed'
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    await made.loader.update('alpha', dir)
    const updating = made.loader.apply({ kind: 'plugin.update', plugin: 'alpha' })
    await until(() => made.link.events('plugin.updated').length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.0.0')
    land('lost')
    await expect(updating).rejects.toThrow()
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.0.0')
    expect(made.loader.plugin('alpha')?.incarnation).toBe(1)
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
    await made.loader.update('alpha', dir)
    await expect(made.loader.apply({ kind: 'plugin.update', plugin: 'alpha' })).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.0.0')
    expect(made.loader.plugin('alpha')?.incarnation).toBe(1)
    await made.loader.apply({ kind: 'confirmOff', on: true })
    expect((await new StateStore(made.dataDir).load()).state.switches.confirmOff).toBe(true)
  })

  it('reads as a failed check at the next boot when it stopped between the swap and the entry, the old incarnation running on meanwhile', async () => {
    const made = await running()
    const writePlugin = made.store.writePlugin.bind(made.store)
    made.store.writePlugin = async () => { throw new Error('the disk went away') }
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    await made.loader.update('alpha', dir)
    await expect(made.loader.apply({ kind: 'plugin.update', plugin: 'alpha' })).rejects.toThrow('the disk went away')
    made.store.writePlugin = writePlugin
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
    expect(made.loader.plugin('alpha')?.incarnation).toBe(1)
    expect(await readFile(path.join(made.dataDir, 'plugins', 'alpha', 'hetu-plugin.json'), 'utf8')).toContain('1.1.0')

    const next = await harness({ base: made.base, install: undefined })
    await next.loader.start()
    expect(reasonOf(next.loader, 'alpha')).toBe('tampered')
    expect(reasonOf(next.loader, 'beta')).toBe('dependency:alpha:refused')
  })

  it('applies to a plugin switched off without starting it, once confirmed with nothing to stop', async () => {
    const made = await running({ entries: { alpha: signed({ enabled: false }), beta: signed() } })
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    expect(await made.loader.update('alpha', dir)).toEqual({ outcome: 'confirm', stops: [] })
    expect(made.link.events('plugin.updated')).toEqual([])
    await made.loader.apply({ kind: 'plugin.update', plugin: 'alpha' })
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.1.0')
    expect(stateOf(made.loader, 'alpha')).toBe('off')
    expect(made.runtime.order()).not.toContain('alpha')
  })

  // An old release with a known hole can't be swapped back in. Going back is a remove and a new approval
  it.each([['the same', '1.0.0'], ['an older', '0.9.0']])('is refused for %s version, and nothing changes', async (_name, version) => {
    const made = await running()
    const dir = await stage(made.dataDir, worker('alpha', { version }))
    expect(await made.loader.update('alpha', dir)).toEqual({ outcome: 'refused', reason: 'not-newer' })
    await expect(made.loader.apply({ kind: 'plugin.update', plugin: 'alpha' })).rejects.toThrow()
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.0.0')
  })

  it('puts in place the bytes it hashed, whatever the staged folder holds by the Confirm', async () => {
    const made = await running()
    const next = worker('alpha', { version: '1.1.0' })
    const dir = await stage(made.dataDir, next)
    const hash = await hashOf(dir)
    await made.loader.update('alpha', dir)
    await writeFile(path.join(dir, 'worker.js'), 'swapped()')
    await made.loader.apply({ kind: 'plugin.update', plugin: 'alpha' })
    await made.loader.settled()
    expect(await readFile(path.join(made.dataDir, 'plugins', 'alpha', 'worker.js'), 'utf8')).toBe(next['worker.js'])
    expect(await hashOf(path.join(made.dataDir, 'plugins', 'alpha'))).toBe(hash)
    expect(made.runtime.started.filter(start => start.id === 'alpha').at(-1)?.code).toBe(next['worker.js'])
    expect(await readdir(path.join(made.dataDir, 'staging'))).toEqual([])
    const again = await harness({ base: made.base, install: undefined })
    await again.loader.start()
    expect(stateOf(again.loader, 'alpha')).toBe('ready')
  })
})

// Checkpoint B: a second staged update kept the first one's request, so its Confirm applied a version the human never saw
describe('the request for an update', () => {
  const trusted = { kind: 'window' as const, role: 'trusted' as const, n: 1 }
  const call = (action: string) => ({ callId: 'c1', caller: trusted, action, args: undefined, deadline: Date.now() + 30_000 })

  it('names the version it goes from and to', async () => {
    const made = await running()
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    await made.loader.update('alpha', dir)
    const list = await made.loader.serve(call('security.list')) as { requests: { kind: string, notes: string[] }[] }
    expect(list.requests[0].notes).toContain('From 1.0.0 to 1.1.0')
  })

  it('is withdrawn when a newer update is staged, which raises a request of its own', async () => {
    const made = await running()
    await made.loader.update('alpha', await stage(made.dataDir, worker('alpha', { version: '1.1.0' })))
    const [first] = made.loader.pending()
    const later = path.join(made.dataDir, 'staging', 'alpha-later')
    await writeFolder(later, worker('alpha', { version: '1.2.0' }))
    await made.loader.update('alpha', later)
    const [second] = made.loader.pending()
    expect(made.loader.pending()).toHaveLength(1)
    expect(second.id).not.toBe(first.id)
    await expect(made.loader.confirm(first.id, {})).rejects.toEqual({ code: 'not-found' })
  })
})
