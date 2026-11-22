import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, entryFor, filesFor, harness, hashOf, stateOf, workerManifest } from './plugins-manager-fakes.ts'

// What removing a plugin-folder plugin takes with it

// A remove of the plugin folder named here fails as a held folder would
const fake: { held: string | null } = { held: null }

vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rm: (async (target: Parameters<typeof real.rm>[0], options?: Parameters<typeof real.rm>[1]) => {
      if (fake.held !== null && path.resolve(String(target)) === fake.held) throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return real.rm(target, options)
    }) as typeof real.rm,
  }
})

afterEach(async () => {
  fake.held = null
  await cleanup()
})

const outline = () => filesFor(workerManifest('outline'))

describe('removing a plugin-folder plugin', () => {
  it('takes its build out of allowUnsigned, so the same bytes put back wait for the human again', async () => {
    const made = await harness({ folder: { outline: outline() }, entries: { outline: root => entryFor(root) } })
    await made.pluginsManager.start()
    const hash = await hashOf(path.join(made.dataDir, 'plugins', 'outline'))
    const before = (await made.store.load()).state.switches
    expect(before.allowUnsigned).toContain(hash)
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'outline' })
    expect((await made.store.load()).state.switches).toEqual({ ...before, allowUnsigned: before.allowUnsigned.filter(one => one !== hash) })
  })

  it('keeps the build allowed while another entry names it', async () => {
    const made = await harness({
      folder: { outline: outline() },
      entries: { outline: root => entryFor(root), twin: root => entryFor(path.join(path.dirname(root), 'outline')) },
    })
    await made.pluginsManager.start()
    const hash = await hashOf(path.join(made.dataDir, 'plugins', 'outline'))
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'outline' })
    expect((await made.store.load()).state.switches.allowUnsigned).toContain(hash)
  })
})
