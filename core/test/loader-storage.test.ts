import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, coreInstall, entryFor, filesFor, harness, hostManifest, workerManifest } from './loader-fakes.ts'

afterEach(cleanup)

const withStorage = () => ({ ...coreInstall(), storage: { files: filesFor(hostManifest('storage')) } })

function storageRole() {
  const cleared: string[] = []
  return { cleared, clear: async (kind: 'storage' | 'cache', space: string) => { cleared.push(`${kind}/${space}`) } }
}

describe('clearing a plugin’s spaces', () => {
  it('goes through the storage plugin while it runs, so the clear waits for the calls already queued on the space', async () => {
    const storage = storageRole()
    const made = await harness({
      install: withStorage(),
      behave: { storage: { exports: { storage } } },
      folder: { tool: filesFor(workerManifest('tool')) },
      entries: { tool: root => entryFor(root) },
    })
    await made.loader.start()
    await made.loader.apply({ kind: 'plugin.clearStorage', plugin: 'tool' })
    await made.loader.apply({ kind: 'plugin.reset', plugin: 'tool' })
    expect(storage.cleared).toEqual(['storage/tool', 'storage/tool', 'cache/tool'])
  })

  it('removes the folder itself with no storage plugin running', async () => {
    const made = await harness({ folder: { tool: filesFor(workerManifest('tool')) }, entries: { tool: root => entryFor(root) } })
    await mkdir(path.join(made.dataDir, 'storage', 'tool'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'storage', 'tool', 'key-a'), 'x')
    await made.loader.start()
    await made.loader.apply({ kind: 'plugin.clearStorage', plugin: 'tool' })
    expect(await readdir(path.join(made.dataDir, 'storage')).catch(() => [])).toEqual([])
  })
})
