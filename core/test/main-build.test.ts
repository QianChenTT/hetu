import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_LIST, installList } from '../api/install.ts'
import { installManifest } from '../api/manifest.ts'
import { type BuildKind, buildMain } from '../build/main.ts'
import { hashFiles, readFiles } from '../lib/hash-files.ts'
import { parseStrict } from '../lib/hashed-file.ts'
import { checkManifest } from '../sdk/build/check-manifest.ts'
import { buildPlugin } from '../sdk/build/esbuild.ts'

const repo = path.join(import.meta.dirname, '..', '..')
const made: string[] = []

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function outDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-main-'))
  made.push(dir)
  return dir
}

describe('the main bundle', () => {
  it('bundles main.ts into one module that imports only electron and Node built-ins', async () => {
    const out = await outDir()
    const built = await buildMain(out)
    expect(built.imports).toContain('electron')
    expect(built.imports.filter(name => name !== 'electron' && !isBuiltin(name))).toEqual([])
    expect(await readFile(path.join(out, 'main.js'), 'utf8')).toMatch(/from ["']electron["']/)
  })

  it('writes search into the install as a first-party copy, built, with the hash of its files', async () => {
    const out = await outDir()
    await buildMain(out)
    const list = parseStrict(await readFile(path.join(out, INSTALL_LIST)), installList)
    const root = path.join(out, 'plugins', 'search')
    expect(Object.keys(list.plugins).sort()).toEqual(['capabilities', 'exec', 'file-explorer', 'gate', 'hidden-marks', 'history', 'http', 'layout', 'luoshu', 'search', 'storage'])
    expect(list.plugins.search).toEqual({ path: 'plugins/search', version: '0.1.0', hash: hashFiles(await readFiles(root)), firstParty: true })
    expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/worker.js', 'hetu-plugin.json'])
  })

  it('writes hetu\'s own layout into the install as a first-party copy, a worker holding ui.layout and storage', async () => {
    const out = await outDir()
    await buildMain(out)
    const list = parseStrict(await readFile(path.join(out, INSTALL_LIST)), installList)
    const root = path.join(out, 'plugins', 'layout')
    expect(list.plugins.layout).toEqual({ path: 'plugins/layout', version: '0.1.0', hash: hashFiles(await readFiles(root)), firstParty: true })
    expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/worker.js', 'hetu-plugin.json'])
    expect(await checkManifest(root, { built: true })).toEqual([])
  })

  // Its source is the community package npm installed at the commit package.json pins. Its manifest is held here in
  // full, so a new commit that changes what the explorer may do shows in hetu's own diff and not only as a new hash
  it('writes the file explorer into the install as a first-party copy built from the community package, with the hash of its files', async () => {
    const out = await outDir()
    await buildMain(out)
    const list = parseStrict(await readFile(path.join(out, INSTALL_LIST)), installList)
    const root = path.join(out, 'plugins', 'file-explorer')
    expect(list.plugins['file-explorer']).toEqual({ path: 'plugins/file-explorer', version: '0.1.0', hash: hashFiles(await readFiles(root)), firstParty: true })
    expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/worker.js', 'hetu-plugin.json'])
    expect(await checkManifest(root, { built: true })).toEqual([])
    expect(JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8'))).toEqual({
      id: 'file-explorer',
      name: 'Files',
      version: '0.1.0',
      api: '^3',
      entries: { worker: 'dist/worker.js' },
      requires: ['luoshu'],
      views: { files: { title: 'Files', kind: 'view' } },
      capabilities: [
        { type: 'luoshu.list', paths: ['**'] },
        { type: 'luoshu.read', paths: ['**'] },
        { type: 'luoshu.write', paths: ['**'] },
        { type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] },
        { type: 'ui.view' },
        { type: 'storage' },
      ],
    })
    const source = path.join(repo, 'node_modules', 'hetu-plugins', 'file-explorer')
    expect(await readFile(path.join(root, 'hetu-plugin.json'))).toEqual(await readFile(path.join(source, 'hetu-plugin.json')))
    const [built] = await buildPlugin(source, { entries: { 'dist/worker.js': 'src/worker.ts' }, workers: ['dist/worker.js'], write: false })
    expect(await readFile(path.join(root, 'dist', 'worker.js'), 'utf8')).toBe(built!.text)
    // Bundled with hetu's own SDK: everything it takes in is the plugin's folder, the core this build runs from or the
    // core @hetu/sdk links to, one folder in a checkout
    const own = await realpath(source)
    const cores = [await realpath(path.join(repo, 'core')), path.dirname(await realpath(path.join(repo, 'node_modules', '@hetu', 'sdk')))]
    const inputs = await Promise.all(built!.inputs.map(input => realpath(path.resolve(source, input.replace(/^hetu-worker:/, '')))))
    expect(inputs.filter(input => input.startsWith(own + path.sep)).length).toBeGreaterThan(0)
    expect(inputs.filter(input => ![own, ...cores].some(folder => input.startsWith(folder + path.sep)))).toEqual([])
  })

  // The build takes source only from this repository and the package npm installed here, so nothing outside the
  // repository can name another folder for it
  it('reads no environment variable and no argument in the modules that pick where a plugin is built from', async () => {
    for (const file of ['main.ts', 'community.ts']) {
      const text = await readFile(path.join(repo, 'core', 'build', file), 'utf8')
      expect(text, file).not.toMatch(/process\s*\.\s*(env|argv)|['"](node:)?process['"]|import\.meta\.env|\bgetenv\b/)
    }
    // Its caller names an output folder and the build's kind, never a source. The typecheck holds both
    const kindNamesNoSource: Exactly<keyof BuildKind, 'packaged' | 'locked'> = true
    const takesTwo: Exactly<Parameters<typeof buildMain>, [outDir?: string, kind?: BuildKind]> = true
    expect([kindNamesNoSource, takesTwo]).toEqual([true, true])
  })

  it('writes the gate and the capabilities plugin into the install as host halves, each one module importing nothing, with the hash of its files', async () => {
    const out = await outDir()
    await buildMain(out)
    const list = parseStrict(await readFile(path.join(out, INSTALL_LIST)), installList)
    for (const [id, role] of [['gate', 'gate'], ['capabilities', 'capabilities']]) {
      const root = path.join(out, 'plugins', id)
      expect(list.plugins[id]).toEqual({ path: `plugins/${id}`, version: '0.1.0', hash: hashFiles(await readFiles(root)) })
      expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/host.js', 'hetu-plugin.json'])
      expect(await checkManifest(root, { install: true, built: true })).toEqual([])
      const text = await readFile(path.join(root, 'dist', 'host.js'))
      expect(text.toString('utf8')).not.toMatch(/^\s*import\b/m)
      const module = await import(`data:text/javascript;base64,${text.toString('base64')}`) as Record<string, unknown>
      expect(typeof module[role]).toBe('object')
    }
  })

  it('writes the luoshu into the install as a host half with its provider and luoshu roles', async () => {
    const out = await outDir()
    await buildMain(out)
    const list = parseStrict(await readFile(path.join(out, INSTALL_LIST)), installList)
    const root = path.join(out, 'plugins', 'luoshu')
    expect(list.plugins.luoshu).toEqual({ path: 'plugins/luoshu', version: '0.1.0', hash: hashFiles(await readFiles(root)) })
    expect(await checkManifest(root, { install: true, built: true })).toEqual([])
    const text = (await readFile(path.join(root, 'dist', 'host.js'))).toString('utf8')
    const module = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`) as Record<string, unknown>
    expect(typeof (module.luoshu as { open?: unknown }).open).toBe('function')
    expect(typeof (module.provider as { perform?: unknown }).perform).toBe('function')
  })

  it('writes storage into the install as a host half importing only the built-ins its manifest names', async () => {
    const out = await outDir()
    await buildMain(out)
    const list = parseStrict(await readFile(path.join(out, INSTALL_LIST)), installList)
    const root = path.join(out, 'plugins', 'storage')
    expect(list.plugins.storage).toEqual({ path: 'plugins/storage', version: '0.1.0', hash: hashFiles(await readFiles(root)) })
    expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/host.js', 'hetu-plugin.json'])
    expect(await checkManifest(root, { install: true, built: true })).toEqual([])
    const text = (await readFile(path.join(root, 'dist', 'host.js'))).toString('utf8')
    const imports = new Set([...text.matchAll(/^import\b.*?from\s*"([^"]+)"/gm)].map(match => match[1]))
    expect([...imports].sort()).toEqual(['node:crypto', 'node:fs/promises', 'node:path'])
    const module = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`) as Record<string, unknown>
    expect(typeof (module.provider as { perform?: unknown }).perform).toBe('function')
  })

  it.each([['history', 'open'], ['exec', 'stateChanged']])('writes %s into the install as a host half with its provider and its role, importing only the built-ins its manifest names', async (id, method) => {
    const out = await outDir()
    await buildMain(out)
    const list = parseStrict(await readFile(path.join(out, INSTALL_LIST)), installList)
    const root = path.join(out, 'plugins', id)
    expect(list.plugins[id]).toEqual({ path: `plugins/${id}`, version: '0.1.0', hash: hashFiles(await readFiles(root)) })
    expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/host.js', 'hetu-plugin.json'])
    expect(await checkManifest(root, { install: true, built: true })).toEqual([])
    const text = (await readFile(path.join(root, 'dist', 'host.js'))).toString('utf8')
    const imports = [...new Set([...text.matchAll(/^import\b.*?from\s*"([^"]+)"/gm)].map(match => match[1]))]
    const named = (JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')) as { node: string[] }).node
    expect(imports.filter(name => !named.some(allowed => name === `node:${allowed}` || name.startsWith(`node:${allowed}/`)))).toEqual([])
    const module = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`) as Record<string, unknown>
    expect(typeof (module.provider as { perform?: unknown }).perform).toBe('function')
    expect(typeof (module[id] as Record<string, unknown>)[method]).toBe('function')
  })

  // http's host half runs in a utility process, so it holds no provider and no role and its module is the plugin alone
  it('writes http into the install as a host half that imports only the built-ins its manifest names and exports the plugin alone', async () => {
    const out = await outDir()
    await buildMain(out)
    const list = parseStrict(await readFile(path.join(out, INSTALL_LIST)), installList)
    const root = path.join(out, 'plugins', 'http')
    expect(list.plugins.http).toEqual({ path: 'plugins/http', version: '0.1.0', hash: hashFiles(await readFiles(root)) })
    expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/host.js', 'hetu-plugin.json'])
    expect(await checkManifest(root, { install: true, built: true })).toEqual([])
    const text = (await readFile(path.join(root, 'dist', 'host.js'))).toString('utf8')
    const imports = [...new Set([...text.matchAll(/^import\b.*?from\s*"([^"]+)"/gm)].map(match => match[1]))]
    expect(imports).toEqual(['node:http'])
    const module = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`) as Record<string, unknown>
    expect(Object.keys(module)).toEqual(['default'])
    expect((module.default as { kind: string }).kind).toBe('hetu-plugin')
  })

  // The page compiles hidden marks in itself. The install's copy is what its switch and its hash cover
  it('writes hidden-marks into the install as an in-page plugin: an install manifest with a page entry and the module bundled, with the hash of its files', async () => {
    const out = await outDir()
    await buildMain(out)
    const list = parseStrict(await readFile(path.join(out, INSTALL_LIST)), installList)
    const root = path.join(out, 'plugins', 'hidden-marks')
    expect(list.plugins['hidden-marks']).toEqual({ path: 'plugins/hidden-marks', version: '0.1.0', hash: hashFiles(await readFiles(root)) })
    expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/page.js', 'hetu-plugin.json'])
    const manifest = installManifest.parse(JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')))
    expect(manifest.entries).toEqual({ page: 'dist/page.js' })
    expect(await readFile(path.join(root, 'dist', 'page.js'), 'utf8')).toContain('hiddenMarks')
  })

  it('copies each page and bundles its script into dist/frontend, importing nothing', async () => {
    const out = await outDir()
    const built = await buildMain(out)
    for (const file of ['mount/index.html', 'mount/page.js', 'mount/shell.css', 'workers/index.html', 'workers/page.js']) {
      expect((await stat(path.join(out, 'frontend', file))).isFile(), file).toBe(true)
    }
    expect(built.pageImports).toEqual([])
  })

  it('bundles the utility bootstrap beside main.js as one module that imports nothing', async () => {
    const out = await outDir()
    const built = await buildMain(out)
    expect((await stat(path.join(out, 'utility.js'))).isFile()).toBe(true)
    expect(built.utilityImports).toEqual([])
    expect(await readFile(path.join(out, 'utility.js'), 'utf8')).toContain('data:text/javascript;base64,')
  })

  it('bundles the workers and window preloads as scripts whose only import is electron', async () => {
    const out = await outDir()
    const built = await buildMain(out)
    for (const file of ['workers-preload.js', 'mount-preload.js']) expect((await stat(path.join(out, file))).isFile(), file).toBe(true)
    expect(built.preloadImports).toEqual(['electron'])
  })

  it('puts the prelude in the worker host page\'s script, and the prelude removes each constructor that starts a global', async () => {
    const out = await outDir()
    const built = await buildMain(out)
    // Only the prelude names SharedWorker
    expect(await readFile(path.join(out, 'frontend', 'workers', 'page.js'), 'utf8')).toContain('SharedWorker')
    expect(built.prelude).not.toContain('frontend/workers')
    const scope: Record<string, unknown> = { Worker: class {}, SharedWorker: class {}, fetch: () => {} }
    vm.runInContext(built.prelude, vm.createContext(scope))
    expect(['Worker', 'SharedWorker'].filter(name => name in scope)).toEqual([])
    expect('fetch' in scope).toBe(true)
  })

  it.each([
    ['a const', 'const globalThis = {}'],
    ['a function', 'function globalThis() {}'],
    ['a let named self', 'let self = {}; let globalThis = self'],
  ])('keeps its removals when the plugin\'s own code declares %s at the top, in the same script', async (_name, declared) => {
    const out = await outDir()
    const built = await buildMain(out)
    const scope: Record<string, unknown> = { Worker: class {}, SharedWorker: class {} }
    const context = vm.createContext(scope)
    // One classic script, as the page builds it: the prelude, then the plugin's bytes
    vm.runInContext(`${built.prelude}\n${declared}\nvar seen = typeof Worker`, context)
    expect(scope.seen).toBe('undefined')
  })
})
