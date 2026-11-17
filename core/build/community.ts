// The community repository hetu's build takes first-party plugins from. npm fetches it from GitHub at the one commit
// package.json names and installs it in node_modules under its package name
export const COMMUNITY_PACKAGE = 'hetu-plugins'
const REPOSITORY = 'QianChenTT/hetu-plugins'
const SPEC = `github:${REPOSITORY}#`
const FULL_COMMIT = /^[0-9a-f]{40}$/
// What npm writes into the lock for a github: address, whatever way it fetched the commit
const resolvedAt = (commit: string) => `git+ssh://git@github.com/${REPOSITORY}.git#${commit}`

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

// The commit package.json pins the community package at, held to package-lock.json. npm ci follows package.json for a
// git dependency and checks no integrity for one, so the two must name the same full commit or the lock pins nothing.
// It is a dev dependency only, so nothing of it is packed into the app, and it brings no package, install script or
// command of its own. Throws a plain message naming what to fix
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
