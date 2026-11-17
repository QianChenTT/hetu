import { mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INSTALL_LIST, installList } from '../api/install.ts'
import { installManifest } from '../api/manifest.ts'
import { type BuildKind, buildMain, writeFirstParty } from '../build/main.ts'
import { hashFiles, readFiles } from '../lib/hash-files.ts'
import { parseStrict } from '../lib/hashed-file.ts'
import { checkManifest } from '../sdk/build/check-manifest.ts'
import { buildPlugin } from '../sdk/build/esbuild.ts'
import { writeFolder } from './loader-fakes.ts'

// The SDK's build as it is. Two tests change the inputs it reports, for a bundle esbuild doesn't make today
vi.mock('../sdk/build/esbuild.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../sdk/build/esbuild.ts')>()
  return { ...actual, buildPlugin: vi.fn(actual.buildPlugin) }
})

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
  })

  it('refuses the file explorer, writing none of it, when its bundle took in a file outside its folder and hetu\'s SDK and API', async () => {
    const actual = await vi.importActual<typeof import('../sdk/build/esbuild.ts')>('../sdk/build/esbuild.ts')
    const elsewhere = path.join(repo, 'node_modules', 'acorn', 'dist', 'acorn.mjs')
    // A module with no file behind it, as esbuild names one of a namespace
    const virtual = 'virtual:evil.ts'
    vi.mocked(buildPlugin).mockImplementation(async (root, options) => {
      const outputs = await actual.buildPlugin(root, options)
      return path.basename(root) === 'file-explorer' ? outputs.map(output => ({ ...output, inputs: [...output.inputs, elsewhere, virtual] })) : outputs
    })
    try {
      const out = await outDir()
      await expect(buildMain(out)).rejects.toThrow(`file-explorer's bundle takes in files outside its folder and hetu's SDK and API:\n${[await realpath(elsewhere), virtual].sort().join('\n')}`)
      await expect(stat(path.join(out, 'plugins', 'file-explorer'))).rejects.toThrow('ENOENT')
      expect((await stat(path.join(out, 'plugins', 'search', 'dist', 'worker.js'))).isFile()).toBe(true)
    } finally {
      vi.mocked(buildPlugin).mockImplementation(actual.buildPlugin)
    }
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

// A community package as npm installs it, under node_modules in a folder of its own, with one plugin whose worker is
// the text given. The SDK is reached by its path in this checkout, as the bundle reaches it through @hetu/sdk
const sdk = JSON.stringify(path.join(repo, 'core', 'sdk', 'index.ts').split(path.sep).join('/'))

async function communityPlugin(worker: string, files: Record<string, string> = {}, under = ''): Promise<{ base: string, pkg: string, source: string, root: string }> {
  const base = await outDir()
  const pkg = path.join(base, under, 'node_modules', 'hetu-plugins')
  await writeFolder(pkg, {
    'package.json': JSON.stringify({ name: 'hetu-plugins', private: true }),
    'file-explorer/hetu-plugin.json': JSON.stringify({ id: 'file-explorer', version: '0.1.0' }),
    'file-explorer/src/worker.ts': worker,
    ...files,
  })
  return { base, pkg, source: path.join(pkg, 'file-explorer'), root: path.join(base, 'out', 'plugins', 'file-explorer') }
}

const nothingWritten = (root: string) => expect(stat(root)).rejects.toThrow('ENOENT')

describe('a first-party plugin built from the community package', () => {
  it('is written when its bundle takes in only its own folder and hetu\'s SDK and API', async () => {
    const { source, root } = await communityPlugin(`import { definePlugin } from ${sdk}\nimport { more } from './more.ts'\nexport default definePlugin({ more })\n`, {
      'file-explorer/src/more.ts': 'export const more = 1\n',
    })
    await writeFirstParty(source, root, 'community')
    expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/worker.js', 'hetu-plugin.json'])
    const [built] = await buildPlugin(source, { entries: { 'dist/worker.js': 'src/worker.ts' }, workers: ['dist/worker.js'], write: false })
    expect(await readFile(path.join(root, 'dist', 'worker.js'), 'utf8')).toBe(built!.text)
  })

  // npm installs nothing inside the package. A node_modules folder there is resolved before hetu's own and is no file
  // the pinned hash covers
  it('is refused, with nothing written, when a node_modules folder inside the package puts a module in place of the SDK', async () => {
    const { pkg, source, root } = await communityPlugin('import { definePlugin } from \'@hetu/sdk\'\nexport default definePlugin({})\n', {
      'node_modules/@hetu/sdk/package.json': JSON.stringify({ name: '@hetu/sdk', type: 'module', main: 'index.js' }),
      'node_modules/@hetu/sdk/index.js': 'export const definePlugin = plugin => plugin\n',
    })
    const planted = await realpath(path.join(pkg, 'node_modules', '@hetu', 'sdk', 'index.js'))
    await expect(writeFirstParty(source, root, 'community')).rejects.toThrow(planted)
    await nothingWritten(root)
  })

  // A folder beside it whose name starts with the plugin's is outside it too
  it('is refused when its worker climbs out of its folder by a relative path to files beside it', async () => {
    const { pkg, source, root } = await communityPlugin('import { beside } from \'../../beside.ts\'\nimport { more } from \'../../file-explorer-more/more.ts\'\nexport default { beside, more }\n', {
      'beside.ts': 'export const beside = 1\n',
      'file-explorer-more/more.ts': 'export const more = 1\n',
    })
    const refused = await writeFirstParty(source, root, 'community').then(() => undefined, (error: unknown) => String(error))
    expect(refused).toContain(await realpath(path.join(pkg, 'beside.ts')))
    expect(refused).toContain(await realpath(path.join(pkg, 'file-explorer-more', 'more.ts')))
    await nothingWritten(root)
  })

  it('is refused when a link inside its folder leads out of it', async () => {
    const { source, root } = await communityPlugin('import { away } from \'./away/away.ts\'\nexport default { away }\n')
    const elsewhere = await outDir()
    await writeFolder(elsewhere, { 'away.ts': 'export const away = 1\n' })
    const link = path.join(source, 'src', 'away')
    await symlink(elsewhere, link, 'junction')
    try {
      await expect(writeFirstParty(source, root, 'community')).rejects.toThrow(await realpath(path.join(elsewhere, 'away.ts')))
      await nothingWritten(root)
    } finally {
      await rm(link)
    }
  })

  // esbuild names a file it reached through a link by its real path today. The check holds without that: a file named
  // inside the folder by a link's spelling is taken at its real path
  it('is refused when its bundle names a file inside its folder whose real path is outside it', async () => {
    const { source, root } = await communityPlugin('import { away } from \'./away/away.ts\'\nexport default { away }\n')
    const elsewhere = await outDir()
    await writeFolder(elsewhere, { 'away.ts': 'export const away = 1\n' })
    const link = path.join(source, 'src', 'away')
    await symlink(elsewhere, link, 'junction')
    const actual = await vi.importActual<typeof import('../sdk/build/esbuild.ts')>('../sdk/build/esbuild.ts')
    const real = await realpath(path.join(elsewhere, 'away.ts'))
    vi.mocked(buildPlugin).mockImplementationOnce(async (from, options) => (await actual.buildPlugin(from, options))
      .map(output => ({ ...output, inputs: output.inputs.map(input => (path.resolve(from, input) === real ? 'src/away/away.ts' : input)) })))
    try {
      await expect(writeFirstParty(source, root, 'community')).rejects.toThrow(real)
      await nothingWritten(root)
    } finally {
      await rm(link)
    }
  })

  // The honest build takes nothing from hetu's node_modules but the package itself: @hetu/sdk links to core/sdk
  it('is refused when it takes in a file of hetu\'s own node_modules that is neither the SDK nor the API', async () => {
    const own = path.join(repo, 'node_modules', 'acorn', 'dist', 'acorn.mjs')
    const { source, root } = await communityPlugin(`import { version } from ${JSON.stringify(own.split(path.sep).join('/'))}\nexport default { version }\n`)
    await expect(writeFirstParty(source, root, 'community')).rejects.toThrow(await realpath(own))
    await nothingWritten(root)
  })

  // The wrapper's input names the plugin's entry, by its absolute path today or relative to the plugin's folder
  it('is written when the worker wrapper names the entry relative to the plugin\'s folder', async () => {
    const { source, root } = await communityPlugin(`import { definePlugin } from ${sdk}\nexport default definePlugin({})\n`)
    const actual = await vi.importActual<typeof import('../sdk/build/esbuild.ts')>('../sdk/build/esbuild.ts')
    vi.mocked(buildPlugin).mockImplementationOnce(async (from, options) => (await actual.buildPlugin(from, options))
      .map(output => ({ ...output, inputs: output.inputs.map(input => (input.startsWith('hetu-worker:') ? 'hetu-worker:src/worker.ts' : input)) })))
    await writeFirstParty(source, root, 'community')
    expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/worker.js', 'hetu-plugin.json'])
  })

  // esbuild keeps the spelling of a link above the folder it builds in, so both sides are compared by real path
  it('is written when the path to the package passes through a link, its files compared by real path', async () => {
    const { base, source: real, root } = await communityPlugin(`import { definePlugin } from ${sdk}\nexport default definePlugin({})\n`, {}, 'real')
    const via = path.join(base, 'via')
    await symlink(path.join(base, 'real'), via, 'junction')
    try {
      await writeFirstParty(path.join(via, path.relative(path.join(base, 'real'), real)), root, 'community')
      expect((await readFiles(root)).map(file => file.path).sort()).toEqual(['dist/worker.js', 'hetu-plugin.json'])
    } finally {
      await rm(via)
    }
  })
})
