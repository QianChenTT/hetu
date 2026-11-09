import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHost } from '@hetu/sdk/esbuild'

const root = path.join(import.meta.dirname, '..')

describe('the host half as it ships', () => {
  it('builds into one ES module with no imports, which loads from a data: URL and holds the plugin, the log role and the provider', async () => {
    const built = await buildHost(root, 'src/host.ts', [])
    expect(built.imports).toEqual([])
    const module = await import(`data:text/javascript;base64,${Buffer.from(built.text).toString('base64')}`) as Record<string, unknown>
    expect((module.default as { kind: string }).kind).toBe('hetu-plugin')
    expect(typeof (module.log as { attach?: unknown }).attach).toBe('function')
    expect(typeof (module.provider as { perform?: unknown }).perform).toBe('function')
    expect(Object.keys(module).sort()).toEqual(['default', 'log', 'provider'])
  })
})
