import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_LIST, installList } from '../api/install.ts'
import { buildMain } from '../build/main.ts'
import { hashFiles, readFiles } from '../lib/hash-files.ts'
import { parseStrict } from '../lib/hashed-file.ts'
import { checkManifest } from '../sdk/build/check-manifest.ts'

const made: string[] = []

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
    expect(Object.keys(list.plugins).sort()).toEqual(['gate', 'luoshu', 'search', 'storage'])
    expect(list.plugins.search).toEqual({ path: 'plugins/search', version: '0.1.0', hash: hashFiles(await readFiles(root)), firstParty: true })
    expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/worker.js', 'hetu-plugin.json'])
  })

  it('writes the gate into the install as a host half, one module importing nothing, with the hash of its files', async () => {
    const out = await outDir()
    await buildMain(out)
    const list = parseStrict(await readFile(path.join(out, INSTALL_LIST)), installList)
    for (const [id, role] of [['gate', 'gate']]) {
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

  it('copies each page and bundles its script into dist/frontend, importing nothing', async () => {
    const out = await outDir()
    const built = await buildMain(out)
    for (const file of ['mount/index.html', 'mount/page.js', 'mount/shell.css', 'workers/index.html', 'workers/page.js']) {
      expect((await stat(path.join(out, 'frontend', file))).isFile(), file).toBe(true)
    }
    expect(built.pageImports).toEqual([])
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
