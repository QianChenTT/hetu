import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { INSTALL_LIST, INSTALL_LIST_FORMAT } from '../api/install.ts'

const core = path.join(import.meta.dirname, '..')
// Electron 45's Node
const TARGET = 'node24.22'

// main.ts and everything it imports as one ES module, electron left to the runtime. The install list beside it names
// the install plugins the runtime can start, none until host halves load
export async function buildMain(outDir: string = path.join(core, 'dist')): Promise<{ imports: string[] }> {
  await mkdir(outDir, { recursive: true })
  const result = await build({
    entryPoints: [path.join(core, 'backend', 'main.ts')],
    outfile: path.join(outDir, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: TARGET,
    external: ['electron'],
    legalComments: 'none',
    charset: 'utf8',
    metafile: true,
    logLevel: 'silent',
  })
  const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports)
    .filter(found => found.external).map(found => found.path)
  const list = { format: INSTALL_LIST_FORMAT, plugins: {} }
  await writeFile(path.join(outDir, INSTALL_LIST), `${JSON.stringify(list, null, 2)}\n`)
  return { imports: [...new Set(imports)].sort() }
}

if (import.meta.main) await buildMain()
