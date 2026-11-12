import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_LIST, installList } from '../api/install.ts'
import { STAGED_APP, stageInstall } from '../build/stage.ts'
import { hashFiles, readFiles } from '../lib/hash-files.ts'
import { parseStrict } from '../lib/hashed-file.ts'

const made: string[] = []

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-stage-'))
  made.push(dir)
  return dir
}

const files = async (root: string) => (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()

async function stagedApp(options: { locked: boolean }): Promise<string> {
  const stage = path.join(await temp(), 'stage')
  await stageInstall(stage, options)
  return path.join(stage, 'app')
}

// The value main.js gives a build constant, found by its one declaration and run alone with nothing in scope, so a
// ternary or any other shape esbuild writes reads as the value it holds
function constant(main: string, name: 'PACKAGED' | 'LOCKED'): boolean {
  const found = [...main.matchAll(new RegExp(`^var ${name} = [^;\\n]+;$`, 'gm'))]
  if (found.length !== 1) throw new Error(`${name} is declared ${found.length} times, not once`)
  const value: unknown = new Function(`"use strict"; ${found[0][0]} return ${name}`)()
  if (typeof value !== 'boolean') throw new Error(`${name} is not a boolean`)
  return value
}

const INSTALL_PLUGINS =['capabilities', 'exec', 'gate', 'hidden-marks', 'history', 'layout', 'luoshu', 'search', 'storage']

describe('the stage the package is built from', () => {
  it('holds the app for app.asar and the install plugins beside it, and nothing else', async () => {
    const stage = path.join(await temp(), 'stage')
    await stageInstall(stage, { locked: true })
    expect((await readdir(stage)).sort()).toEqual(['app', 'plugins'])
    const app = await files(path.join(stage, 'app'))
    expect(app.filter(file => !file.startsWith('frontend/'))).toEqual([INSTALL_LIST, 'main.js', 'mount-preload.js', 'package.json', 'workers-preload.js'])
    expect(app.filter(file => file.startsWith('frontend/')).every(file => /^frontend\/(mount|trusted|workers)\/[\w.-]+\.(html|css|js)$/.test(file))).toBe(true)
    expect((await readdir(path.join(stage, 'plugins'))).sort()).toEqual(INSTALL_PLUGINS)
    const all = [...app, ...await files(path.join(stage, 'plugins'))]
    expect(all.filter(file => /node_modules|\.map$|\.ts$|(^|\/)log\//.test(file))).toEqual([])
  })

  it('lists each plugin beside app.asar with the hash of its folder, the list inside the app', async () => {
    const stage = path.join(await temp(), 'stage')
    await stageInstall(stage, { locked: true })
    const list = parseStrict(await readFile(path.join(stage, 'app', INSTALL_LIST)), installList)
    expect(Object.keys(list.plugins).sort()).toEqual(INSTALL_PLUGINS)
    for (const [id, listed] of Object.entries(list.plugins)) {
      expect(listed.path).toBe(`plugins/${id}`)
      expect(listed.hash, id).toBe(hashFiles(await readFiles(path.join(stage, listed.path))))
    }
  })

  it('fixes the build into main.js: packaged always, locked for the shipped build and not for the driven one', async () => {
    const shipped = path.join(await temp(), 'stage')
    await stageInstall(shipped, { locked: true })
    const main = await readFile(path.join(shipped, 'app', 'main.js'), 'utf8')
    expect(constant(main, 'PACKAGED')).toBe(true)
    expect(constant(main, 'LOCKED')).toBe(true)
    expect(main).not.toContain('__HETU_')
    const driven = await readFile(path.join(await stagedApp({ locked: false }), 'main.js'), 'utf8')
    expect(constant(driven, 'PACKAGED')).toBe(true)
    expect(constant(driven, 'LOCKED')).toBe(false)
  })

  it('reads a constant as the build left it, whatever shape esbuild wrote it in', () => {
    // The shapes esbuild writes for the shipped and the driven build. The condition is true in both, so text matching
    // on what follows the name passed for either
    expect(constant('var LOCKED = true ? true : false;', 'LOCKED')).toBe(true)
    expect(constant('var LOCKED = true ? false : false;', 'LOCKED')).toBe(false)
    expect(constant('var LOCKED = false;', 'LOCKED')).toBe(false)
    expect(() => constant('var LOCKED = true;\nvar LOCKED = false;', 'LOCKED')).toThrow('once')
    expect(() => constant('var LOCKED = flag;', 'LOCKED')).toThrow()
  })

  it('names the app, its version and its module entry in a package.json of its own', async () => {
    const stage = path.join(await temp(), 'stage')
    await stageInstall(stage, { locked: true })
    expect(JSON.parse(await readFile(path.join(stage, 'app', 'package.json'), 'utf8'))).toEqual(STAGED_APP)
    expect(STAGED_APP).toMatchObject({ name: 'hetu', version: '0.5.0', main: 'main.js', type: 'module' })
  })

  // The Release workflow names the release from the root package.json and looks for the MSI this version names
  it('takes the version the root package.json and its lock file hold', async () => {
    const root = path.join(import.meta.dirname, '..', '..')
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')) as { version: string, packages: Record<string, { version?: string }> }
    expect([manifest.version, lock.version, lock.packages['']?.version]).toEqual([STAGED_APP.version, STAGED_APP.version, STAGED_APP.version])
  })

  it('starts from an empty folder, so nothing left from an earlier build ships', async () => {
    const stage = path.join(await temp(), 'stage')
    await mkdir(path.join(stage, 'plugins', 'log'), { recursive: true })
    await writeFile(path.join(stage, 'plugins', 'log', 'stale.js'), '')
    await writeFile(path.join(stage, 'stray.txt'), '')
    await stageInstall(stage, { locked: true })
    expect((await readdir(stage)).sort()).toEqual(['app', 'plugins'])
    expect((await readdir(path.join(stage, 'plugins'))).includes('log')).toBe(false)
  })
})
