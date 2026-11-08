import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build, type BuildOptions, type Metafile } from 'esbuild'
import { INSTALL_LIST, INSTALL_LIST_FORMAT } from '../api/install.ts'

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

// main.ts and everything it imports as one ES module, electron left to the runtime. The install list beside it names
// the install plugins the runtime can start, none until host halves load. Each page's index.html and page.ts go to
// dist/frontend, the prelude put into the worker host page's script as text, and the workers preload to dist
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
  const list = { format: INSTALL_LIST_FORMAT, plugins: {} }
  await writeFile(path.join(outDir, INSTALL_LIST), `${JSON.stringify(list, null, 2)}\n`)

  // Not bundled, since it imports nothing, which also keeps esbuild's source path comment out of every worker
  const preludeBuild = await build({
    ...shared,
    bundle: false,
    entryPoints: [path.join(frontend, 'workers', 'prelude.ts')],
    write: false,
    platform: 'browser',
    format: 'iife',
    target: CHROMIUM,
  })
  const prelude = preludeBuild.outputFiles[0].text

  const pagesOut = path.join(outDir, 'frontend')
  await rm(pagesOut, { recursive: true, force: true })
  const pageImports: string[] = []
  for (const page of PAGES) {
    const from = path.join(frontend, page)
    const to = path.join(pagesOut, page)
    await mkdir(to, { recursive: true })
    if (await exists(path.join(from, 'index.html'))) await copyFile(path.join(from, 'index.html'), path.join(to, 'index.html'))
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

  const preload = await build({
    ...shared,
    entryPoints: [path.join(frontend, 'workers', 'preload.ts')],
    outfile: path.join(outDir, 'workers-preload.js'),
    platform: 'browser',
    format: 'cjs',
    target: CHROMIUM,
    external: ['electron'],
  })

  return { imports: external(main.metafile), pageImports, preloadImports: external(preload.metafile), prelude }
}

if (import.meta.main) await buildMain()
