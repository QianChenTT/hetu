import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { checkManifest } from '@hetu/sdk/check-manifest'
import { buildHost } from '@hetu/sdk/esbuild'

// Builds the host half with the Node built-ins its manifest names, then checks the manifest as an install one against
// what was built
const root = import.meta.dirname
const { node = [] } = JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')) as { node?: string[] }
const built = await buildHost(root, 'src/host.ts', node)
await mkdir(path.join(root, 'dist'), { recursive: true })
await writeFile(path.join(root, 'dist', 'host.js'), built.text)
console.log(`dist/host.js: ${Buffer.byteLength(built.text)} bytes`)
const problems = await checkManifest(root, { install: true, built: true })
for (const problem of problems) console.error(problem)
process.exitCode = problems.length === 0 ? 0 : 1
