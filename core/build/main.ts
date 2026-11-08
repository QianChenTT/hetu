import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build, type BuildOptions, type Metafile } from 'esbuild'
import { INSTALL_LIST, INSTALL_LIST_FORMAT } from '../api/install.ts'
import { hashFiles, readFiles } from '../lib/hash-files.ts'
import { buildHost, buildPlugin } from '../sdk/build/esbuild.ts'

// The first-party plugins built, each a worker from src/worker.ts
const FIRST_PARTY = ['search']
// The install plugins built, each a host half from src/host.ts with the Node built-ins its manifest names
const INSTALL = ['log', 'gate']

const core = path.join(import.meta.dirname, '..')
const frontend = path.join(core, 'frontend')
// Electron 45's Node and Chromium
const NODE = 'node24.22'
const CHROMIUM = 'chrome156'
// The three fixed pages, each served from its folder in dist/frontend
const PAGES = ['mount', 'trusted', 'workers']

const exists = (file: string) => stat(file).then(() => true, () => false)

const shared: BuildOptions = { bundle: true, legalComments: 'none', charset: 'utf8', metafile: true, logLevel: 'silent' }

function external(metafile: Metafile | undefined): string[] {
  const found = Object.values(metafile?.outputs ?? {}).flatMap(output => output.imports)
    .filter(item => item.external).map(item => item.path)
  return [...new Set(found)].sort()
}

export type Built = {
  imports: string[]
  pageImports: string[]
  preloadImports: string[]
  prelude: string
}

// main.ts and everything it imports as one ES module, electron left to the runtime, with the install list, the
// install plugins and the first-party plugins beside it. Each page's index.html and page.ts go to dist/frontend, the prelude put into the worker
// host page's script as text, and the workers preload to dist
export async function buildMain(outDir: string = path.join(core, 'dist')): Promise<Built> {
  await mkdir(outDir, { recursive: true })
  const main = await build({
    ...shared,
    entryPoints: [path.join(core, 'backend', 'main.ts')],
    outfile: path.join(outDir, 'main.js'),
    platform: 'node',
    format: 'esm',
    target: NODE,
    external: ['electron'],
  })
  // The install plugins, each built into dist/plugins/<id> and listed with the hash of its files, which the loader checks
  // before it starts the host half
  const plugins: Record<string, unknown> = {}
  for (const id of INSTALL) {
    const source = path.join(core, '..', 'plugins', id)
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
  // The first-party plugins the install carries, each built the same way and listed as first-party, which the loader
  // copies into the plugin folder. search waits for the luoshu until the luoshu is built
  for (const id of FIRST_PARTY) {
    const source = path.join(core, '..', 'plugins', id)
    const root = path.join(outDir, 'plugins', id)
    await rm(root, { recursive: true, force: true })
    await mkdir(path.join(root, 'dist'), { recursive: true })
    const manifest = await readFile(path.join(source, 'hetu-plugin.json'))
    await writeFile(path.join(root, 'hetu-plugin.json'), manifest)
    const outputs = await buildPlugin(source, { entries: { 'dist/worker.js': 'src/worker.ts' }, workers: ['dist/worker.js'], write: false })
    for (const output of outputs) await writeFile(path.join(root, ...output.path.split('/')), output.text)
    const { version } = JSON.parse(manifest.toString('utf8')) as { version: string }
    plugins[id] = { path: `plugins/${id}`, version, hash: hashFiles(await readFiles(root)), firstParty: true }
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
  for (const page of ['workers', 'mount']) {
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

  return { imports: external(main.metafile), pageImports, preloadImports: [...new Set(preloadImports)].sort(), prelude }
}

if (import.meta.main) await buildMain()
