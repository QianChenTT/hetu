import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { waitForMemory } from './memory.ts'
import { checkReuse, drivenOutDir, pluginsProvenance, readBuildStamp, stampBuild, treeState } from './provenance.ts'
import { makeZip } from '../zip-maker.ts'

const made: string[] = []
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hetu-provenance-'))
  made.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  git('init', '-q')
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), text)
  }
  git('add', '-A')
  git('commit', '-qm', 'one')
  return dir
}
const head = (dir: string) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

describe('the build a tier 0 run drives', () => {
  it('stamps the commit and whether the tree was dirty when packed, and refuses a reuse once either moved', async () => {
    const repo = await repoWith({ 'a.ts': 'one' })
    const out = await mkdtemp(path.join(os.tmpdir(), 'hetu-driven-'))
    made.push(out)
    await mkdir(path.join(out, 'mac-arm64'), { recursive: true })
    await stampBuild(out, repo)
    const clean = await readBuildStamp(out)
    expect(clean).toMatchObject({ commit: head(repo), dirty: false, locked: false })
    expect(() => checkReuse(clean, treeState(repo))).not.toThrow()

    await writeFile(path.join(repo, 'a.ts'), 'two')
    expect(treeState(repo).dirty).toBe(true)
    expect(() => checkReuse(clean, treeState(repo))).toThrow(/changed since it was packed/)
    await stampBuild(out, repo)
    expect(await readBuildStamp(out)).toMatchObject({ dirty: true })

    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'two'])
    expect(() => checkReuse(clean, treeState(repo))).toThrow(/changed since it was packed/)
    expect(drivenOutDir(out)).toBe(path.join(out, 'mac-arm64'))
  })

  it('refuses a build with no stamp', async () => {
    const repo = await repoWith({ 'a.ts': 'one' })
    await expect(readBuildStamp(repo)).rejects.toThrow(/npm run tier0/)
  })
})

describe('the plugin zip a tier 0 run installs', () => {
  async function checkout(): Promise<{ dir: string, zip: string, bytes: Buffer }> {
    const dir = await repoWith({ 'one/hetu-plugin.json': '{"id":"one"}', 'one/src/a.ts': 'x', '.gitignore': 'release/\ndist/\n' })
    await mkdir(path.join(dir, 'one', 'dist'), { recursive: true })
    await writeFile(path.join(dir, 'one', 'dist', 'worker.js'), 'built')
    const bytes = makeZip([{ name: 'one/dist/worker.js', data: Buffer.from('built') }, { name: 'one/hetu-plugin.json', data: Buffer.from('{"id":"one"}') }])
    const zip = path.join(dir, 'release', 'hetu-plugins.zip')
    await mkdir(path.dirname(zip), { recursive: true })
    await writeFile(zip, bytes)
    await writeFile(path.join(dir, 'release', 'SHA256SUMS'), `${createHash('sha256').update(bytes).digest('hex')}  hetu-plugins.zip\n`)
    return { dir, zip, bytes }
  }

  it('ties the zip to its sums, the checkout\'s built files and a tree no newer than it', async () => {
    const { dir, zip, bytes } = await checkout()
    expect(await pluginsProvenance(dir, zip)).toEqual({
      commit: head(dir), dirty: false, zip, sha256: createHash('sha256').update(bytes).digest('hex'),
      sums: 'matches', builtFiles: 'match', newerThanTree: true, consistent: true,
    })
  })

  it('marks a zip older than the tree or unlike the built files, and refuses one unlike its sums', async () => {
    const { dir, zip } = await checkout()
    const old = new Date(Date.now() - 60_000)
    await utimes(zip, old, old)
    await writeFile(path.join(dir, 'one', 'dist', 'worker.js'), 'built again')
    expect(await pluginsProvenance(dir, zip)).toMatchObject({ builtFiles: 'differ', newerThanTree: false, consistent: false })
    await writeFile(path.join(dir, 'release', 'SHA256SUMS'), `${'0'.repeat(64)}  hetu-plugins.zip\n`)
    await expect(pluginsProvenance(dir, zip)).rejects.toThrow(/SHA256SUMS/)
  })
})

describe('the memory gate', () => {
  it('waits for memory and answers low once the wait runs out under the floor', async () => {
    expect(await waitForMemory({ free: () => 1.0, floor: 1.5, waitMs: 120, poll: 20 })).toEqual({ ok: false, free: 1.0 })
    const rising = [1.0, 1.2, 1.6]
    expect(await waitForMemory({ free: () => rising.shift() ?? 1.6, floor: 1.5, waitMs: 1000, poll: 10 })).toEqual({ ok: true, free: 1.6 })
  })
})
