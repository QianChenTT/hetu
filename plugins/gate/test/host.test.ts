import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHost } from '@hetu/sdk/esbuild'

const root = path.join(import.meta.dirname, '..')

describe('the host half as it ships', () => {
  it('builds into one ES module with no imports, which loads from a data: URL and holds the plugin and the gate', async () => {
    const built = await buildHost(root, 'src/host.ts', [])
    expect(built.imports).toEqual([])
    const module = await import(`data:text/javascript;base64,${Buffer.from(built.text).toString('base64')}`) as Record<string, unknown>
    expect((module.default as { kind: string }).kind).toBe('hetu-plugin')
    const gate = module.gate as Record<string, unknown>
    for (const name of ['decide', 'canRead', 'verbs', 'stateChanged']) expect(typeof gate[name]).toBe('function')
    expect(Object.keys(module).sort()).toEqual(['default', 'gate'])
  })
})
