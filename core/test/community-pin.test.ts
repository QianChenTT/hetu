import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMUNITY_PACKAGE, pinnedCommit } from '../build/community.ts'

const repo = path.join(import.meta.dirname, '..', '..')
const read = async (name: string) => JSON.parse(await readFile(path.join(repo, name), 'utf8')) as Record<string, unknown>

const commit = '1169fd132a3e4870933f80fa21bdb5bc241905c3'
const other = 'b'.repeat(40)
const spec = (at: string) => `github:QianChenTT/hetu-plugins#${at}`
const resolved = (at: string) => `git+ssh://git@github.com/QianChenTT/hetu-plugins.git#${at}`

// The shape npm writes: the root's own entry repeats package.json's spec and the installed package records where it
// came from
const manifestOf = (at: string, extra: object = {}) => ({ name: 'hetu', devDependencies: { electron: '45.3.0', [COMMUNITY_PACKAGE]: spec(at) }, ...extra })
const lockOf = (rootAt: string, resolvedAt: string, entry: object = {}, packages: object = {}) => ({
  lockfileVersion: 3,
  packages: {
    '': { name: 'hetu', devDependencies: { electron: '45.3.0', [COMMUNITY_PACKAGE]: spec(rootAt) } },
    [`node_modules/${COMMUNITY_PACKAGE}`]: { resolved: resolved(resolvedAt), dev: true, ...entry },
    ...packages,
  },
})

describe('the commit hetu takes its community plugins from', () => {
  // npm ci follows package.json for a git dependency and checks no integrity for one, so the lock alone holds nothing
  it('is one full commit that package.json and package-lock.json both name', async () => {
    const at = pinnedCommit(await read('package.json'), await read('package-lock.json'))
    expect(at).toBe(commit)
  })

  it('reads a full commit named the same way in both', () => {
    expect(pinnedCommit(manifestOf(commit), lockOf(commit, commit))).toBe(commit)
  })

  it.each([
    ['a branch', 'main'],
    ['a tag', 'v1.0.0'],
    ['a short hash', commit.slice(0, 7)],
    ['a hash one character short', commit.slice(0, 39)],
    ['an uppercase hash', commit.toUpperCase()],
    ['a semver range', 'semver:^1.0.0'],
  ])('refuses %s in place of a full commit', (_name, at) => {
    expect(() => pinnedCommit(manifestOf(at), lockOf(at, at))).toThrow('full 40-character commit')
  })

  it.each([
    ['another owner', 'github:someone/hetu-plugins#'],
    ['another repository', 'github:QianChenTT/hetu-plugin#'],
    ['an https address', 'git+https://github.com/QianChenTT/hetu-plugins.git#'],
    ['a tarball address', 'https://codeload.github.com/QianChenTT/hetu-plugins/tar.gz/'],
  ])('refuses %s', (_name, address) => {
    const manifest = { devDependencies: { [COMMUNITY_PACKAGE]: `${address}${commit}` } }
    expect(() => pinnedCommit(manifest, lockOf(commit, commit))).toThrow('github:QianChenTT/hetu-plugins#')
  })

  it('refuses package.json naming no community package', () => {
    expect(() => pinnedCommit({ devDependencies: { electron: '45.3.0' } }, lockOf(commit, commit))).toThrow('names no hetu-plugins')
  })

  // A production dependency would be packed into the app and counted by the production audit
  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])('refuses it in %s', field => {
    expect(() => pinnedCommit(manifestOf(commit, { [field]: { [COMMUNITY_PACKAGE]: spec(commit) } }), lockOf(commit, commit))).toThrow(field)
  })

  it('refuses a lock made for another commit than package.json names', () => {
    expect(() => pinnedCommit(manifestOf(commit), lockOf(other, other))).toThrow('package-lock.json')
  })

  it('refuses a lock whose root names another commit than package.json, whatever it installed', () => {
    expect(() => pinnedCommit(manifestOf(commit), lockOf(other, commit))).toThrow('package-lock.json was made for')
  })

  it('refuses a lock whose installed package came from another commit than its root names', () => {
    expect(() => pinnedCommit(manifestOf(commit), lockOf(commit, other))).toThrow('package-lock.json')
  })

  it('refuses a lock with no entry for the installed package', () => {
    const lock = lockOf(commit, commit)
    delete (lock.packages as Record<string, unknown>)[`node_modules/${COMMUNITY_PACKAGE}`]
    expect(() => pinnedCommit(manifestOf(commit), lock)).toThrow('package-lock.json')
  })

  it('refuses it installed as a production package', () => {
    expect(() => pinnedCommit(manifestOf(commit), lockOf(commit, commit, { dev: false }))).toThrow('dev')
  })

  // Installing it runs nothing and pulls nothing, so a new commit can't bring either in unseen
  it.each([
    ['a dependency of its own', { dependencies: { zod: '^4.0.0' } }],
    ['an optional dependency', { optionalDependencies: { zod: '^4.0.0' } }],
    ['a peer dependency', { peerDependencies: { zod: '^4.0.0' } }],
    ['an install script', { hasInstallScript: true }],
    ['a command', { bin: { x: 'x.js' } }],
  ])('refuses the installed package with %s', (_name, entry) => {
    expect(() => pinnedCommit(manifestOf(commit), lockOf(commit, commit, entry))).toThrow('hetu-plugins')
  })

  it('refuses a package installed inside it', () => {
    const lock = lockOf(commit, commit, {}, { [`node_modules/${COMMUNITY_PACKAGE}/node_modules/zod`]: { version: '4.0.0' } })
    expect(() => pinnedCommit(manifestOf(commit), lock)).toThrow('inside')
  })
})
