import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkManifest } from '@hetu/sdk/check-manifest'
import { buildHost } from '@hetu/sdk/esbuild'

const root = path.join(import.meta.dirname, '..')

describe('the host half as it ships', () => {
  it('builds into one ES module importing only the built-ins its manifest names and holding the plugin alone', async () => {
    const { node } = JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')) as { node: string[] }
    expect(node).toEqual(['http'])
    const built = await buildHost(root, 'src/host.ts', node)
    expect(built.imports).toEqual(['node:http'])
    // Importing the module binds nothing: the door opens only from start, once mcp is there
    const module = await import(`data:text/javascript;base64,${Buffer.from(built.text).toString('base64')}`) as Record<string, unknown>
    expect((module.default as { kind: string }).kind).toBe('hetu-plugin')
    expect(Object.keys(module)).toEqual(['default'])
  })

  it('has an install manifest that asks to call mcp alone and requires nothing', async () => {
    expect(await checkManifest(root, { install: true })).toEqual([])
    const manifest = JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({ id: 'mcp-http-handler', entries: { host: 'dist/host.js' } })
    expect(manifest.capabilities).toEqual([{ type: 'plugin.call', targets: ['mcp'] }])
    expect(manifest.requires).toBeUndefined()
  })
})
