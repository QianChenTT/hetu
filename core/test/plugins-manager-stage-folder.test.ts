import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findPlugins } from '../backend/plugins-manager/find.ts'
import { stageFolder, unpackLimits } from '../backend/plugins-manager/unpack.ts'
import { filesFor, hashOf, workerManifest, writeFolder } from './plugins-manager-fakes.ts'

// A folder the human picked goes through the same checks and caps as a zip, into a staging folder that is then all the
// finder reads

const made: string[] = []

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-stage-folder-'))
  made.push(dir)
  return dir
}

async function staging(): Promise<string> {
  const into = path.join(await temp(), 'staging')
  await mkdir(into)
  return into
}

const listed = async (root: string) => (await readdir(root, { recursive: true, withFileTypes: true }))
  .map(entry => `${path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')}${entry.isDirectory() ? '/' : ''}`)
  .sort()

describe('a picked folder staged', () => {
  it('copies every file with its bytes and every folder, and the finder finds the plugin in the copy', async () => {
    const picked = path.join(await temp(), 'alpha')
    await writeFolder(picked, { ...filesFor(workerManifest('alpha')), 'assets/icons/a.svg': '<svg/>', 'empty.txt': '' })
    const into = await staging()
    expect(await stageFolder(picked, into)).toBeNull()
    expect(await listed(into)).toEqual(['assets/', 'assets/icons/', 'assets/icons/a.svg', 'empty.txt', 'hetu-plugin.json', 'worker.js'])
    expect(await readFile(path.join(into, 'assets', 'icons', 'a.svg'), 'utf8')).toBe('<svg/>')
    const finding = await findPlugins(into)
    expect(finding.plugins.map(each => [each.id, each.read.problem])).toEqual([['alpha', null]])
    expect(finding.plugins[0].read.hash).toBe(await hashOf(picked))
  })

  it('refuses a picked folder that is missing, a file or a link, and writes nothing', async () => {
    const base = await temp()
    const real = path.join(base, 'real')
    await writeFolder(real, filesFor(workerManifest('alpha')))
    await writeFile(path.join(base, 'a.zip'), 'x')
    await symlink(real, path.join(base, 'linked'), 'junction')
    for (const picked of ['none', 'a.zip', 'linked']) {
      const into = await staging()
      expect(await stageFolder(path.join(base, picked), into), picked).toBe('not-a-folder')
      expect(await readdir(into)).toEqual([])
    }
  })

  it('refuses a link inside the folder and leaves the staging folder empty', async () => {
    const base = await temp()
    const outside = path.join(base, 'outside')
    await writeFolder(outside, { 'secret.txt': 'secret' })
    const picked = path.join(base, 'alpha')
    await writeFolder(picked, filesFor(workerManifest('alpha')))
    await symlink(outside, path.join(picked, 'assets'), 'junction')
    const into = await staging()
    expect(await stageFolder(picked, into)).toBe('special')
    expect(await readdir(into)).toEqual([])
  })

  it('refuses a name the checks refuse, as a zip\'s', async () => {
    const deep = path.join(await temp(), 'alpha')
    await writeFolder(deep, { [`${Array.from({ length: 32 }, () => 'd').join('/')}/a.txt`]: 'x' })
    const odd = path.join(await temp(), 'alpha')
    await writeFolder(odd, { 'a\u200cb.js': 'x' })
    for (const picked of [deep, odd]) {
      const into = await staging()
      expect(await stageFolder(picked, into)).toBe('name')
      expect(await readdir(into)).toEqual([])
    }
  })

  it('holds a folder to the caps, counted as written, every folder counted', async () => {
    const picked = path.join(await temp(), 'alpha')
    await writeFolder(picked, { 'a/b/c.txt': 'x'.repeat(600), 'd.txt': 'x'.repeat(400) })
    expect(await stageFolder(picked, await staging(), { entries: 4, bytes: 1000 })).toBeNull()
    const few = await staging()
    expect(await stageFolder(picked, few, { entries: 3, bytes: 1000 })).toBe('too-many')
    expect(await readdir(few)).toEqual([])
    const small = await staging()
    expect(await stageFolder(picked, small, { entries: 4, bytes: 999 })).toBe('too-big')
    expect(await readdir(small)).toEqual([])
  })

  it('stops a folder that holds a whole checkout at the entry cap, on a small cap', async () => {
    const picked = path.join(await temp(), 'alpha')
    const files: Record<string, string> = filesFor(workerManifest('alpha'))
    for (let i = 0; i < 100; i++) files[`node_modules/p${i % 10}/f${i}.js`] = ''
    await writeFolder(picked, files)
    const into = await staging()
    expect(await stageFolder(picked, into, { entries: 50, bytes: unpackLimits.bytes })).toBe('too-many')
    expect(await readdir(into)).toEqual([])
  })

  it('skips a __MACOSX folder at the top, as a zip\'s', async () => {
    const picked = path.join(await temp(), 'alpha')
    await writeFolder(picked, { ...filesFor(workerManifest('alpha')), '__MACOSX/._worker.js': 'fork' })
    const into = await staging()
    expect(await stageFolder(picked, into)).toBeNull()
    expect(await listed(into)).toEqual(['hetu-plugin.json', 'worker.js'])
  })

  it('takes only an empty staging folder', async () => {
    const picked = path.join(await temp(), 'alpha')
    await writeFolder(picked, filesFor(workerManifest('alpha')))
    const into = await staging()
    await writeFile(path.join(into, 'left.txt'), 'x')
    await expect(stageFolder(picked, into)).rejects.toThrow()
  })
})
