import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findPlugins } from '../backend/plugins-manager/find.ts'
import { filesFor, hashOf, workerManifest, writeFolder } from './plugins-manager-fakes.ts'

const made: string[] = []

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-find-'))
  made.push(dir)
  return dir
}

const plugin = (id: string, version = '1.0.0') => filesFor(workerManifest(id, { version }))
const summary = (finding: Awaited<ReturnType<typeof findPlugins>>) =>
  finding.plugins.map(each => ({ folder: path.basename(each.folder), id: each.id, version: each.version, problem: each.read.problem }))

describe('plugins found in an unpacked or picked folder', () => {
  it('finds the one plugin whose manifest is at the top, with the bytes read and their hash', async () => {
    const root = path.join(await temp(), 'notes-x')
    await writeFolder(root, plugin('notes-x', '2.1.0'))
    const finding = await findPlugins(root)
    const found = finding.plugins
    expect(summary(finding)).toEqual([{ folder: 'notes-x', id: 'notes-x', version: '2.1.0', problem: null }])
    expect(found[0].folder).toBe(root)
    expect(found[0].read.hash).toBe(await hashOf(root))
    expect(found[0].read.files.map(file => file.path)).toEqual(['hetu-plugin.json', 'worker.js'])
  })

  it('reads a plugin against the id its manifest names, whatever its folder is called', async () => {
    const root = path.join(await temp(), 'staging-1f2e3d')
    await writeFolder(root, plugin('notes-x'))
    expect(summary(await findPlugins(root))).toEqual([{ folder: 'staging-1f2e3d', id: 'notes-x', version: '1.0.0', problem: null }])
  })

  it('finds each plugin one level down, in name order, and skips folders with no manifest and loose files', async () => {
    const root = await temp()
    await writeFolder(path.join(root, 'b-folder'), plugin('beta', '0.2.0'))
    await writeFolder(path.join(root, 'a-folder'), plugin('alpha'))
    await writeFolder(path.join(root, 'docs'), { 'README.md': 'x' })
    await writeFile(path.join(root, 'notes.txt'), 'x')
    expect(summary(await findPlugins(root))).toEqual([
      { folder: 'a-folder', id: 'alpha', version: '1.0.0', problem: null },
      { folder: 'b-folder', id: 'beta', version: '0.2.0', problem: null },
    ])
  })

  it('refuses two folders whose manifests name one id and lists both', async () => {
    const root = await temp()
    await writeFolder(path.join(root, 'alpha-old'), plugin('alpha', '1.0.0'))
    await writeFolder(path.join(root, 'alpha-new'), plugin('alpha', '2.0.0'))
    await writeFolder(path.join(root, 'beta'), plugin('beta'))
    await writeFolder(path.join(root, 'broken-1'), { 'hetu-plugin.json': '{' })
    await writeFolder(path.join(root, 'broken-2'), { 'hetu-plugin.json': '{' })
    const finding = await findPlugins(root)
    expect(finding.problem).toBe('same-id')
    expect(summary(finding).map(each => [each.folder, each.id, each.version])).toEqual([
      ['alpha-new', 'alpha', '2.0.0'], ['alpha-old', 'alpha', '1.0.0'], ['beta', 'beta', '1.0.0'], ['broken-1', null, null], ['broken-2', null, null],
    ])
  })

  it('takes folders with no id read alongside each other', async () => {
    const root = await temp()
    await writeFolder(path.join(root, 'broken-1'), { 'hetu-plugin.json': '{' })
    await writeFolder(path.join(root, 'broken-2'), { 'hetu-plugin.json': '{' })
    expect((await findPlugins(root)).problem).toBeNull()
  })

  it('looks no deeper than one level', async () => {
    const root = await temp()
    await writeFolder(path.join(root, 'release', 'alpha'), plugin('alpha'))
    expect(await findPlugins(root)).toEqual({ problem: null, plugins: [] })
  })

  it('takes a manifest at the top as the one plugin, its own folders never read as more', async () => {
    const root = path.join(await temp(), 'alpha')
    await writeFolder(root, { ...plugin('alpha'), ...Object.fromEntries(Object.entries(plugin('beta')).map(([name, text]) => [`inner/${name}`, text])) })
    expect(summary(await findPlugins(root)).map(each => each.id)).toEqual(['alpha'])
  })

  it('answers each plugin it can not take with the read problem and what its manifest names', async () => {
    const root = await temp()
    await writeFolder(path.join(root, 'broken'), { 'hetu-plugin.json': '{ not json' })
    await writeFolder(path.join(root, 'host'), filesFor({ ...workerManifest('host-plugin'), entries: { host: 'host.js' } }))
    await writeFolder(path.join(root, 'old'), filesFor(workerManifest('old', { api: '^999' })))
    expect(summary(await findPlugins(root))).toEqual([
      { folder: 'broken', id: null, version: null, problem: 'invalid' },
      { folder: 'host', id: null, version: null, problem: 'install-only' },
      { folder: 'old', id: 'old', version: '1.0.0', problem: 'api' },
    ])
  })

  it('follows no link to a plugin folder and takes no manifest that is a folder', async () => {
    const root = await temp()
    const outside = path.join(await temp(), 'outside')
    await writeFolder(outside, plugin('outside'))
    await mkdir(path.join(root, 'plugins'))
    await symlink(outside, path.join(root, 'plugins', 'linked'), 'junction')
    await mkdir(path.join(root, 'plugins', 'odd', 'hetu-plugin.json'), { recursive: true })
    expect(await findPlugins(path.join(root, 'plugins'))).toEqual({ problem: null, plugins: [] })
  })

  it('refuses a root that is missing, a file or a link the same way', async () => {
    const root = await temp()
    const outside = path.join(await temp(), 'outside')
    await writeFolder(outside, plugin('outside'))
    await writeFile(path.join(root, 'a.zip'), 'x')
    await symlink(outside, path.join(root, 'linked'), 'junction')
    for (const name of ['none', 'a.zip', 'linked']) {
      expect(await findPlugins(path.join(root, name)), name).toEqual({ problem: 'not-a-folder', plugins: [] })
    }
  })
})
