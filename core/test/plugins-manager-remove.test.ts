import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, entryFor, filesFor, harness, hashOf, stateOf, workerManifest } from './plugins-manager-fakes.ts'

// What removing a plugin-folder plugin takes with it, and a remove whose folder can't be cleared

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

  // The entry and the build's allow are gone, so the folder left can't run. Its row stays as the next start would find
  // it, waiting for approval, so the human sees it and removes it again
  it('keeps the row waiting for approval when the folder can\'t be cleared, and clears it on a second remove', async () => {
    const made = await harness({ folder: { outline: outline() }, entries: { outline: root => entryFor(root) } })
    await made.pluginsManager.start()
    fake.held = path.resolve(made.dataDir, 'plugins', 'outline')
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'outline' })
    expect(made.link.events('fault')).toContainEqual({ plugin: 'outline', step: 'remove' })
    expect(made.pluginsManager.list().find(row => row.id === 'outline')).toMatchObject({ from: 'folder', state: 'found', reason: 'new' })
    expect((await made.store.load()).state.plugins.outline).toBeUndefined()
    fake.held = null
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'outline' })
    expect(made.pluginsManager.plugin('outline')).toBe(null)
    expect(made.pluginsManager.list().some(row => row.id === 'outline')).toBe(false)
    const again = await harness({ base: made.base, install: undefined })
    await again.pluginsManager.start()
    expect(again.pluginsManager.plugin('outline')).toBe(null)
  })

  it('reads a folder left from a remove whose clear failed as found at the next start, never running it', async () => {
    const made = await harness({ folder: { outline: outline() }, entries: { outline: root => entryFor(root) } })
    await made.pluginsManager.start()
    fake.held = path.resolve(made.dataDir, 'plugins', 'outline')
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'outline' })
    fake.held = null
    const again = await harness({ base: made.base, install: undefined })
    await again.pluginsManager.start()
    expect(stateOf(again.pluginsManager, 'outline')).toBe('found')
    expect(again.runtime.order()).not.toContain('outline')
  })
})
