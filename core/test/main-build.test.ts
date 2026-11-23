import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { coreModuleIds } from '../api/ids.ts'
import { type BuildKind, buildMain, MAIN_BANNER, mainOptions } from '../build/main.ts'
import { checkModuleImports, moduleBuiltins, moduleFolders } from '../build/module-imports.ts'
import { DOOR_FILE } from '../backend/plugins-manager/verify.ts'
import { writeFolder } from './plugins-manager-fakes.ts'
import { makeZip } from './zip-maker.ts'

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
  // An ES module bundle reaches a CommonJS dependency's require of a Node built-in only through the banner's require.
  // Without it main throws as it loads and Electron shows its error dialog before any window
  // The options main.js is built with, its entry swapped for one that unpacks a zip, so a change to any of them that
  // breaks the CommonJS reader fails here
  it('loads the CommonJS zip reader with the options main is bundled with and unpacks a zip with it, in a Node of its own', async () => {
    const out = await outDir()
    const file = path.join(out, 'unpack.mjs')
    const zip = path.join(out, 'one.zip')
    await writeFile(zip, makeZip([{ name: 'hetu-plugin.json', data: '{}' }]))
    const { entryPoints, ...options } = mainOptions(file)
    expect(entryPoints).toEqual([path.join(repo, 'core', 'backend', 'main.ts')])
    await build({
      ...options,
      stdin: {
        contents: 'import { readFile } from "node:fs/promises"\nimport { unpackZip } from "./backend/plugins-manager/unpack.ts"\n'
          + 'console.log(JSON.stringify(await unpackZip(await readFile(process.argv[2]), process.argv[3])))',
        resolveDir: path.join(repo, 'core'), loader: 'ts',
      },
    })
    const into = path.join(out, 'into')
    await mkdir(into)
    // A plain Node, not the test runner's module loader, which hands every module a require of its own
    const ran = spawnSync(process.execPath, [file, zip, into], { encoding: 'utf8' })
    expect(ran.stderr).toBe('')
    expect(JSON.parse(ran.stdout)).toEqual({ problem: null, leftovers: false })
    expect(await readFile(path.join(into, 'hetu-plugin.json'), 'utf8')).toBe('{}')
    const main = await outDir()
    await buildMain(main)
    const bundled = await readFile(path.join(main, 'main.js'), 'utf8')
    expect(bundled.startsWith(MAIN_BANNER)).toBe(true)
    // The reader is in main.js itself, reached through the banner's require and never an import left for the runtime
    expect(bundled).toContain('node_modules/yauzl/index.js')
  })

  it('bundles main.ts into one module that imports only electron and Node built-ins', async () => {
    const out = await outDir()
    const built = await buildMain(out)
    expect(built.imports).toContain('electron')
    expect(built.imports.filter(name => name !== 'electron' && !isBuiltin(name))).toEqual([])
    expect(await readFile(path.join(out, 'main.js'), 'utf8')).toMatch(/from ["']electron["']/)
  })

  it('writes the door beside main.js and no install list or plugins folder', async () => {
    const out = await outDir()
    await buildMain(out)
    expect((await stat(path.join(out, DOOR_FILE))).isFile()).toBe(true)
    await expect(stat(path.join(out, 'hetu-install.json'))).rejects.toThrow('ENOENT')
    await expect(stat(path.join(out, 'plugins'))).rejects.toThrow('ENOENT')
  })

  // An output folder an older build wrote to still holds its install list and core plugins, which nothing reads
  it('removes the install list and the plugins folder an older build left in the output', async () => {
    const out = await outDir()
    for (const id of ['mcp-http-handler', 'layout']) await writeFolder(path.join(out, 'plugins', id), { 'hetu-plugin.json': '{}', 'dist/host.js': '' })
    await writeFile(path.join(out, 'hetu-install.json'), '{"format":1,"plugins":{}}\n')
    await buildMain(out)
    expect((await stat(path.join(out, DOOR_FILE))).isFile()).toBe(true)
    await expect(stat(path.join(out, 'hetu-install.json'))).rejects.toThrow('ENOENT')
    await expect(stat(path.join(out, 'plugins'))).rejects.toThrow('ENOENT')
  })

  // The build takes source only from this repository, so nothing outside it can name another folder for it
  it('reads no environment variable and no argument in the module that picks where a plugin is built from', async () => {
    const text = await readFile(path.join(repo, 'core', 'build', 'main.ts'), 'utf8')
    expect(text).not.toMatch(/process\s*\.\s*(env|argv)|['"](node:)?process['"]|import\.meta\.env|\bgetenv\b/)
    // Its caller names an output folder and the build's kind, never a source. The typecheck holds both
    const kindNamesNoSource: Exactly<keyof BuildKind, 'packaged' | 'locked'> = true
    const takesTwo: Exactly<Parameters<typeof buildMain>, [outDir?: string, kind?: BuildKind]> = true
    expect([kindNamesNoSource, takesTwo]).toEqual([true, true])
  })

  it('writes none of the core modules beside main.js, main.js holding each of them', async () => {
    const out = await outDir()
    await buildMain(out)
    for (const id of coreModuleIds) await expect(stat(path.join(out, 'plugins', id))).rejects.toThrow('ENOENT')
    const main = await readFile(path.join(out, 'main.js'), 'utf8')
    for (const make of ['createGate', 'createGrantRiskClassifier', 'createStorage', 'createLuoshu', 'createHistory', 'createExec']) {
      expect(main, make).toContain(`function ${make}(`)
    }
  })

  // The door runs in a utility process, so it holds no provider and no role and its module is the plugin alone
  it('writes the door as one module that imports only the built-ins core/api names for it and exports the plugin alone', async () => {
    const out = await outDir()
    await buildMain(out)
    const text = (await readFile(path.join(out, DOOR_FILE))).toString('utf8')
    const imports = [...new Set([...text.matchAll(/^import\b.*?from\s*"([^"]+)"/gm)].map(match => match[1]))]
    expect(imports.sort()).toEqual(['node:fs/promises', 'node:http', 'node:net', 'node:os'])
    const module = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`) as Record<string, unknown>
    expect(Object.keys(module)).toEqual(['default'])
    expect((module.default as { kind: string }).kind).toBe('hetu-plugin')
  })

  it('copies each page and bundles its script into dist/frontend, importing nothing', async () => {
    const out = await outDir()
    const built = await buildMain(out)
    for (const file of ['editor/index.html', 'editor/page.js', 'editor/shell.css', 'workers/index.html', 'workers/page.js']) {
      expect((await stat(path.join(out, 'frontend', file))).isFile(), file).toBe(true)
    }
    expect(built.pageImports).toEqual([])
  })

  // Hidden marks runs as a worker behind the editor bridge, so the page parses notes and holds no plugin's code
  it('bundles the editor page with the markdown language and without hidden marks', async () => {
    const out = await outDir()
    await buildMain(out)
    const page = await readFile(path.join(out, 'frontend', 'editor', 'page.js'), 'utf8')
    expect(page).toContain('HighlightMark')
    expect(page).not.toContain('hiddenMarks')
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
    for (const file of ['workers-preload.js', 'editor-preload.js']) expect((await stat(path.join(out, file))).isFile(), file).toBe(true)
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

describe('each core module\'s Node built-ins', () => {
  // A tree shaped as core/ with every module folder holding one file, each importing what files says
  async function bundled(files: Record<string, string>) {
    const root = await outDir()
    const entry = coreModuleIds.map((id, i) => `export * as m${i} from './${moduleFolders[id]}/index.ts'`).join('\n')
    await writeFolder(root, {
      ...Object.fromEntries(coreModuleIds.map(id => [`${moduleFolders[id]}/index.ts`, 'export const x = 1\n'])), ...files, 'main.ts': `${entry}\n`,
    })
    const result = await build({
      absWorkingDir: root, entryPoints: [path.join(root, 'main.ts')], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true,
      logLevel: 'silent', external: ['electron'],
    })
    return checkModuleImports(result.metafile, undefined, root)
  }

  it('holds each module to its own list: the gate and the classifier none, storage crypto, fs/promises and path', () => {
    expect(moduleBuiltins).toEqual({
      gate: [],
      'grant-risk-classifier': [],
      storage: ['node:crypto', 'node:fs/promises', 'node:path'],
      luoshu: ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path'],
      history: ['node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:path'],
      exec: ['node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:url'],
      'flood-control': [],
      heartbeat: [],
      recording: [],
      'security-view': [],
      lock: ['node:crypto', 'node:fs/promises', 'node:path'],
    })
    expect(Object.keys(moduleFolders).sort()).toEqual([...coreModuleIds].sort())
  })

  it('passes hetu\'s own modules as main.ts bundles them', async () => {
    const root = path.join(import.meta.dirname, '..')
    const result = await build({
      absWorkingDir: root, entryPoints: [path.join(root, 'backend', 'main.ts')], bundle: true, platform: 'node', format: 'esm', write: false,
      metafile: true, logLevel: 'silent', external: ['electron'], define: { __HETU_PACKAGED__: 'false', __HETU_LOCKED__: 'false' },
    })
    expect(await checkModuleImports(result.metafile)).toEqual([])
  })

  it('refuses a built-in off a module\'s list, named or not with node:', async () => {
    expect(await bundled({
      'backend/policy/gate/index.ts': 'import { connect } from \'node:net\'\nexport const x = connect\n',
      'backend/providers/storage/index.ts': 'import { spawn } from \'child_process\'\nexport const x = spawn\n',
    })).toEqual([
      'gate: node:net isn\'t on its list, from backend/policy/gate/index.ts',
      'storage: child_process isn\'t on its list, from backend/providers/storage/index.ts',
    ])
  })

  it('refuses a built-in a module reaches through a file of hetu\'s own it imports', async () => {
    expect(await bundled({
      'lib/spawn.ts': 'import { spawn } from \'node:child_process\'\nexport const run = spawn\n',
      'backend/providers/luoshu/index.ts': 'import { run } from \'../../../lib/spawn.ts\'\nexport const x = run\n',
    })).toEqual(['luoshu: node:child_process isn\'t on its list, from lib/spawn.ts'])
  })

  it('refuses electron and anything else left to load at run time', async () => {
    expect(await bundled({
      'backend/policy/grant-risk-classifier/index.ts': 'import { app } from \'electron\'\nexport const x = app\n',
    })).toEqual(['grant-risk-classifier: electron would load at run time, from backend/policy/grant-risk-classifier/index.ts'])
  })

  it('refuses the plain ways past an import in the files a module takes in', async () => {
    const found = await bundled({
      'backend/providers/history/index.ts': 'export const x = process.getBuiltinModule(\'node:net\')\n',
    })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/^history: \d+:\d+ getBuiltinModule in backend\/providers\/history\/index\.ts, past its list$/)
  })

  it('refuses a module folder with no file in the bundle', async () => {
    const root = await outDir()
    await writeFolder(root, { 'main.ts': 'export const x = 1\n' })
    const result = await build({ absWorkingDir: root, entryPoints: [path.join(root, 'main.ts')], bundle: true, write: false, metafile: true, logLevel: 'silent' })
    expect(await checkModuleImports(result.metafile, undefined, root)).toContain('gate: no file under backend/policy/gate in the bundle')
  })
})
