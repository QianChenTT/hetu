import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build, type BuildOptions, type Metafile } from 'esbuild'
import { INSTALL_LIST, INSTALL_LIST_FORMAT } from '../api/install.ts'
import { hashFiles, readFiles } from '../lib/hash-files.ts'
import { buildHost } from '../sdk/build/esbuild.ts'
import { checkModuleImports } from './module-imports.ts'

// The core plugins built, each a host half from src/host.ts with the Node built-ins its manifest names, which runs in a
// utility process. The core modules are no plugins: main.ts imports them through wire.ts, so they are bundled into
// main.js
const INSTALL = ['mcp-http-handler']

const core = path.join(import.meta.dirname, '..')
const frontend = path.join(core, 'frontend')
// Electron 45's Node and Chromium
const NODE = 'node24.22'
const CHROMIUM = 'chrome156'
// The three fixed pages, each served from its folder in dist/frontend
const PAGES = ['editor', 'trusted', 'workers']

const exists = (file: string) => stat(file).then(() => true, () => false)

const shared: BuildOptions = { bundle: true, legalComments: 'none', charset: 'utf8', metafile: true, logLevel: 'silent' }

function external(metafile: Metafile | undefined): string[] {
  const found = Object.values(metafile?.outputs ?? {}).flatMap(output => output.imports)
    .filter(item => item.external).map(item => item.path)
  return [...new Set(found)].sort()
}

export type Built = {
  imports: string[]
  utilityImports: string[]
  pageImports: string[]
  preloadImports: string[]
  prelude: string
}

// main.ts and everything it imports as one ES module, electron left to the runtime, with the install list and the
// core plugins beside it. Each page's index.html and page.ts go to dist/frontend, the prelude put into the worker
// host page's script as text, and the workers preload to dist
// packaged and locked are fixed into main.js as the two constants of backend/runtime/packaged.ts. A run from the
// source has neither
export type BuildKind = { packaged?: boolean, locked?: boolean }

export async function buildMain(outDir: string = path.join(core, 'dist'), kind: BuildKind = {}): Promise<Built> {
  await mkdir(outDir, { recursive: true })
  const main = await build({
    ...shared,
    absWorkingDir: core,
    entryPoints: [path.join(core, 'backend', 'main.ts')],
    outfile: path.join(outDir, 'main.js'),
    platform: 'node',
    format: 'esm',
    target: NODE,
    external: ['electron'],
    define: { __HETU_PACKAGED__: String(kind.packaged === true), __HETU_LOCKED__: String(kind.locked === true) },
  })
  // Each core module bundled into main.js reaches only the Node built-ins on its own list, as each did when it was built as its own plugin
  const reached = await checkModuleImports(main.metafile!)
  if (reached.length > 0) throw new Error(`a core module reaches past its list:\n${reached.join('\n')}`)
  // The bootstrap each utility process runs, beside main.js: it imports a utility half's verified bytes and runs them on
  // the port main hands it
  const utility = await build({
    ...shared,
    entryPoints: [path.join(core, 'backend', 'runtime', 'utility-child.ts')],
    outfile: path.join(outDir, 'utility.js'),
    platform: 'node',
    format: 'esm',
    target: NODE,
  })
  // The core plugins, each built into dist/plugins/<id> and listed with the hash of its files, which the plugins manager checks
  // before it starts the host half in its utility process
  const plugins: Record<string, unknown> = {}
  // A plugin folder an older build wrote and this one doesn't, never listed and never read, goes
  const stale = await readdir(path.join(outDir, 'plugins')).catch(() => [])
  for (const name of stale) if (!INSTALL.includes(name)) await rm(path.join(outDir, 'plugins', name), { recursive: true, force: true })
  for (const id of INSTALL) {
    const source = path.join(core, '..', 'core-plugins', id)
    const root = path.join(outDir, 'plugins', id)
    await rm(root, { recursive: true, force: true })
    await mkdir(path.join(root, 'dist'), { recursive: true })
    const manifest = await readFile(path.join(source, 'hetu-plugin.json'))
    await writeFile(path.join(root, 'hetu-plugin.json'), manifest)
    const { version, node = [] } = JSON.parse(manifest.toString('utf8')) as { version: string, node?: string[] }
    const built = await buildHost(source, 'src/host.ts', node)
    await writeFile(path.join(root, 'dist', 'host.js'), built.text)
    plugins[id] = { path: `plugins/${id}`, version, hash: hashFiles(await readFiles(root)) }
  }
  const list = { format: INSTALL_LIST_FORMAT, plugins }
  await writeFile(path.join(outDir, INSTALL_LIST), `${JSON.stringify(list, null, 2)}\n`)

  // As written: a transform would turn its top-level this into undefined and make the plugin's code strict
  const prelude = await readFile(path.join(frontend, 'workers', 'prelude.js'), 'utf8')

  const pagesOut = path.join(outDir, 'frontend')
  await rm(pagesOut, { recursive: true, force: true })
  const pageImports: string[] = []
  for (const page of PAGES) {
    const from = path.join(frontend, page)
    const to = path.join(pagesOut, page)
    await mkdir(to, { recursive: true })
    // The page and its stylesheets as they are, its script bundled
    for (const name of await readdir(from)) {
      if (name.endsWith('.html') || name.endsWith('.css')) await copyFile(path.join(from, name), path.join(to, name))
    }
    if (!await exists(path.join(from, 'page.ts'))) continue
    const bundled = await build({
      ...shared,
      entryPoints: [path.join(from, 'page.ts')],
      outfile: path.join(to, 'page.js'),
      platform: 'browser',
      format: 'iife',
      target: CHROMIUM,
      define: { PRELUDE: JSON.stringify(prelude) },
    })
    pageImports.push(...external(bundled.metafile))
  }

  // The worker host page's preload and the window shell's, each beside main.js
  const preloadImports: string[] = []
  for (const page of ['workers', 'editor']) {
    const preload = await build({
      ...shared,
      entryPoints: [path.join(frontend, page, 'preload.ts')],
      outfile: path.join(outDir, `${page}-preload.js`),
      platform: 'browser',
      format: 'cjs',
      target: CHROMIUM,
      external: ['electron'],
    })
    preloadImports.push(...external(preload.metafile))
  }

  return { imports: external(main.metafile), utilityImports: external(utility.metafile), pageImports, preloadImports: [...new Set(preloadImports)].sort(), prelude }
}

if (import.meta.main) await buildMain()
