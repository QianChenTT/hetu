import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkManifest } from '@hetu/sdk/check-manifest'
import { buildHost } from '@hetu/sdk/esbuild'

const root = path.join(import.meta.dirname, '..')

describe('the host half as it ships', () => {
  it('builds into one ES module importing only the built-ins its manifest names and holding the plugin alone', async () => {
    const { node } = JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')) as { node: string[] }
    expect(node).toEqual(['http', 'net', 'os', 'fs'])
    const built = await buildHost(root, 'src/host.ts', node)
    expect(built.imports).toEqual(['node:fs/promises', 'node:http', 'node:net', 'node:os'])
    // Importing the module binds nothing: the door and the pipe open only from start, once door.handle is served
    const module = await import(`data:text/javascript;base64,${Buffer.from(built.text).toString('base64')}`) as Record<string, unknown>
    expect((module.default as { kind: string }).kind).toBe('hetu-plugin')
    expect(Object.keys(module)).toEqual(['default'])
  })

  // The door calls the role door.handle, which the router delivers to the plugin holding it, so it names no plugin
  it('has an install manifest that asks for nothing and requires nothing', async () => {
    expect(await checkManifest(root, { install: true })).toEqual([])
    const manifest = JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({ id: 'mcp-http-handler', entries: { host: 'dist/host.js' } })
    expect(manifest.capabilities).toBeUndefined()
    expect(manifest.requires).toBeUndefined()
  })

  it('names no plugin in its code: no call to mcp, no mcp.handle and no has on mcp', async () => {
    const src = path.join(root, 'src')
    for (const name of await readdir(src)) {
      const source = await readFile(path.join(src, name), 'utf8')
      expect(source, name).not.toMatch(/mcp\.handle|\b(?:call|has)\(\s*['"`]mcp['"`]/)
    }
    expect(await readFile(path.join(src, 'keeper.ts'), 'utf8')).toMatch(/ctx\.call\('door', 'handle'/)
  })
})
