import { readdir, readFile } from 'node:fs/promises'
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
  it('applies once its record has landed: the folder swapped, the entry written last, the old incarnation stopped and the new one started', async () => {
    const made = await running()
    const next = worker('alpha', { version: '1.1.0' })
    const dir = await stage(made.dataDir, next)
    const hash = await hashOf(dir)
    const outcome = await made.loader.update('alpha', dir)
    expect(outcome).toEqual({ outcome: 'applied' })
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
    const raised: unknown[] = []
    const made = await running({ loader: { raise: request => { raised.push(request) } } })
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0', requires: ['not-installed'] }))
    expect(await made.loader.update('alpha', dir)).toEqual({ outcome: 'confirm', stops: ['alpha', 'beta'] })
    expect(raised).toEqual([{ kind: 'plugin.update', plugin: 'alpha', stops: ['alpha', 'beta'] }])
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
    const updating = made.loader.update('alpha', dir)
    await until(() => made.link.events('plugin.updated').length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.0.0')
    land('lost')
    await expect(updating).rejects.toThrow()
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.version).toBe('1.0.0')
    expect(made.loader.plugin('alpha')?.incarnation).toBe(1)
  })

  it('reads as a failed check at the next boot when it stopped between the swap and the entry, the old incarnation running on meanwhile', async () => {
    const made = await running()
    const writePlugin = made.store.writePlugin.bind(made.store)
    made.store.writePlugin = async () => { throw new Error('the disk went away') }
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    await expect(made.loader.update('alpha', dir)).rejects.toThrow('the disk went away')
    made.store.writePlugin = writePlugin
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
    expect(made.loader.plugin('alpha')?.incarnation).toBe(1)
    expect(await readFile(path.join(made.dataDir, 'plugins', 'alpha', 'hetu-plugin.json'), 'utf8')).toContain('1.1.0')

    const next = await harness({ base: made.base, install: undefined })
    await next.loader.start()
    expect(reasonOf(next.loader, 'alpha')).toBe('tampered')
    expect(reasonOf(next.loader, 'beta')).toBe('dependency:alpha:refused')
  })

  it('applies to a plugin switched off without starting it', async () => {
    const made = await running({ entries: { alpha: signed({ enabled: false }), beta: signed() } })
    const dir = await stage(made.dataDir, worker('alpha', { version: '1.1.0' }))
    expect(await made.loader.update('alpha', dir)).toEqual({ outcome: 'applied' })
    expect(stateOf(made.loader, 'alpha')).toBe('off')
    expect(made.runtime.order()).not.toContain('alpha')
  })
})
