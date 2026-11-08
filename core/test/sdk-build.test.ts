import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkManifest } from '../sdk/build/check-manifest.ts'
import { buildPlugin, checkBundle, checkHostImports } from '../sdk/build/esbuild.ts'

const search = path.join(import.meta.dirname, '..', '..', 'plugins', 'search')
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

// A plugin folder in a temp directory, from file name to text
async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-sdk-build-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), text)
  }
  return dir
}

const manifest = (over: object = {}) => JSON.stringify({
  id: 'sample', name: 'Sample', version: '1.0.0', api: '^1', entries: { worker: 'dist/worker.js' }, ...over,
})

describe('building a plugin', () => {
  it('bundles a worker into one classic script', async () => {
    const dir = await folder({
      'hetu-plugin.json': manifest(),
      'src/worker.ts': "import { twice } from './twice.ts'\n(globalThis as { ran?: number }).ran = twice(21)\n",
      'src/twice.ts': 'export const twice = (n: number): number => n * 2\n',
    })
    const [output] = await buildPlugin(dir, { entries: { 'dist/worker.js': 'src/worker.ts' }, write: false })
    expect(output.text).not.toMatch(/^\s*(import|export)\b/m)
    const context: { ran?: number } = {}
    vm.runInNewContext(output.text, context)
    expect(context.ran).toBe(42)
  })

  it('starts each worker entry on the port its page hands it, so a plugin only exports definePlugin', async () => {
    const sdk = path.join(import.meta.dirname, '..', 'sdk', 'index.ts').split(path.sep).join('/')
    const dir = await folder({
      'hetu-plugin.json': manifest(),
      'src/worker.ts': `import { definePlugin } from '${sdk}'
export default definePlugin({ start() { (globalThis as { started?: boolean }).started = true } })
`,
    })
    const [output] = await buildPlugin(dir, { entries: { 'dist/worker.js': 'src/worker.ts' }, workers: ['dist/worker.js'], write: false })
    const posted: string[] = []
    const port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: (text: string) => posted.push(text) }
    const context: Record<string, unknown> = { onmessage: null, performance, setTimeout, clearTimeout, console, queueMicrotask, AbortController }
    vm.runInNewContext(output.text, context)
    const limits = { messagesPerSecond: 1000, floodFactor: 10, floodMs: 5000, textPerSecond: 1000, resultBytes: 100 }
    ;(context.onmessage as (event: unknown) => void)({ data: { v: 1, kind: 'port', limits }, ports: [port] })
    port.onmessage?.({ data: JSON.stringify({ v: 1, kind: 'init', id: 'sample', incarnation: 1, api: 1, deps: {}, lastStop: null, previousVersion: null }) })
    await vi.waitFor(() => expect(posted).toContain('{"v":1,"kind":"ready"}'))
    expect(context.started).toBe(true)
  })

  it('refuses a worker that imports a Node built-in, through a dependency too', async () => {
    const dir = await folder({
      'hetu-plugin.json': manifest(),
      'src/worker.ts': "import { size } from './dep.ts'\nconsole.log(size)\n",
      'src/dep.ts': "import { statSync } from 'node:fs'\nimport path from 'path'\nexport const size = statSync(path.sep).size\n",
    })
    const failed = await buildPlugin(dir, { entries: { 'dist/worker.js': 'src/worker.ts' }, write: false }).catch((err: unknown) => err)
    expect(String(failed)).toMatch(/node:fs/)
    expect(String(failed)).toMatch(/\bpath\b/)
  })

  it('refuses a worker whose bundle calls eval or new Function', async () => {
    const dir = await folder({
      'hetu-plugin.json': manifest(),
      'src/worker.ts': "const run = new Function('return 1')\nconsole.log(run())\n",
    })
    const failed = await buildPlugin(dir, { entries: { 'dist/worker.js': 'src/worker.ts' }, write: false }).catch((err: unknown) => err)
    expect(String(failed)).toMatch(/new Function/)
  })
})

describe('what a bundle may not hold', () => {
  it('flags eval, new Function and a timer given a string', () => {
    const problems = checkBundle('eval("1")\nnew Function("return 1")\nFunction("x")\nsetTimeout("go()", 1)\nwindow.eval("2")\n')
    expect(problems).toHaveLength(5)
    expect(problems[0]).toMatch(/^1:\d+ /)
  })

  it('passes code with none of them', () => {
    expect(checkBundle('const evaluate = (f) => f()\nsetTimeout(() => evaluate(Math.max), 1)\nconst o = { eval: 1 }\n')).toEqual([])
  })
})

describe('a host half\'s imports', () => {
  it('flags a Node built-in the manifest\'s node list doesn\'t name', async () => {
    const dir = await folder({
      'host.ts': "import { readFile } from 'node:fs/promises'\nimport { spawn } from 'node:child_process'\nexport { readFile, spawn }\n",
    })
    const problems = await checkHostImports(path.join(dir, 'host.ts'), ['fs'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/child_process/)
  })
})

describe('checking a manifest', () => {
  it('passes search\'s manifest', async () => {
    expect(await checkManifest(search)).toEqual([])
  })

  it('refuses an unknown capability, a duplicate key and a missing entry once built', async () => {
    const unknown = await folder({ 'hetu-plugin.json': manifest({ capabilities: [{ type: 'luoshu.teleport' }] }) })
    expect((await checkManifest(unknown)).length).toBeGreaterThan(0)
    const doubled = await folder({ 'hetu-plugin.json': manifest().replace('"name":"Sample"', '"name":"Sample","name":"Other"') })
    expect((await checkManifest(doubled)).length).toBeGreaterThan(0)
    const unbuilt = await folder({ 'hetu-plugin.json': manifest() })
    expect(await checkManifest(unbuilt)).toEqual([])
    expect(await checkManifest(unbuilt, { built: true })).toEqual(['dist/worker.js is missing'])
  })
})

describe('search as it ships', () => {
  it('builds into one script under the data: URL cap with no zod and no Node', async () => {
    const outputs = await buildPlugin(search, { entries: { 'dist/worker.js': 'src/worker.ts' }, workers: ['dist/worker.js'], write: false })
    expect(outputs).toHaveLength(1)
    expect(outputs[0].bytes).toBeLessThan(1.5 * 1024 * 1024)
    expect(outputs[0].inputs.filter(input => input.includes('zod') || input.startsWith('node:'))).toEqual([])
  })
})
