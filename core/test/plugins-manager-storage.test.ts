import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StorageModule } from '../backend/modules.ts'
import { cleanup, entryFor, filesFor, harness, workerManifest } from './plugins-manager-fakes.ts'

afterEach(cleanup)

// Storage as the core holds it, keeping each clear. open throws while told to
function storageModule(opens = true) {
  const cleared: string[] = []
  const storage: StorageModule = {
    prepare: async () => ({ scope: {} }),
    perform: async () => null,
    open: () => {
      if (!opens) throw new Error('no data folder')
    },
    clear: async (kind, space) => {
      cleared.push(`${kind}/${space}`)
    },
  }
  return { cleared, storage }
}

const tool = { folder: { tool: filesFor(workerManifest('tool')) }, entries: { tool: (root: string) => entryFor(root) } }

describe('clearing a plugin’s spaces', () => {
  it('goes through storage while it is on, so the clear waits for the calls already queued on the space', async () => {
    const { cleared, storage } = storageModule()
    const made = await harness({ ...tool, modules: { storage } })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.clearStorage', plugin: 'tool' })
    await made.pluginsManager.apply({ kind: 'plugin.reset', plugin: 'tool' })
    expect(cleared).toEqual(['storage/tool', 'storage/tool', 'cache/tool'])
  })

  it.each([
    ['switched off', { switches: { off: ['storage'] } }, true],
    ['failed at its start', {}, false],
  ] as const)('removes the folder itself with storage %s', async (_name, more, opens) => {
    const { cleared, storage } = storageModule(opens)
    const made = await harness({ ...tool, ...more, modules: { storage } })
    await mkdir(path.join(made.dataDir, 'storage', 'tool'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'storage', 'tool', 'key-a'), 'x')
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.clearStorage', plugin: 'tool' })
    expect(await readdir(path.join(made.dataDir, 'storage')).catch(() => [])).toEqual([])
    expect(cleared).toEqual([])
  })
})
