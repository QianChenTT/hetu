import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { hashFiles, readFiles } from '../lib/hash-files.ts'

// The community repository hetu's build takes first-party plugins from. npm fetches it from GitHub at the one commit
// package.json names and installs it in node_modules under its package name
export const COMMUNITY_PACKAGE = 'hetu-plugins'

// The commit the build takes the package at and, for each plugin built from it, the hash of the files the build may
// read there at that commit: the package's package.json and the plugin's folder. npm checks no integrity for a git
// dependency, so this hash is what holds the files to the commit. A new commit moves both here, in package.json and in
// the lock in one change
export type Pin = { commit: string, files: Readonly<Record<string, string>> }
export const PIN: Pin = Object.freeze({
  commit: '1169fd132a3e4870933f80fa21bdb5bc241905c3',
  files: Object.freeze({ 'file-explorer': 'b6525ede3787992f6a2e3ae63adbe04589b442426f18f8c2b3cedc13a43ed077' }),
})

// The scripts npm runs for a git dependency when its install doesn't skip scripts
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare', 'prepack', 'postpack']
const REPOSITORY = 'QianChenTT/hetu-plugins'
const SPEC = `github:${REPOSITORY}#`
const FULL_COMMIT = /^[0-9a-f]{40}$/
// What npm writes into the lock for a github: address, whatever way it fetched the commit
const resolvedAt = (commit: string) => `git+ssh://git@github.com/${REPOSITORY}.git#${commit}`

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

// The commit package.json pins the community package at, held to package-lock.json. npm ci follows package.json for a
// git dependency and checks no integrity for one, so the two must name the same full commit or the lock pins nothing.
// It is a dev dependency only, so nothing of it is packed into the app. It brings no package, install script or command
// of its own. Throws a plain message naming what to fix
export function pinnedCommit(manifest: unknown, lock: unknown): string {
  const ownManifest = record(manifest)
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (COMMUNITY_PACKAGE in record(ownManifest[field])) {
      throw new Error(`package.json names ${COMMUNITY_PACKAGE} in ${field}, where only devDependencies may name it`)
    }
  }
  const spec = record(ownManifest.devDependencies)[COMMUNITY_PACKAGE]
  if (typeof spec !== 'string') throw new Error(`package.json names no ${COMMUNITY_PACKAGE} in devDependencies`)
  if (!spec.startsWith(SPEC)) throw new Error(`package.json names ${COMMUNITY_PACKAGE} as ${spec}, not as ${SPEC}<commit>`)
  const commit = spec.slice(SPEC.length)
  if (!FULL_COMMIT.test(commit)) {
    throw new Error(`package.json names ${COMMUNITY_PACKAGE} at ${commit}, not at a full 40-character commit in lowercase`)
  }
  const packages = record(record(lock).packages)
  const rootSpec = record(record(packages['']).devDependencies)[COMMUNITY_PACKAGE]
  if (rootSpec !== spec) throw new Error(`package-lock.json was made for ${String(rootSpec)}, package.json names ${spec}. Run npm install --ignore-scripts`)
  const installed = packages[`node_modules/${COMMUNITY_PACKAGE}`]
  if (installed === undefined) throw new Error(`package-lock.json holds no node_modules/${COMMUNITY_PACKAGE}. Run npm install --ignore-scripts`)
  const entry = record(installed)
  if (entry.resolved !== resolvedAt(commit)) {
    throw new Error(`package-lock.json installs ${COMMUNITY_PACKAGE} from ${String(entry.resolved)}, package.json names ${commit}`)
  }
  if (entry.dev !== true) throw new Error(`package-lock.json installs ${COMMUNITY_PACKAGE} as a production package, not as dev`)
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'hasInstallScript', 'bin']) {
    if (field in entry) throw new Error(`package-lock.json gives ${COMMUNITY_PACKAGE} ${field}, which it may not have`)
  }
  const nested = Object.keys(packages).find(key => key.startsWith(`node_modules/${COMMUNITY_PACKAGE}/`))
  if (nested !== undefined) throw new Error(`package-lock.json installs ${nested} inside ${COMMUNITY_PACKAGE}, which brings no package`)
  return commit
}

// The hash of what the build may read of one plugin in the installed package: its package.json, which esbuild reads for
// fields such as browser that move an import, and every file of the plugin's folder. A link anywhere in the folder
// is refused by readFiles
export async function communityHash(pkg: string, id: string): Promise<string> {
  const files = (await readFiles(path.join(pkg, id))).map(file => ({ path: `${id}/${file.path}`, bytes: file.bytes }))
  return hashFiles([{ path: 'package.json', bytes: await readFile(path.join(pkg, 'package.json')) }, ...files])
}

const kind = (file: string) => lstat(file).then(stat => (stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'folder' : 'file'), () => 'missing')

async function json(file: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new Error(`${name} is not JSON`)
  }
}

// The folder a community plugin is built from: node_modules/hetu-plugins/<id> in the repository given, which the build
// names from where it sits and nothing else does. Throws a plain message unless package.json and the lock pin the
// commit pin records, the package is installed as a folder of its own, its package.json names no script npm runs on
// install, the plugin's manifest names its folder's id and the files hash to what pin records for the commit
export async function communitySource(repo: string, id: string, pin: Pin = PIN): Promise<string> {
  const recorded = Object.hasOwn(pin.files, id) ? pin.files[id] : undefined
  if (recorded === undefined) throw new Error(`${id} is not a plugin hetu takes from ${COMMUNITY_PACKAGE}`)
  const commit = pinnedCommit(await json(path.join(repo, 'package.json'), 'package.json'), await json(path.join(repo, 'package-lock.json'), 'package-lock.json'))
  if (commit !== pin.commit) {
    throw new Error(`package.json pins ${COMMUNITY_PACKAGE} at ${commit}, the build records ${pin.commit}. Move package.json, the lock and PIN in core/build/community.ts together`)
  }
  const pkg = path.join(repo, 'node_modules', COMMUNITY_PACKAGE)
  const installed = await kind(pkg)
  if (installed === 'missing') throw new Error(`node_modules/${COMMUNITY_PACKAGE} is not installed. Run npm ci --ignore-scripts`)
  if (installed !== 'folder') throw new Error(`node_modules/${COMMUNITY_PACKAGE} is a ${installed}, not the folder npm installs`)
  const scripts = Object.keys(record(record(await json(path.join(pkg, 'package.json'), `${COMMUNITY_PACKAGE}/package.json`)).scripts))
  const runs = INSTALL_SCRIPTS.find(script => scripts.includes(script))
  if (runs !== undefined) throw new Error(`${COMMUNITY_PACKAGE}/package.json has a ${runs} script, which npm runs on install`)
  const source = path.join(pkg, id)
  const folder = await kind(source)
  if (folder === 'missing') throw new Error(`${COMMUNITY_PACKAGE} holds no ${id} folder at ${commit}`)
  if (folder !== 'folder') throw new Error(`${COMMUNITY_PACKAGE}/${id} is a ${folder}, not a folder of the package`)
  const manifest = `${COMMUNITY_PACKAGE}/${id}/hetu-plugin.json`
  const named = record(await json(path.join(source, 'hetu-plugin.json'), manifest)).id
  if (named !== id) throw new Error(`${manifest} names the plugin ${String(named)}, not ${id}`)
  const hash = await communityHash(pkg, id)
  if (hash !== recorded) {
    throw new Error(`${COMMUNITY_PACKAGE}/${id} and its package.json hash to ${hash}, hetu records ${recorded} for ${commit}. `
      + 'Run npm ci --ignore-scripts. If they still differ, the files are not the ones recorded for the commit')
  }
  return source
}
