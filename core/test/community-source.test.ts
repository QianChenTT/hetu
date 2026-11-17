import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMUNITY_PACKAGE, communityHash, communitySource, PIN, type Pin } from '../build/community.ts'
import { writeFolder } from './loader-fakes.ts'

const repo = path.join(import.meta.dirname, '..', '..')
const made: string[] = []

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

const commit = PIN.commit
const spec = `github:QianChenTT/hetu-plugins#${commit}`

// A repository as npm leaves it: package.json and the lock naming the pinned commit and the package installed in
// node_modules with one plugin, its manifest naming the id given
async function fixture(options: { manifestId?: string, packageJson?: object, install?: boolean } = {}): Promise<{ root: string, pkg: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'hetu-community-'))
  made.push(root)
  await writeFolder(root, {
    'package.json': JSON.stringify({ name: 'hetu', devDependencies: { [COMMUNITY_PACKAGE]: spec } }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'hetu', devDependencies: { [COMMUNITY_PACKAGE]: spec } },
        [`node_modules/${COMMUNITY_PACKAGE}`]: { resolved: `git+ssh://git@github.com/QianChenTT/hetu-plugins.git#${commit}`, dev: true },
      },
    }),
  })
  const pkg = path.join(root, 'node_modules', COMMUNITY_PACKAGE)
  if (options.install !== false) {
    await writeFolder(pkg, {
      'package.json': JSON.stringify(options.packageJson ?? { name: COMMUNITY_PACKAGE, private: true }),
      'README.md': 'not read',
      'file-explorer/hetu-plugin.json': JSON.stringify({ id: options.manifestId ?? 'file-explorer', version: '0.1.0' }),
      'file-explorer/src/worker.ts': 'export default {}\n',
    })
  }
  return { root, pkg }
}

const pinFor = async (pkg: string): Promise<Pin> => ({ commit, files: { 'file-explorer': await communityHash(pkg, 'file-explorer') } })

describe("the community plugins' source", () => {
  it('is the plugin folder of the package npm installed in this repository, at the commit and with the files hetu records', async () => {
    expect(await communitySource(repo, 'file-explorer')).toBe(path.join(repo, 'node_modules', COMMUNITY_PACKAGE, 'file-explorer'))
  })

  it('records file-explorer at the commit package.json pins, and only file-explorer', () => {
    expect(PIN.commit).toBe('1169fd132a3e4870933f80fa21bdb5bc241905c3')
    expect(Object.keys(PIN.files)).toEqual(['file-explorer'])
    expect(PIN.files['file-explorer']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('takes a fixture laid out as npm installs it', async () => {
    const { root, pkg } = await fixture()
    expect(await communitySource(root, 'file-explorer', await pinFor(pkg))).toBe(path.join(pkg, 'file-explorer'))
  })

  it('hashes the package.json and the plugin folder, not the rest of the package', async () => {
    const { pkg } = await fixture()
    const before = await communityHash(pkg, 'file-explorer')
    await writeFile(path.join(pkg, 'README.md'), 'changed')
    expect(await communityHash(pkg, 'file-explorer')).toBe(before)
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: COMMUNITY_PACKAGE, browser: { '@hetu/sdk': './x.ts' } }))
    expect(await communityHash(pkg, 'file-explorer')).not.toBe(before)
  })

  it('fails with a plain message when the package is not installed', async () => {
    const { root } = await fixture({ install: false })
    await expect(communitySource(root, 'file-explorer', { commit, files: { 'file-explorer': 'a'.repeat(64) } }))
      .rejects.toThrow('node_modules/hetu-plugins is not installed. Run npm ci --ignore-scripts')
  })

  it('fails with a plain message when the plugin folder is missing from the package', async () => {
    const { root, pkg } = await fixture()
    await rm(path.join(pkg, 'file-explorer'), { recursive: true })
    await expect(communitySource(root, 'file-explorer', { commit, files: { 'file-explorer': 'a'.repeat(64) } }))
      .rejects.toThrow('hetu-plugins holds no file-explorer folder')
  })

  it('fails with a plain message when the manifest names another id', async () => {
    const { root, pkg } = await fixture({ manifestId: 'search' })
    await expect(communitySource(root, 'file-explorer', await pinFor(pkg)))
      .rejects.toThrow('hetu-plugins/file-explorer/hetu-plugin.json names the plugin search, not file-explorer')
  })

  it('fails with a plain message when the manifest is not JSON or has no id', async () => {
    const { root, pkg } = await fixture()
    await writeFile(path.join(pkg, 'file-explorer', 'hetu-plugin.json'), '{ "version": "0.1.0" }')
    await expect(communitySource(root, 'file-explorer', await pinFor(pkg))).rejects.toThrow('names the plugin undefined, not file-explorer')
    await writeFile(path.join(pkg, 'file-explorer', 'hetu-plugin.json'), 'not json')
    await expect(communitySource(root, 'file-explorer', await pinFor(pkg))).rejects.toThrow('hetu-plugins/file-explorer/hetu-plugin.json is not JSON')
  })

  // GitHub serving other files for the commit, or an install left from another commit
  it('fails when the files differ from the hash hetu records for the commit', async () => {
    const { root, pkg } = await fixture()
    const pin = await pinFor(pkg)
    await writeFile(path.join(pkg, 'file-explorer', 'src', 'worker.ts'), 'export default { changed: true }\n')
    await expect(communitySource(root, 'file-explorer', pin)).rejects.toThrow(`hetu records ${pin.files['file-explorer']}`)
  })

  it('fails when package.json pins another commit than hetu records', async () => {
    const { root, pkg } = await fixture()
    await expect(communitySource(root, 'file-explorer', { ...await pinFor(pkg), commit: 'b'.repeat(40) }))
      .rejects.toThrow(`package.json pins hetu-plugins at ${commit}, the build records ${'b'.repeat(40)}`)
  })

  it('fails when package.json and the lock disagree', async () => {
    const { root, pkg } = await fixture()
    const lock = path.join(root, 'package-lock.json')
    await writeFile(lock, (await readFile(lock, 'utf8')).replace(`hetu-plugins#${commit}`, `hetu-plugins#${'b'.repeat(40)}`))
    await expect(communitySource(root, 'file-explorer', await pinFor(pkg))).rejects.toThrow('package-lock.json was made for')
  })

  it('refuses an id the package is not recorded for', async () => {
    const { root, pkg } = await fixture()
    await expect(communitySource(root, 'search', await pinFor(pkg))).rejects.toThrow('search is not a plugin hetu takes from hetu-plugins')
  })

  // A link would take the source from wherever it points, past the commit
  it('refuses the package or the plugin folder as a link', async () => {
    const { root, pkg } = await fixture()
    const pin = await pinFor(pkg)
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'hetu-community-elsewhere-'))
    made.push(elsewhere)
    await writeFolder(path.join(elsewhere, 'file-explorer'), { 'hetu-plugin.json': JSON.stringify({ id: 'file-explorer', version: '0.1.0' }), 'src/worker.ts': 'export default {}\n' })
    await rm(path.join(pkg, 'file-explorer'), { recursive: true })
    await symlink(path.join(elsewhere, 'file-explorer'), path.join(pkg, 'file-explorer'), 'junction')
    await expect(communitySource(root, 'file-explorer', pin)).rejects.toThrow('hetu-plugins/file-explorer is a link')
    await rm(path.join(pkg, 'file-explorer'))
    const moved = path.join(elsewhere, 'pkg')
    await writeFolder(moved, { 'package.json': '{}' })
    await rm(pkg, { recursive: true })
    await symlink(moved, pkg, 'junction')
    await expect(communitySource(root, 'file-explorer', pin)).rejects.toThrow('node_modules/hetu-plugins is a link')
    await rm(pkg)
  })

  it('refuses a link inside the plugin folder', async () => {
    const { root, pkg } = await fixture()
    const pin = await pinFor(pkg)
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'hetu-community-elsewhere-'))
    made.push(elsewhere)
    await symlink(elsewhere, path.join(pkg, 'file-explorer', 'src', 'more'), 'junction')
    await expect(communitySource(root, 'file-explorer', pin)).rejects.toThrow('not a file or folder')
    await rm(path.join(pkg, 'file-explorer', 'src', 'more'))
  })

  // npm runs these for a git dependency unless its install skips scripts
  it.each(['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack'])('refuses a package whose package.json has a %s script', async script => {
    const { root, pkg } = await fixture({ packageJson: { name: COMMUNITY_PACKAGE, scripts: { test: 'vitest', [script]: 'node x.js' } } })
    await expect(communitySource(root, 'file-explorer', await pinFor(pkg))).rejects.toThrow(`a ${script} script`)
  })

  it('takes a package whose scripts npm never runs on install', async () => {
    const { root, pkg } = await fixture({ packageJson: { name: COMMUNITY_PACKAGE, scripts: { build: 'node build.ts', test: 'vitest' } } })
    expect(await communitySource(root, 'file-explorer', await pinFor(pkg))).toBe(path.join(pkg, 'file-explorer'))
  })
})
