import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build, type BuildOptions, type Metafile } from 'esbuild'
import { doorNode } from '../api/ids.ts'
import { DOOR_FILE } from '../backend/plugins-manager/verify.ts'
import { buildHost } from '../sdk/build/esbuild.ts'
import { checkModuleImports } from './module-imports.ts'
import { type Bundled, bundledPackages, NOTICES_FILE, noticesText } from './notices.ts'

// What an older build wrote beside main.js and this one doesn't: the install list and the core plugins' folders
const RETIRED = ['hetu-install.json', 'plugins']

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

// A require for main's ES module bundle: yauzl is CommonJS and requires Node's built-ins, which esbuild's shim in an ES
// module reaches only through a require declared at the top. It is bound to main.js's own URL, so it resolves only what
// an import in main.js could already reach. checkModuleImports reads the metafile, which can't see a require(variable)
// made at run time, so none is written in core code
export const MAIN_BANNER = 'import { createRequire as hetuRequire } from \'node:module\'\nconst require = hetuRequire(import.meta.url)'

export type Built = {
  imports: string[]
  utilityImports: string[]
  pageImports: string[]
  preloadImports: string[]
  prelude: string
}

// main.ts and everything it imports as one ES module, electron left to the runtime, with the utility bootstrap and the
// door beside it. Each page's index.html and page.ts go to dist/frontend, the prelude put into the worker
// host page's script as text, and the workers preload to dist
// packaged and locked are fixed into main.js as the two constants of backend/runtime/packaged.ts. A run from the
// source has neither
export type BuildKind = { packaged?: boolean, locked?: boolean }

// How main.ts is bundled, each option the build of main.js takes, which a test builds other code with to see it load
export function mainOptions(outfile: string, kind: BuildKind = {}): BuildOptions {
  return {
    ...shared,
    absWorkingDir: core,
    entryPoints: [path.join(core, 'backend', 'main.ts')],
    outfile,
    platform: 'node',
    format: 'esm',
    target: NODE,
    external: ['electron'],
    define: { __HETU_PACKAGED__: String(kind.packaged === true), __HETU_LOCKED__: String(kind.locked === true) },
    banner: { js: MAIN_BANNER },
  }
}

export async function buildMain(outDir: string = path.join(core, 'dist'), kind: BuildKind = {}): Promise<Built> {
  await mkdir(outDir, { recursive: true })
  const main = await build(mainOptions(path.join(outDir, 'main.js'), kind))
  // Each bundle's inputs with the folder esbuild read their paths from, for the notices file. The door imports only Node's
  // built-ins, which checkHostImports holds it to
  const bundles: Bundled[] = [{ metafile: main.metafile!, from: core }]
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
  bundles.push({ metafile: utility.metafile!, from: process.cwd() })
  // The door, beside main.js and inside app.asar with it, importing only the Node built-ins core/api names for it. The
  // plugins manager reads it once and starts it in a utility process of its own through the bootstrap
  const door = await buildHost(core, 'backend/door/host.ts', doorNode)
  await writeFile(path.join(outDir, DOOR_FILE), door.text)
  for (const name of RETIRED) await rm(path.join(outDir, name), { recursive: true, force: true })

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
    bundles.push({ metafile: bundled.metafile!, from: process.cwd() })
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
    bundles.push({ metafile: preload.metafile!, from: process.cwd() })
  }
  await writeFile(path.join(outDir, NOTICES_FILE), noticesText(await bundledPackages(bundles)))

  return { imports: external(main.metafile), utilityImports: external(utility.metafile), pageImports, preloadImports: [...new Set(preloadImports)].sort(), prelude }
}

if (import.meta.main) await buildMain()
