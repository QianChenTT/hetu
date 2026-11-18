import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build, type BuildOptions, type Metafile } from 'esbuild'
import { INSTALL_LIST, INSTALL_LIST_FORMAT } from '../api/install.ts'
import { hashFiles, readFiles } from '../lib/hash-files.ts'
import { buildHost, buildPlugin } from '../sdk/build/esbuild.ts'
import { communitySource } from './community.ts'

// The first-party plugins built, each a worker from src/worker.ts with where its source is: hetu's own plugins folder
// or the community package npm installed at the commit package.json pins
const FIRST_PARTY = { search: 'hetu', layout: 'hetu', 'file-explorer': 'community' } as const
// The install plugins built, each a host half from src/host.ts with the Node built-ins its manifest names
const INSTALL = ['gate', 'capabilities', 'storage', 'luoshu', 'history', 'exec', 'http']
// The in-page install plugins, each a module the editor page compiles in from core/frontend/mount. The install's copy
// holds its manifest and the module bundled on its own, which its hash and the human's switch cover. There is no
// loader path for in-page code
const PAGE = { 'hidden-marks': 'hidden-marks.ts' }

const core = path.join(import.meta.dirname, '..')
const repo = path.join(core, '..')
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
  utilityImports: string[]
  pageImports: string[]
  preloadImports: string[]
  prelude: string
}

// main.ts and everything it imports as one ES module, electron left to the runtime, with the install list, the
// install plugins and the first-party plugins beside it. Each page's index.html and page.ts go to dist/frontend, the prelude put into the worker
// host page's script as text, and the workers preload to dist
// packaged and locked are fixed into main.js as the two constants of backend/runtime/packaged.ts. A run from the
// source has neither
export type BuildKind = { packaged?: boolean, locked?: boolean }

// What a plugin from the community package may take into its bundle besides its own folder: hetu's SDK and API, which
// its imports of @hetu/sdk reach
const COMMUNITY_READS = [path.join(core, 'sdk'), path.join(core, 'api')]
// How esbuild names the module the SDK's build wraps a worker in: the namespace, then the path of the plugin's entry,
// absolute or relative to the plugin's folder
const WORKER_INPUT = 'hetu-worker:'

// The files a community plugin's bundle took in outside its own folder and hetu's SDK and API, each by its real path,
// and any input with no file behind it as esbuild names it. The pinned hash covers the plugin's folder and the
// package's package.json only, so a module esbuild resolves from anywhere else, a node_modules folder inside the
// package or hetu's own among them, is no file the pin holds
async function outsideReads(source: string, inputs: readonly string[]): Promise<string[]> {
  const allowed = await Promise.all([source, ...COMMUNITY_READS].map(folder => realpath(folder)))
  const outside: string[] = []
  for (const input of new Set(inputs)) {
    const file = path.resolve(source, input.startsWith(WORKER_INPUT) ? input.slice(WORKER_INPUT.length) : input)
    const real = await realpath(file).catch(() => undefined)
    if (real === undefined) outside.push(input)
    else if (!allowed.some(folder => real.startsWith(folder + path.sep))) outside.push(real)
  }
  return outside.sort()
}

// One first-party plugin written into root: its manifest copied and src/worker.ts bundled into dist/worker.js. A plugin
// from the community package is refused before anything of it is written when its bundle took in a file outside its
// own folder and hetu's SDK and API
export async function writeFirstParty(source: string, root: string, from: 'hetu' | 'community'): Promise<{ version: string }> {
  await rm(root, { recursive: true, force: true })
  const outputs = await buildPlugin(source, { entries: { 'dist/worker.js': 'src/worker.ts' }, workers: ['dist/worker.js'], write: false })
  if (from === 'community') {
    const outside = await outsideReads(source, outputs.flatMap(output => output.inputs))
    if (outside.length > 0) {
      throw new Error(`${path.basename(source)}'s bundle takes in files outside its folder and hetu's SDK and API:\n${outside.join('\n')}`)
    }
  }
  await mkdir(path.join(root, 'dist'), { recursive: true })
  const manifest = await readFile(path.join(source, 'hetu-plugin.json'))
  await writeFile(path.join(root, 'hetu-plugin.json'), manifest)
  for (const output of outputs) await writeFile(path.join(root, ...output.path.split('/')), output.text)
  return JSON.parse(manifest.toString('utf8')) as { version: string }
}

export async function buildMain(outDir: string = path.join(core, 'dist'), kind: BuildKind = {}): Promise<Built> {
  await mkdir(outDir, { recursive: true })
  const main = await build({
    ...shared,
    entryPoints: [path.join(core, 'backend', 'main.ts')],
    outfile: path.join(outDir, 'main.js'),
    platform: 'node',
    format: 'esm',
    target: NODE,
    external: ['electron'],
    define: { __HETU_PACKAGED__: String(kind.packaged === true), __HETU_LOCKED__: String(kind.locked === true) },
  })
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
  // The install plugins, each built into dist/plugins/<id> and listed with the hash of its files, which the loader checks
  // before it starts the host half
  const plugins: Record<string, unknown> = {}
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
  // The first-party plugins the install carries, each built the same way and listed as first-party, which the loader
  // copies into the plugin folder. A community plugin's manifest is copied and its source bundled with hetu's own SDK.
  // Nothing of the package is run and its hash is of what this build wrote, as every other plugin's is
  for (const [id, from] of Object.entries(FIRST_PARTY)) {
    const source = from === 'hetu' ? path.join(repo, 'core-plugins', id) : await communitySource(repo, id)
    const root = path.join(outDir, 'plugins', id)
    const { version } = await writeFirstParty(source, root, from)
    plugins[id] = { path: `plugins/${id}`, version, hash: hashFiles(await readFiles(root)), firstParty: true }
  }
  for (const [id, module] of Object.entries(PAGE)) {
    const source = path.join(core, '..', 'core-plugins', id)
    const root = path.join(outDir, 'plugins', id)
    await rm(root, { recursive: true, force: true })
    await mkdir(path.join(root, 'dist'), { recursive: true })
    const manifest = await readFile(path.join(source, 'hetu-plugin.json'))
    await writeFile(path.join(root, 'hetu-plugin.json'), manifest)
    // Its own code only: CodeMirror is the page's
    await build({
      ...shared,
      entryPoints: [path.join(frontend, 'mount', module)],
      outfile: path.join(root, 'dist', 'page.js'),
      platform: 'browser',
      format: 'esm',
      target: CHROMIUM,
      packages: 'external',
    })
    const { version } = JSON.parse(manifest.toString('utf8')) as { version: string }
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

  return { imports: external(main.metafile), utilityImports: external(utility.metafile), pageImports, preloadImports: [...new Set(preloadImports)].sort(), prelude }
}

if (import.meta.main) await buildMain()
