import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildMain } from './main.ts'

// The app's own package.json inside app.asar: what Electron reads to find main.js as an ES module, and the name and
// version the installer takes
export const STAGED_APP = Object.freeze({
  name: 'hetu',
  productName: 'hetu',
  version: '0.5.0',
  description: 'hetu',
  author: 'hetu',
  main: 'main.js',
  type: 'module',
})

// Builds what the package holds into a new empty folder: app/ becomes app.asar with main.js, the preloads, the pages
// and the install list, plugins/ sits beside it with each install plugin. Nothing comes from the repo or core/dist
// unbuilt, so no source, no node_modules and no plugin a build stopped writing can reach the install. locked is false
// only for the build the end-to-end tests drive from inside app.asar, which is never made into an installer
export async function stageInstall(stage: string, options: { locked: boolean }): Promise<void> {
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  const app = path.join(stage, 'app')
  await buildMain(app, { packaged: true, locked: options.locked })
  // The list names each plugin by plugins/<id> from the folder it is read from, which is beside app.asar
  await rename(path.join(app, 'plugins'), path.join(stage, 'plugins'))
  await writeFile(path.join(app, 'package.json'), `${JSON.stringify(STAGED_APP, null, 2)}\n`)
}
