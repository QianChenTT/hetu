import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHost } from '@hetu/sdk/esbuild'

const root = path.join(import.meta.dirname, '..')

describe('the host half as it ships', () => {
  it('builds into one ES module importing only the built-ins its manifest names, holding the plugin and the provider', async () => {
    const built = await buildHost(root, 'src/host.ts', ['crypto', 'fs', 'path'])
    expect(built.imports).toEqual(['node:crypto', 'node:fs/promises', 'node:path'])
    const module = await import(`data:text/javascript;base64,${Buffer.from(built.text).toString('base64')}`) as Record<string, unknown>
    expect((module.default as { kind: string }).kind).toBe('hetu-plugin')
    const provider = module.provider as Record<string, unknown>
    for (const name of ['prepare', 'perform', 'open']) expect(typeof provider[name]).toBe('function')
    expect(Object.keys(module).sort()).toEqual(['default', 'provider', 'storage'])
  })

  it('can\'t build with a built-in its manifest leaves out', async () => {
    await expect(buildHost(root, 'src/host.ts', ['crypto', 'path'])).rejects.toThrow('isn\'t in the manifest\'s node list')
  })
})
