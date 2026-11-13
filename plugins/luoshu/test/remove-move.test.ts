import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from 'hetu-core/api/envelope.ts'
import type { Call, Prepared } from 'hetu-core/api/slots.ts'
import { createLuoshu, type Luoshu, type LuoshuOptions } from '../src/luoshu.ts'

const onWindows = process.platform === 'win32'
const foldsCase = onWindows || process.platform === 'darwin'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const run = promisify(execFile)
const caller: Caller = { kind: 'window', role: 'editor', n: 0 }

let base: string
let folder: string
let bin: string
let n = 0
// Each luoshu a test opened, whose watch ends before its folder goes
const live: Luoshu[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-move-')))
  folder = path.join(base, 'notes')
  bin = path.join(base, 'bin')
  for (const dir of [path.join(folder, '.git'), path.join(folder, 'journal'), path.join(base, 'data'), path.join(base, 'install'), bin]) {
    await mkdir(dir, { recursive: true })
  }
  await writeFile(path.join(folder, 'a.md'), 'note a')
  await writeFile(path.join(folder, 'journal', 'b.md'), 'note b')
})

afterEach(async () => {
  for (const made of live.splice(0)) made.close()
  await rm(base, { recursive: true, force: true })
})

type Opened = Luoshu & { heard: [string, string][], binned: string[] }
type Bin = (absolute: string) => Promise<void>

// Opened with a bin that moves what it is handed out of the notes folder, as the OS's recycle bin does, unless a test
// hands another
function opened(options: LuoshuOptions = {}, trash?: Bin): Opened {
  const heard: [string, string][] = []
  const binned: string[] = []
  const made = createLuoshu({ publish: (topic, at) => heard.push([topic, at]), ...options })
  live.push(made)
  const given: Bin = trash ?? (async absolute => {
    binned.push(absolute)
    await rename(absolute, path.join(bin, `${binned.length}-${path.basename(absolute)}`))
  })
  made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install'), trash: given })
  return Object.assign(made, { heard, binned })
}

const callOf = (action: string, args: unknown): Call => ({ callId: `c${++n}`, caller, action, args, deadline: Date.now() + 30000 })

// prepare then perform, as the carrier makes a call. A refusal from either comes back as the value thrown or given
async function ask(made: Luoshu, action: string, args: unknown): Promise<unknown> {
  const call = callOf(action, args)
  const prepared = await made.provider.prepare(call)
  if (!('scope' in prepared)) return { refused: prepared }
  try {
    return await made.provider.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  }
}

const exists = (relative: string) => readFile(path.join(folder, relative), 'utf8').then(() => true, () => false)
const names = async (dir = folder) => (await readdir(dir)).filter(name => name !== '.git').sort()

describe('removing', () => {
  it('hands the note to the bin, answers null and publishes the change as its own', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.remove', { path: 'a.md', baseVersion: sha('note a') })).toBeNull()
    expect(await exists('a.md')).toBe(false)
    expect(made.binned).toEqual([path.join(folder, 'a.md')])
    expect(await readFile(path.join(bin, '1-a.md'), 'utf8')).toBe('note a')
    expect(made.heard).toEqual([['changed', 'a.md']])
  })

  it('removes at the version the remover read and refuses a stale one, leaving the note', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.remove', { path: 'a.md', baseVersion: sha('older') })).toEqual({ refused: { code: 'stale' } })
    expect(await exists('a.md')).toBe(true)
    expect(made.binned).toEqual([])
    expect(await ask(made, 'luoshu.remove', { path: 'a.md', baseVersion: sha('note a') })).toBeNull()
    expect(await exists('a.md')).toBe(false)
  })

  // As a write over a note that exists: a plugin that can write a note and can't read it never learns its version, so
  // it can't bin the note and write its own text under the name
  it('refuses a remove with no version as stale, leaving the note and the bin', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.remove', { path: 'a.md' })).toEqual({ refused: { code: 'stale' } })
    expect(await exists('a.md')).toBe(true)
    expect(made.binned).toEqual([])
    expect(made.heard).toEqual([])
  })

  it('refuses a remove at the version read before an outside save, leaving the text saved since', async () => {
    const made = opened()
    const { version } = await ask(made, 'luoshu.read', { path: 'a.md' }) as { version: string }
    await writeFile(path.join(folder, 'a.md'), 'saved since')
    expect(await ask(made, 'luoshu.remove', { path: 'a.md', baseVersion: version })).toEqual({ refused: { code: 'stale' } })
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('saved since')
    expect(made.binned).toEqual([])
  })

  it('answers not-found for a note that isn\'t there and for a folder', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.remove', { path: 'nope.md' })).toEqual({ refused: { code: 'not-found' } })
    expect(await ask(made, 'luoshu.remove', { path: 'journal' })).toEqual({ refused: { code: 'not-found' } })
    expect(made.binned).toEqual([])
  })

  it('scopes the call to the canonical path the gate judges, with the version beside it', async () => {
    const made = opened()
    const call = callOf('luoshu.remove', { path: 'journal/b.md', baseVersion: sha('note b') })
    expect(await made.provider.prepare(call)).toEqual({ scope: { paths: ['journal/b.md'] }, baseVersion: sha('note b') })
    made.provider.release!(call, { scope: { paths: ['journal/b.md'] } })
  })

  it('refuses a junction out of the folder and leaves what it points at', async () => {
    await mkdir(path.join(base, 'outside'))
    await writeFile(path.join(base, 'outside', 'secret.md'), 'secret')
    await symlink(path.join(base, 'outside'), path.join(folder, 'linked'), 'junction')
    const made = opened()
    expect(await ask(made, 'luoshu.remove', { path: 'linked/secret.md' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await readFile(path.join(base, 'outside', 'secret.md'), 'utf8')).toBe('secret')
    expect(made.binned).toEqual([])
  })

  // The canonical path was judged at prepare. A folder on the way swapped for a junction out of the luoshu by then
  // would hand the bin a file outside it
  it('refuses a remove whose folder became a junction out of the luoshu after prepare', async () => {
    await mkdir(path.join(base, 'outside'))
    await writeFile(path.join(base, 'outside', 'b.md'), 'outside b')
    const made = opened()
    const call = callOf('luoshu.remove', { path: 'journal/b.md', baseVersion: sha('note b') })
    const prepared = await made.provider.prepare(call) as Prepared
    await rename(path.join(folder, 'journal'), path.join(folder, 'journal-old'))
    await symlink(path.join(base, 'outside'), path.join(folder, 'journal'), 'junction')
    await expect(made.provider.perform(call, prepared)).rejects.toEqual({ code: 'not-granted' })
    expect(await readFile(path.join(base, 'outside', 'b.md'), 'utf8')).toBe('outside b')
    expect(made.binned).toEqual([])
  })

  it('answers unavailable with no bin to hand the note to, and removes nothing', async () => {
    const made = createLuoshu()
    made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
    expect(await ask(made, 'luoshu.remove', { path: 'a.md', baseVersion: sha('note a') })).toEqual({ refused: { code: 'unavailable' } })
    expect(await exists('a.md')).toBe(true)
  })

  it('answers failed when the bin refuses, and removes nothing', async () => {
    const made = opened({}, async () => { throw new Error('the bin is full') })
    expect(await ask(made, 'luoshu.remove', { path: 'a.md', baseVersion: sha('note a') })).toEqual({ refused: new Error('the bin is full') })
    expect(await exists('a.md')).toBe(true)
    expect(made.heard).toEqual([])
  })
})

describe('moving', () => {
  it('moves a note into a folder it makes, keeps its bytes, answers null and publishes both ends', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: 'old/2026/a.md' })).toBeNull()
    expect(await exists('a.md')).toBe(false)
    expect(await readFile(path.join(folder, 'old', '2026', 'a.md'), 'utf8')).toBe('note a')
    expect(made.heard).toEqual([['changed', 'a.md'], ['changed', 'old/2026/a.md']])
  })

  it('never moves onto a note that exists, leaving both as they were', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: 'journal/b.md' })).toEqual({ refused: { code: 'stale' } })
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('note a')
    expect(await readFile(path.join(folder, 'journal', 'b.md'), 'utf8')).toBe('note b')
    expect(made.heard).toEqual([])
  })

  it('never moves onto a folder', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: 'journal' })).toEqual({ refused: { code: 'stale' } })
    expect(await exists('a.md')).toBe(true)
  })

  it.runIf(foldsCase)('never moves onto another spelling of an existing note', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: 'JOURNAL/B.md' })).toEqual({ refused: { code: 'stale' } })
    expect(await readFile(path.join(folder, 'journal', 'b.md'), 'utf8')).toBe('note b')
  })

  it('renames a.md to A.md in place, with one lock for both ends', async () => {
    const made = opened()
    const call = callOf('luoshu.move', { from: 'a.md', to: 'A.md' })
    const prepared = await Promise.race([made.provider.prepare(call), tick(2000).then(() => 'held')])
    expect(prepared).toEqual({ scope: { paths: ['a.md', 'A.md'] } })
    expect(await made.provider.perform(call, prepared as Prepared)).toBeNull()
    expect(await names()).toEqual(['A.md', 'journal'])
    expect(await readFile(path.join(folder, 'A.md'), 'utf8')).toBe('note a')
  })

  it('answers invalid for a move with no ends or an end that isn\'t a string', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', undefined)).toEqual({ refused: { code: 'invalid' } })
    expect(await ask(made, 'luoshu.move', { from: 'a.md' })).toEqual({ refused: { code: 'invalid' } })
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: 7 })).toEqual({ refused: { code: 'invalid' } })
    expect(await exists('a.md')).toBe(true)
  })

  it('answers not-found for a from end that isn\'t there or is a folder', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from: 'nope.md', to: 'b.md' })).toEqual({ refused: { code: 'not-found' } })
    expect(await ask(made, 'luoshu.move', { from: 'journal', to: 'diary' })).toEqual({ refused: { code: 'not-found' } })
    expect(await names()).toEqual(['a.md', 'journal'])
  })

  // The gate judges the ends prepare gives, so the to end is the note the move makes and not the caller's text
  it('scopes the call to both canonical ends, the to end through a junction inside the luoshu', async () => {
    await symlink(path.join(folder, 'journal'), path.join(folder, 'diary'), 'junction')
    const made = opened()
    const call = callOf('luoshu.move', { from: 'diary/b.md', to: 'diary/c.md' })
    const prepared = await made.provider.prepare(call) as Prepared
    expect(prepared).toEqual({ scope: { paths: ['journal/b.md', 'journal/c.md'] } })
    expect(await made.provider.perform(call, prepared)).toBeNull()
    expect(await readFile(path.join(folder, 'journal', 'c.md'), 'utf8')).toBe('note b')
  })

  it('refuses a junction out of the luoshu on either end and leaves what it points at', async () => {
    await mkdir(path.join(base, 'outside'))
    await writeFile(path.join(base, 'outside', 'secret.md'), 'secret')
    await symlink(path.join(base, 'outside'), path.join(folder, 'linked'), 'junction')
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from: 'linked/secret.md', to: 'stolen.md' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: 'linked/a.md' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await readdir(path.join(base, 'outside'))).toEqual(['secret.md'])
    expect(await exists('a.md')).toBe(true)
    expect(await exists('stolen.md')).toBe(false)
  })

  it('refuses a move whose to folder became a junction out of the luoshu after prepare', async () => {
    await mkdir(path.join(base, 'outside'))
    const made = opened()
    const call = callOf('luoshu.move', { from: 'a.md', to: 'journal/a.md' })
    const prepared = await made.provider.prepare(call) as Prepared
    await rename(path.join(folder, 'journal'), path.join(folder, 'journal-old'))
    await symlink(path.join(base, 'outside'), path.join(folder, 'journal'), 'junction')
    await expect(made.provider.perform(call, prepared)).rejects.toEqual({ code: 'not-granted' })
    expect(await readdir(path.join(base, 'outside'))).toEqual([])
    expect(await exists('a.md')).toBe(true)
  })

  // The folders a to end names below the swapped one would be made outside before the check refused the move
  it('makes no folder outside the luoshu for a to end below a folder that became a junction out after prepare', async () => {
    await mkdir(path.join(base, 'outside'))
    const made = opened()
    const call = callOf('luoshu.move', { from: 'a.md', to: 'journal/new/deeper/a.md' })
    const prepared = await made.provider.prepare(call) as Prepared
    await rename(path.join(folder, 'journal'), path.join(folder, 'journal-old'))
    await symlink(path.join(base, 'outside'), path.join(folder, 'journal'), 'junction')
    await expect(made.provider.perform(call, prepared)).rejects.toEqual({ code: 'not-granted' })
    expect(await readdir(path.join(base, 'outside'), { recursive: true })).toEqual([])
    expect(await exists('a.md')).toBe(true)
  })

  it('makes the folders a to end names below one that is still itself', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: 'journal/new/deeper/a.md' })).toBeNull()
    expect(await readFile(path.join(folder, 'journal', 'new', 'deeper', 'a.md'), 'utf8')).toBe('note a')
  })
})

describe('the spellings threat-model row 3 found, on both ends', () => {
  it.each([
    ['.git by name', '.git/config', 'not-granted'],
    ['.git in another case', '.GIT/config', 'not-granted'],
    ['a parent step', '../outside.md', 'invalid'],
    ['an absolute path', onWindows ? 'C:/notes/a.md' : '/notes/a.md', 'invalid'],
    ['a stream name', 'a.md::$DATA', 'invalid'],
    ['.git as its folder stream', '.git::$INDEX_ALLOCATION/config', 'invalid'],
    ['a device', 'journal/con.md', 'invalid'],
    ['a trailing dot', 'journal/b.md.', 'invalid'],
  ])('refuses %s', async (_name, spelled, code) => {
    const made = opened()
    expect(await ask(made, 'luoshu.remove', { path: spelled })).toEqual({ refused: { code } })
    expect(await ask(made, 'luoshu.move', { from: spelled, to: 'moved.md' })).toEqual({ refused: { code } })
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: spelled })).toEqual({ refused: { code } })
    expect(await exists('a.md')).toBe(true)
    expect(await exists('moved.md')).toBe(false)
    expect(await readFile(path.join(folder, '.git', 'config'), 'utf8').catch(() => null)).toBeNull()
  })

  it('refuses hetu\'s data folder as a to end', async () => {
    const made = createLuoshu()
    await mkdir(path.join(folder, 'data'), { recursive: true })
    made.role.open({ folder, dataDir: path.join(folder, 'data'), installDir: path.join(base, 'install') })
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: 'data/a.md' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await exists('a.md')).toBe(true)
  })
})

// The luoshu is the one check left with the gate off by the human, so each refusal here comes from canonical alone
describe('the dot rule on both ends of a move and on a remove', () => {
  const notGranted = { refused: { code: 'not-granted' } }
  let before: string[]

  // Every name under the notes folder, dot names and the folders a refused call might have made included
  async function tree(dir = folder, prefix = ''): Promise<string[]> {
    const found: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name
      found.push(name)
      if (entry.isDirectory()) found.push(...await tree(path.join(dir, entry.name), `${name}/`))
    }
    return found.sort()
  }

  beforeEach(async () => {
    await mkdir(path.join(folder, '.obsidian', 'plugins', 'x'), { recursive: true })
    await writeFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
    await writeFile(path.join(folder, 'journal', '.hidden.md'), 'hidden')
    before = await tree()
  })

  async function untouched(made: Opened): Promise<void> {
    expect(await tree()).toEqual(before)
    expect(await readFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
    expect(await readFile(path.join(folder, 'journal', '.hidden.md'), 'utf8')).toBe('hidden')
    expect(made.heard).toEqual([])
    expect(made.binned).toEqual([])
  }

  it.each([
    ['in a dot folder', '.obsidian/plugins/x/main.js'],
    ['in a dot folder spelled in another case', '.OBSIDIAN/plugins/x/main.js'],
    ['that is a dot file', 'journal/.hidden.md'],
  ])('refuses a from end %s', async (_name, from) => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from, to: 'stolen.md' })).toEqual(notGranted)
    expect(await ask(made, 'luoshu.move', { from, to: 'journal/stolen.md' })).toEqual(notGranted)
    await untouched(made)
  })

  it.each([
    ['a dot folder that exists', '.obsidian/a.md'],
    ['a folder inside a dot folder', '.obsidian/plugins/x/a.js'],
    ['a new folder inside a dot folder', '.obsidian/plugins/y/main.js'],
    ['a dot folder spelled in another case', '.OBSIDIAN/a.md'],
    ['a new dot folder', '.github/workflows/x.yml'],
    ['a new dot folder below a plain one', 'journal/.config/a.md'],
    ['a new dot folder deep in new folders', 'journal/deeper/.config/x/a.md'],
    ['a dot folder behind a code point HFS+ skips', '\u200c.obsidian/a.md'],
  ])('refuses a to end in %s, leaving the note where it was', async (_name, to) => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to })).toEqual(notGranted)
    expect(await ask(made, 'luoshu.move', { from: 'journal/b.md', to })).toEqual(notGranted)
    await untouched(made)
  })

  it.each([
    ['at the top', '.a.md'],
    ['in a folder', 'journal/.a.md'],
    ['with two dots', 'journal/..a.md'],
    ['that exists', 'journal/.hidden.md'],
    ['behind a code point HFS+ skips', 'journal/\ufeff.a.md'],
  ])('refuses a to end that is a dot file %s', async (_name, to) => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to })).toEqual(notGranted)
    await untouched(made)
  })

  it('refuses a to end through a junction into a dot folder, and a junction named with a dot', async () => {
    await symlink(path.join(folder, '.obsidian'), path.join(folder, 'cfg'), 'junction')
    await symlink(path.join(folder, 'journal'), path.join(folder, '.shown'), 'junction')
    before = await tree()
    const made = opened()
    for (const to of ['cfg/a.md', 'cfg/plugins/x/a.js', 'cfg/plugins/y/main.js', '.shown/a.md']) {
      expect(await ask(made, 'luoshu.move', { from: 'a.md', to }), to).toEqual(notGranted)
    }
    // The from end through either junction too
    expect(await ask(made, 'luoshu.move', { from: 'cfg/plugins/x/main.js', to: 'stolen.js' })).toEqual(notGranted)
    expect(await ask(made, 'luoshu.move', { from: '.shown/b.md', to: 'b.md' })).toEqual(notGranted)
    await untouched(made)
  })

  // prepare judged a plain folder. A folder on the way swapped for a junction into a dot folder by perform would land
  // the note there
  it('refuses a move whose to folder became a junction into a dot folder after prepare', async () => {
    const made = opened()
    const call = callOf('luoshu.move', { from: 'a.md', to: 'journal/a.md' })
    const prepared = await made.provider.prepare(call) as Prepared
    await rename(path.join(folder, 'journal'), path.join(folder, 'journal-old'))
    await symlink(path.join(folder, '.obsidian'), path.join(folder, 'journal'), 'junction')
    await expect(made.provider.perform(call, prepared)).rejects.toEqual({ code: 'not-granted' })
    expect(await readdir(path.join(folder, '.obsidian'))).toEqual(['plugins'])
    expect(await exists('a.md')).toBe(true)
  })

  it('makes no folder in a dot folder for a to end below a folder that became a junction into it after prepare', async () => {
    const made = opened()
    const call = callOf('luoshu.move', { from: 'a.md', to: 'journal/new/a.md' })
    const prepared = await made.provider.prepare(call) as Prepared
    await rename(path.join(folder, 'journal'), path.join(folder, 'journal-old'))
    await symlink(path.join(folder, '.obsidian'), path.join(folder, 'journal'), 'junction')
    await expect(made.provider.perform(call, prepared)).rejects.toEqual({ code: 'not-granted' })
    expect(await readdir(path.join(folder, '.obsidian'))).toEqual(['plugins'])
    expect(await exists('a.md')).toBe(true)
  })

  it.each([
    ['at the top', 'a.md', '.a.md'],
    ['in a folder', 'journal/b.md', 'journal/.b.md'],
    ['that also changes case', 'a.md', '.A.md'],
  ])('refuses a rename in place to a dot name %s', async (_name, from, to) => {
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from, to })).toEqual(notGranted)
    await untouched(made)
  })

  it('refuses a remove in a dot folder, of a dot file and through a junction into a dot folder', async () => {
    await symlink(path.join(folder, '.obsidian'), path.join(folder, 'cfg'), 'junction')
    before = await tree()
    const made = opened()
    for (const where of ['.obsidian/plugins/x/main.js', '.OBSIDIAN/plugins/x/main.js', 'journal/.hidden.md', 'cfg/plugins/x/main.js']) {
      expect(await ask(made, 'luoshu.remove', { path: where }), where).toEqual(notGranted)
    }
    await untouched(made)
  })

  // The 8.3 short name Windows made for a name in a folder, as dir /x shows it. null when the volume makes none
  async function shortName(dir: string, name: string): Promise<string | null> {
    const { stdout } = await run('cmd.exe', ['/d', '/c', 'dir', '/x', '/a'], { cwd: dir })
    for (const line of stdout.split(/\r?\n/).map(l => l.trimEnd())) {
      if (!line.endsWith(` ${name}`)) continue
      const short = line.slice(0, -name.length).trimEnd().split(/\s+/).at(-1)
      if (short?.includes('~')) return short
    }
    return null
  }

  it.runIf(onWindows)('refuses a to end named by the 8.3 short name of a dot folder', async ({ skip }) => {
    const short = await shortName(folder, '.obsidian')
    if (short === null) {
      if (process.env.CI) throw new Error('no 8.3 short names on this CI volume, the dot folder\'s short name unproven')
      return skip('this volume makes no 8.3 short names')
    }
    expect(short.startsWith('.')).toBe(false)
    expect(await readFile(path.join(folder, short, 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
    const made = opened()
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: `${short}/a.md` })).toEqual(notGranted)
    expect(await ask(made, 'luoshu.move', { from: 'a.md', to: `${short}/plugins/x/a.js` })).toEqual(notGranted)
    expect(await ask(made, 'luoshu.move', { from: `${short}/plugins/x/main.js`, to: 'stolen.js' })).toEqual(notGranted)
    await untouched(made)
  })
})

describe('the locks of a move', () => {
  it('holds a write to either end until the move performs', async () => {
    const made = opened()
    const move = callOf('luoshu.move', { from: 'a.md', to: 'c.md' })
    const prepared = await made.provider.prepare(move) as Prepared
    const held = { from: false, to: false }
    void made.provider.prepare(callOf('luoshu.write', { path: 'a.md', text: 'x', baseVersion: sha('note a') })).then(() => { held.from = true })
    void made.provider.prepare(callOf('luoshu.write', { path: 'c.md', text: 'x' })).then(() => { held.to = true })
    await tick(50)
    expect(held).toEqual({ from: false, to: false })
    await made.provider.perform(move, prepared)
    await tick(20)
    expect(held).toEqual({ from: true, to: true })
  })

  it('lets go of both when the carrier stops the move after prepare', async () => {
    const made = opened()
    const move = callOf('luoshu.move', { from: 'a.md', to: 'c.md' })
    const prepared = await made.provider.prepare(move) as Prepared
    const held = { from: false, to: false }
    void made.provider.prepare(callOf('luoshu.read', { path: 'a.md' })).then(() => { held.from = true })
    void made.provider.prepare(callOf('luoshu.read', { path: 'c.md' })).then(() => { held.to = true })
    made.provider.release!(move, prepared)
    await tick(20)
    expect(held).toEqual({ from: true, to: true })
  })

  // Taken in call order, a.md to c.md would wait on c.md held by c.md to a.md, which waits on a.md
  it('takes both locks in key order, so two moves the opposite way round never wait on each other', async () => {
    await writeFile(path.join(folder, 'c.md'), 'note c')
    const made = opened()
    // A write holds a.md, so both moves queue behind it before either has run
    const write = callOf('luoshu.write', { path: 'a.md', text: 'one', baseVersion: sha('note a') })
    const written = await made.provider.prepare(write) as Prepared
    const done: string[] = []
    const run = (from: string, to: string) => {
      const call = callOf('luoshu.move', { from, to })
      return made.provider.prepare(call).then(async prepared => {
        if (!('scope' in prepared)) return made.provider.release!(call, { scope: {} })
        await made.provider.perform(call, prepared).then(() => done.push(`${from}>${to}`), () => done.push(`${from}>${to} refused`))
      })
    }
    // One after the other, so a.md to c.md is first in a.md's queue
    const first = run('a.md', 'c.md')
    await tick(200)
    const second = run('c.md', 'a.md')
    await tick(200)
    await made.provider.perform(write, written)
    const both = Promise.all([first, second])
    expect(await Promise.race([both.then(() => 'done'), tick(3000).then(() => 'deadlocked')])).toBe('done')
    // The first finds c.md there and the second finds a.md there, so neither overwrites
    expect(done.sort()).toEqual(['a.md>c.md refused', 'c.md>a.md refused'])
  })
})

describe('the watcher', () => {
  async function watching(): Promise<Opened> {
    const made = opened({ settleMs: 100 })
    await tick(200)
    return made
  }

  it('publishes nothing outside for its own remove and move, then hears an outside change after them', async () => {
    const made = await watching()
    try {
      expect(await ask(made, 'luoshu.remove', { path: 'a.md', baseVersion: sha('note a') })).toBeNull()
      expect(await ask(made, 'luoshu.move', { from: 'journal/b.md', to: 'b.md' })).toBeNull()
      await tick(600)
      expect(made.heard.filter(([topic]) => topic === 'outside')).toEqual([])
      await writeFile(path.join(folder, 'b.md'), 'from obsidian')
      for (let waited = 0; !made.heard.some(([topic]) => topic === 'outside'); waited += 25) {
        if (waited > 5000) throw new Error('nothing arrived in time')
        await tick(25)
      }
      expect(made.heard.filter(([topic]) => topic === 'outside')).toEqual([['outside', 'b.md']])
    } finally {
      made.close()
    }
  })
})
