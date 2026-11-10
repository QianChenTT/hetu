import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkManifest } from '@hetu/sdk/check-manifest'
import { buildHost } from '@hetu/sdk/esbuild'

const root = path.join(import.meta.dirname, '..')

describe('the host half as it ships', () => {
  it('builds into one ES module importing only the built-ins its manifest names, holding the plugin, the provider and the exec role', async () => {
    const { node } = JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')) as { node: string[] }
    expect(node).toEqual(['child_process', 'crypto', 'fs', 'path'])
    const built = await buildHost(root, 'src/host.ts', node)
    expect(built.imports).toEqual(['node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:path'])
    const module = await import(`data:text/javascript;base64,${Buffer.from(built.text).toString('base64')}`) as Record<string, unknown>
    expect((module.default as { kind: string }).kind).toBe('hetu-plugin')
    for (const name of ['prepare', 'perform', 'release']) expect(typeof (module.provider as Record<string, unknown>)[name]).toBe('function')
    expect(typeof (module.exec as Record<string, unknown>).stateChanged).toBe('function')
    expect(Object.keys(module).sort()).toEqual(['default', 'exec', 'provider'])
  })

  it('has an install manifest that asks for nothing and requires nothing', async () => {
    expect(await checkManifest(root, { install: true })).toEqual([])
    const manifest = JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.capabilities).toBeUndefined()
    expect(manifest.requires).toBeUndefined()
  })
})
