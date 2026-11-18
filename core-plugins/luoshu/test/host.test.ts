import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHost } from '@hetu/sdk/esbuild'

const root = path.join(import.meta.dirname, '..')

describe('the host half as it ships', () => {
  it('builds into one ES module importing only the built-ins its manifest names, holding the plugin, the provider and the luoshu role', async () => {
    const built = await buildHost(root, 'src/host.ts', ['crypto', 'fs', 'path'])
    expect(built.imports).toEqual(['node:crypto', 'node:fs', 'node:fs/promises', 'node:path'])
    const module = await import(`data:text/javascript;base64,${Buffer.from(built.text).toString('base64')}`) as Record<string, unknown>
    expect((module.default as { kind: string }).kind).toBe('hetu-plugin')
    for (const name of ['prepare', 'perform', 'release']) expect(typeof (module.provider as Record<string, unknown>)[name]).toBe('function')
    expect(typeof (module.luoshu as Record<string, unknown>).open).toBe('function')
    expect(Object.keys(module).sort()).toEqual(['default', 'luoshu', 'provider'])
  })
})
