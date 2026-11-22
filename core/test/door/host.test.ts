import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { doorNode } from '../../api/ids.ts'
import { buildHost } from '../../sdk/build/esbuild.ts'

const core = path.join(import.meta.dirname, '..', '..')
const source = path.join(core, 'backend', 'door')

describe('the door as it ships', () => {
  it('builds into one ES module importing only the built-ins core/api names for it and holding the plugin alone', async () => {
    const built = await buildHost(core, 'backend/door/host.ts', doorNode)
    expect(built.imports).toEqual(['node:fs/promises', 'node:http', 'node:net', 'node:os'])
    // Importing the module binds nothing: the door and the pipe open only from start, once door.handle is served
    const module = await import(`data:text/javascript;base64,${Buffer.from(built.text).toString('base64')}`) as Record<string, unknown>
    expect((module.default as { kind: string }).kind).toBe('hetu-plugin')
    expect(Object.keys(module)).toEqual(['default'])
  })

  // The door calls the role door.handle, which the router delivers to the plugin holding it, so it names no plugin
  it('names no plugin in its code: no call to mcp, no mcp.handle and no has on mcp', async () => {
    for (const name of (await readdir(source)).filter(name => name.endsWith('.ts'))) {
      const text = await readFile(path.join(source, name), 'utf8')
      expect(text, name).not.toMatch(/mcp\.handle|\b(?:call|has)\(\s*['"`]mcp['"`]/)
    }
    expect(await readFile(path.join(source, 'keeper.ts'), 'utf8')).toMatch(/ctx\.call\('door', 'handle'/)
  })
})
