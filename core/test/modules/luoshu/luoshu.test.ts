import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from '../../../api/envelope.ts'
import type { Call, Prepared } from '../../../api/policy-jobs.ts'
import { createLuoshu, type Luoshu } from '../../../backend/providers/luoshu/luoshu.ts'

const run = promisify(execFile)
const onWindows = process.platform === 'win32'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const caller: Caller = { kind: 'window', role: 'editor', n: 0 }

let base: string
let folder: string
let n = 0

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-luoshu-')))
  folder = path.join(base, 'notes')
  // hetu's own folders exist wherever it runs. One that can't be resolved refuses every path
  await mkdir(path.join(base, 'data'))
  await mkdir(path.join(base, 'install'))
  await mkdir(path.join(folder, '.git'), { recursive: true })
  await writeFile(path.join(folder, '.git', 'config'), '[core]\n')
  await mkdir(path.join(folder, 'journal'), { recursive: true })
  await writeFile(path.join(folder, 'a.md'), 'note a')
  await writeFile(path.join(folder, 'journal', 'b.md'), 'note b')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

function opened(options: Parameters<typeof createLuoshu>[0] = {}): Luoshu & { heard: [string, string][] } {
  const heard: [string, string][] = []
  const made = createLuoshu({ publish: (topic, at) => heard.push([topic, at]), ...options })
  made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
  return Object.assign(made, { heard })
}

// A listing carries the carrier's canList, every name allowed unless a test says otherwise
const callOf = (action: string, args: unknown, canList: ((path: string) => boolean) | null = () => true): Call => ({
  callId: `c${++n}`, caller, action, args, deadline: Date.now() + 30000,
  ...(action === 'luoshu.list' && canList !== null ? { canList } : {}),
})

// prepare then perform, as the carrier makes a call. A refusal from either comes back as the value thrown or given
async function ask(made: Luoshu, action: string, args: unknown, canList?: ((path: string) => boolean) | null): Promise<unknown> {
  const call = callOf(action, args, canList)
  const prepared = await made.provider.prepare(call)
  if (!('scope' in prepared)) return { refused: prepared }
  try {
    return await made.provider.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  }
}

describe('with no folder picked', () => {
  it('answers unavailable for every call', async () => {
    const made = createLuoshu()
    for (const [action, args] of [['luoshu.read', { path: 'a.md' }], ['luoshu.write', { path: 'a.md', text: 'x' }], ['luoshu.list', {}]] as const) {
      expect(await ask(made, action, args)).toEqual({ refused: { code: 'unavailable' } })
    }
    made.role.open({ folder: null, dataDir: base, installDir: base })
    expect(await ask(made, 'luoshu.read', { path: 'a.md' })).toEqual({ refused: { code: 'unavailable' } })
  })
})

describe('reading', () => {
  it('answers the text, the hash of its bytes and the path it read', async () => {
    expect(await ask(opened(), 'luoshu.read', { path: 'journal/b.md' })).toEqual({ text: 'note b', version: sha('note b'), path: 'journal/b.md' })
  })

  // The path the gate judged, so the editor window names the note by where it is whatever the caller spelled
  it('answers the canonical path for another spelling of the note', async () => {
    const answered = await ask(opened(), 'luoshu.read', { path: 'Journal/B.md' }) as { path: string }
    expect(answered.path).toBe(onWindows || process.platform === 'darwin' ? 'journal/b.md' : 'Journal/B.md')
  })

  it('scopes the call to the canonical path the gate judges', async () => {
    const made = opened()
    const prepared = await made.provider.prepare(callOf('luoshu.read', { path: 'Journal/B.md' }))
    expect((prepared as Prepared).scope.paths).toEqual([onWindows || process.platform === 'darwin' ? 'journal/b.md' : 'Journal/B.md'])
  })

  it('answers not-found for a note that isn\'t there and for a folder', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.read', { path: 'missing.md' })).toEqual({ refused: { code: 'not-found' } })
    expect(await ask(made, 'luoshu.read', { path: 'journal' })).toEqual({ refused: { code: 'not-found' } })
  })

  // A read opens the note once and checks it through that handle, without waiting for a FIFO's writer
  it.skipIf(onWindows)('answers not-found at once for a FIFO under a note\'s name', async () => {
    await run('mkfifo', [path.join(folder, 'pipe.md')])
    expect(await ask(opened(), 'luoshu.read', { path: 'pipe.md' })).toEqual({ refused: { code: 'not-found' } })
  }, 3000)
})

describe('writing', () => {
  it('creates a note with no baseVersion, with the folders it needs, and keeps the bytes as sent', async () => {
    const made = opened()
    const text = 'line one\r\nline two\n'
    expect(await ask(made, 'luoshu.write', { path: 'projects/new/plan.md', text })).toEqual({ version: sha(text) })
    expect(await readFile(path.join(folder, 'projects', 'new', 'plan.md'), 'utf8')).toBe(text)
    expect(made.heard).toEqual([['changed', 'projects/new/plan.md']])
  })

  it('writes over a note read at the version it holds and refuses a stale one', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.write', { path: 'a.md', text: 'two', baseVersion: sha('note a') })).toEqual({ version: sha('two') })
    expect(await ask(made, 'luoshu.write', { path: 'a.md', text: 'three', baseVersion: sha('note a') })).toEqual({ refused: { code: 'stale' } })
    expect(await ask(made, 'luoshu.write', { path: 'a.md', text: 'three' })).toEqual({ refused: { code: 'stale' } })
    expect(await ask(made, 'luoshu.write', { path: 'new.md', text: 'x', baseVersion: sha('note a') })).toEqual({ refused: { code: 'stale' } })
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('two')
  })

  it('leaves no temp file behind', async () => {
    const made = opened()
    await ask(made, 'luoshu.write', { path: 'journal/b.md', text: 'again', baseVersion: sha('note b') })
    expect((await readdir(path.join(folder, 'journal'))).sort()).toEqual(['b.md'])
  })

  // A hard link with a plain name to a dot file still reads as the dot file. A write goes to a temp file and a rename,
  // which replaces the plain name only, so the dot file keeps its bytes
  it('replaces only the plain name of a hard link to a dot file and leaves the dot file as it was', async () => {
    await mkdir(path.join(folder, '.obsidian', 'plugins', 'x'), { recursive: true })
    await writeFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
    await link(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), path.join(folder, 'journal', 'alias.md'))
    const made = opened()
    expect(await ask(made, 'luoshu.write', { path: 'journal/alias.md', text: 'planted', baseVersion: sha('plugin code') })).toEqual({ version: sha('planted') })
    expect(await readFile(path.join(folder, 'journal', 'alias.md'), 'utf8')).toBe('planted')
    expect(await readFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
  })
})

describe('the latch from prepare to perform', () => {
  it('holds a second call on the same note until the first one performs, and none on another note', async () => {
    const made = opened()
    const first = callOf('luoshu.write', { path: 'a.md', text: 'one', baseVersion: sha('note a') })
    const prepared = await made.provider.prepare(first)
    let second = false
    let other = false
    void made.provider.prepare(callOf('luoshu.read', { path: 'a.md' })).then(() => { second = true })
    void made.provider.prepare(callOf('luoshu.read', { path: 'journal/b.md' })).then(() => { other = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(second).toBe(false)
    expect(other).toBe(true)
    await made.provider.perform(first, prepared as Prepared)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(second).toBe(true)
  })

  it('lets go when the carrier stops the call after prepare', async () => {
    const made = opened()
    const first = callOf('luoshu.write', { path: 'a.md', text: 'one' })
    const prepared = await made.provider.prepare(first)
    let second = false
    void made.provider.prepare(callOf('luoshu.read', { path: 'a.md' })).then(() => { second = true })
    made.provider.release!(first, prepared as Prepared)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(second).toBe(true)
  })

  it('is one latch for every spelling of one name', async ({ skip }) => {
    if (!onWindows && process.platform !== 'darwin') return skip('names differ by case only where the disk folds case')
    const made = opened()
    const first = callOf('luoshu.write', { path: 'a.md', text: 'one' })
    await made.provider.prepare(first)
    let second = false
    void made.provider.prepare(callOf('luoshu.read', { path: 'A.MD' })).then(() => { second = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(second).toBe(false)
  })
})

describe('listing', () => {
  it('answers every file in name order, past .git and the dot temp files a write makes', async () => {
    await writeFile(path.join(folder, 'journal', '.c.md.1234.hetu-tmp'), 'half')
    expect(await ask(opened(), 'luoshu.list', {})).toEqual({ paths: ['a.md', 'journal/b.md'], next: null })
  })

  it('answers a page at a time, then the rest after the last name', async () => {
    for (const name of ['c.md', 'd.md', 'e.md']) await writeFile(path.join(folder, name), name)
    const made = opened({ pageSize: 2 })
    expect(await ask(made, 'luoshu.list', {})).toEqual({ paths: ['a.md', 'c.md'], next: 'c.md' })
    expect(await ask(made, 'luoshu.list', { after: 'c.md' })).toEqual({ paths: ['d.md', 'e.md'], next: 'e.md' })
    expect(await ask(made, 'luoshu.list', { after: 'e.md' })).toEqual({ paths: ['journal/b.md'], next: null })
  })

  // canList lets every name through with the gate off by the human, so the walk itself leaves dot names out
  it('names no dot file and nothing under a dot folder at any depth, with every name allowed as the gate off allows', async () => {
    const dotted: [string, string][] = [
      ['.obsidian/app.json', '{}'],
      ['.obsidian/plugins/x/main.js', 'plugin code'],
      ['.github/workflows/x.yml', 'on: push'],
      ['.hidden.md', 'hidden'],
      ['journal/.todo.md', 'todo'],
      ['journal/deep/.scratch.md', 'scratch'],
      ['journal/deep/.config/inner/x.md', 'x'],
      ['journal/deep/.config/y.md', 'y'],
      ['\ufeff.bom.md', 'behind a code point HFS+ skips'],
      ['\u200c.config/z.md', 'z'],
      ['journal/c.md', 'c'],
      ['journal/deep/d.md', 'd'],
    ]
    for (const [relative, text] of dotted) {
      await mkdir(path.dirname(path.join(folder, relative)), { recursive: true })
      await writeFile(path.join(folder, relative), text)
    }
    const made = opened({ pageSize: 2 })
    expect(await ask(made, 'luoshu.list', {})).toEqual({ paths: ['a.md', 'journal/b.md'], next: 'journal/b.md' })
    expect(await ask(made, 'luoshu.list', { after: 'journal/b.md' })).toEqual({ paths: ['journal/c.md', 'journal/deep/d.md'], next: null })
    expect(await ask(made, 'luoshu.list', { folder: 'journal/deep' })).toEqual({ paths: ['journal/deep/d.md'], next: null })
    // The folders themselves are refused by canonical before any walk
    for (const at of ['.obsidian', 'journal/deep/.config', '\u200c.config']) {
      expect(await ask(made, 'luoshu.list', { folder: at })).toEqual({ refused: { code: 'not-granted' } })
    }
  })

  it('pages over only the names canList allows, so next never names one the caller can’t list', async () => {
    for (let i = 0; i < 30; i++) await writeFile(path.join(folder, 'journal', `hidden-${String(i).padStart(2, '0')}.md`), 'x')
    for (const name of ['p1.md', 'p2.md', 'p3.md']) await writeFile(path.join(folder, 'journal', name), name)
    const shown = (at: string) => !at.includes('hidden-')
    const made = opened({ pageSize: 2 })
    expect(await ask(made, 'luoshu.list', { folder: 'journal' }, shown)).toEqual({ paths: ['journal/b.md', 'journal/p1.md'], next: 'journal/p1.md' })
    expect(await ask(made, 'luoshu.list', { folder: 'journal', after: 'journal/p1.md' }, shown)).toEqual({ paths: ['journal/p2.md', 'journal/p3.md'], next: null })
    // A folder holding only names the caller can't list answers as a folder that isn't there
    expect(await ask(made, 'luoshu.list', { folder: 'journal' }, () => false)).toEqual({ paths: [], next: null })
    expect(await ask(made, 'luoshu.list', { folder: 'missing' }, () => false)).toEqual({ paths: [], next: null })
  })

  it('refuses a listing that comes without the carrier’s canList', async () => {
    expect(await ask(opened(), 'luoshu.list', {}, null)).toEqual({ refused: { code: 'failed' } })
  })

  it('lists under one folder, and nothing under one that isn\'t there', async () => {
    const made = opened()
    expect(await ask(made, 'luoshu.list', { folder: 'journal' })).toEqual({ paths: ['journal/b.md'], next: null })
    expect(await ask(made, 'luoshu.list', { folder: 'missing' })).toEqual({ paths: [], next: null })
  })

  it.runIf(onWindows || process.platform === 'darwin')('leaves out hetu’s data folder spelled in another case', async () => {
    const inside = path.join(folder, 'hetu-data')
    await mkdir(inside)
    await writeFile(path.join(inside, 'key-api_token'), 'secret')
    const made = createLuoshu()
    made.role.open({ folder, dataDir: path.join(folder, 'HETU-DATA'), installDir: path.join(base, 'install') })
    expect(await ask(made, 'luoshu.list', {})).toEqual({ paths: ['a.md', 'journal/b.md'], next: null })
  })

  it('leaves out hetu\'s own folders and follows no link or junction', async () => {
    await mkdir(path.join(base, 'outside'))
    await writeFile(path.join(base, 'outside', 'secret.md'), 'secret')
    await symlink(path.join(base, 'outside'), path.join(folder, 'linked'), 'junction')
    const inside = path.join(folder, 'hetu-data')
    await mkdir(inside)
    await writeFile(path.join(inside, 'switches.json'), '{}')
    const made = createLuoshu()
    made.role.open({ folder, dataDir: inside, installDir: path.join(base, 'install') })
    expect(await ask(made, 'luoshu.list', {})).toEqual({ paths: ['a.md', 'journal/b.md'], next: null })
  })
})

describe('a folder change while calls are in flight', () => {
  it('refuses a write or a listing prepared under the folder before, so neither acts on the old one', async () => {
    const made = opened()
    const write = callOf('luoshu.write', { path: 'a.md', text: 'late', baseVersion: sha('note a') })
    const writing = await made.provider.prepare(write)
    const list = callOf('luoshu.list', { folder: 'journal' })
    const listing = await made.provider.prepare(list)
    const other = path.join(base, 'other')
    await mkdir(other)
    made.role.open({ folder: other, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
    await expect(made.provider.perform(write, writing as Prepared)).rejects.toEqual({ code: 'unavailable' })
    await expect(made.provider.perform(list, listing as Prepared)).rejects.toEqual({ code: 'unavailable' })
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('note a')
  })
})

// prepare judged a plain folder. One swapped for a junction into a dot folder by perform would hand a read the dot file
// or land a write there, as remove and move already refuse
describe('a folder swapped for a junction after prepare', () => {
  beforeEach(async () => {
    await mkdir(path.join(folder, '.obsidian', 'plugins', 'x'), { recursive: true })
    await writeFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
    await writeFile(path.join(folder, 'journal', 'main.js'), 'plain')
  })

  async function swapped(action: string, args: unknown): Promise<unknown> {
    const made = opened()
    const call = callOf(action, args)
    const prepared = await made.provider.prepare(call) as Prepared
    await rename(path.join(folder, 'journal'), path.join(folder, 'journal-was'))
    await symlink(path.join(folder, '.obsidian', 'plugins', 'x'), path.join(folder, 'journal'), 'junction')
    return made.provider.perform(call, prepared).catch(err => ({ refused: err }))
  }

  it('refuses a read and reads nothing from the dot folder', async () => {
    expect(await swapped('luoshu.read', { path: 'journal/main.js' })).toEqual({ refused: { code: 'not-granted' } })
  })

  it('refuses a write of a new note and writes nothing into the dot folder', async () => {
    expect(await swapped('luoshu.write', { path: 'journal/planted.js', text: 'planted' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await readdir(path.join(folder, '.obsidian', 'plugins', 'x'))).toEqual(['main.js'])
  })

  // The note's own folder isn't there yet, so the swapped folder is the one above it
  it('refuses a write into a new folder under the swapped one and makes no folder in the dot folder', async () => {
    expect(await swapped('luoshu.write', { path: 'journal/new/deeper/planted.js', text: 'planted' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await readdir(path.join(folder, '.obsidian', 'plugins', 'x'))).toEqual(['main.js'])
  })

  it('refuses a write over a note there at its version and leaves the dot file as it was', async () => {
    expect(await swapped('luoshu.write', { path: 'journal/main.js', text: 'planted', baseVersion: sha('plugin code') })).toEqual({ refused: { code: 'not-granted' } })
    expect(await readdir(path.join(folder, '.obsidian', 'plugins', 'x'))).toEqual(['main.js'])
    expect(await readFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
  })

  it('refuses a listing of the swapped folder and names nothing in the dot folder', async () => {
    expect(await swapped('luoshu.list', { folder: 'journal' })).toEqual({ refused: { code: 'not-granted' } })
  })

  it('refuses a listing of a folder missing at prepare and a junction into a dot folder by perform', async () => {
    const made = opened()
    const call = callOf('luoshu.list', { folder: 'later' })
    const prepared = await made.provider.prepare(call) as Prepared
    await symlink(path.join(folder, '.obsidian', 'plugins', 'x'), path.join(folder, 'later'), 'junction')
    await expect(made.provider.perform(call, prepared)).rejects.toEqual({ code: 'not-granted' })
  })

  it('answers an empty page for a listing whose folder is gone since prepare', async () => {
    const made = opened()
    const call = callOf('luoshu.list', { folder: 'journal' })
    const prepared = await made.provider.prepare(call) as Prepared
    await rename(path.join(folder, 'journal'), path.join(folder, 'journal-was'))
    expect(await made.provider.perform(call, prepared)).toEqual({ paths: [], next: null })
  })

  // The caller's spelling looked at again leads to another folder, whose key isn't the one prepare took
  it('refuses a read whose folder became a junction into another plain folder', async () => {
    const made = opened()
    const call = callOf('luoshu.read', { path: 'journal/b.md' })
    const prepared = await made.provider.prepare(call) as Prepared
    await rename(path.join(folder, 'journal'), path.join(folder, 'journal-was'))
    await symlink(path.join(folder, 'journal-was'), path.join(folder, 'journal'), 'junction')
    await expect(made.provider.perform(call, prepared)).rejects.toEqual({ code: 'not-granted' })
  })

  // A folder gone since prepare holds no note, so the read answers as for any missing one
  it('answers not-found for a read whose folder is gone since prepare', async () => {
    const made = opened()
    const call = callOf('luoshu.read', { path: 'journal/b.md' })
    const prepared = await made.provider.prepare(call) as Prepared
    await rename(path.join(folder, 'journal'), path.join(folder, 'journal-was'))
    await expect(made.provider.perform(call, prepared)).rejects.toEqual({ code: 'not-found' })
  })
})

// The look at the folder before the act finds another spelling of the one prepare resolved. The caller's spelling
// resolved again gives the key prepare took and another path, so the call asks the gate again through its judge and
// goes on when the judge allows the new path
describe.runIf(onWindows || process.platform === 'darwin')('a folder whose name differs only in case from the one prepare resolved', () => {
  // A folder renamed back and forth under the luoshu's watch, which can hold it open for a moment on Windows
  const renamed = async (from: string, to: string) => {
    for (let wait = 10; ; wait *= 2) {
      try {
        return await rename(from, to)
      } catch (err) {
        if (!['EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '') || wait > 1280) throw err
        await new Promise(resolve => setTimeout(resolve, wait))
      }
    }
  }

  // A call whose judge answers as given, null as the gate does for a caller granted every path, keeping each ask
  const judging = (call: Call, asked: string[][], answer: { code: 'not-granted' } | null = null): Call => ({
    ...call,
    judge: (paths: readonly string[]) => {
      asked.push([...paths])
      return answer
    },
  })

  it('writes two notes sent together into one new folder spelled in two cases', async () => {
    const made = opened()
    const asked: string[][] = []
    const first = judging(callOf('luoshu.write', { path: 'Inbox/a.md', text: 'a' }), asked)
    const second = judging(callOf('luoshu.write', { path: 'inbox/b.md', text: 'b' }), asked)
    const [one, two] = [await made.provider.prepare(first), await made.provider.prepare(second)]
    expect(await made.provider.perform(first, one as Prepared)).toEqual({ version: sha('a') })
    expect(await made.provider.perform(second, two as Prepared)).toEqual({ version: sha('b') })
    expect(asked).toEqual([['Inbox/b.md']])
    expect((await readdir(folder)).filter(name => name.toLowerCase() === 'inbox')).toEqual(['Inbox'])
    expect((await readdir(path.join(folder, 'Inbox'))).sort()).toEqual(['a.md', 'b.md'])
  })

  it('reads and lists a note whose folder another program renamed in case since prepare', async () => {
    const made = opened()
    const asked: string[][] = []
    const read = judging(callOf('luoshu.read', { path: 'journal/b.md' }), asked)
    const list = judging(callOf('luoshu.list', { folder: 'journal' }), asked)
    const [reading, listing] = [await made.provider.prepare(read), await made.provider.prepare(list)]
    await rename(path.join(folder, 'journal'), path.join(folder, 'Journal'))
    expect(await made.provider.perform(read, reading as Prepared)).toEqual({ text: 'note b', version: sha('note b'), path: 'Journal/b.md' })
    // A listing's folder is never judged again, since canList judges each name it gives
    expect(await made.provider.perform(list, listing as Prepared)).toEqual({ paths: ['Journal/b.md'], next: null })
    expect(asked).toEqual([['Journal/b.md']])
  })

  it('moves a note out of and into a folder another program renamed in case since prepare', async () => {
    const made = opened()
    const asked: string[][] = []
    const out = judging(callOf('luoshu.move', { from: 'journal/b.md', to: 'b.md' }), asked)
    const into = judging(callOf('luoshu.move', { from: 'a.md', to: 'journal/a.md' }), asked)
    const [leaving, entering] = [await made.provider.prepare(out), await made.provider.prepare(into)]
    await rename(path.join(folder, 'journal'), path.join(folder, 'Journal'))
    expect(await made.provider.perform(out, leaving as Prepared)).toBeNull()
    expect(await made.provider.perform(into, entering as Prepared)).toBeNull()
    expect(asked).toEqual([['Journal/b.md', 'b.md'], ['a.md', 'Journal/a.md']])
    expect(await readFile(path.join(folder, 'b.md'), 'utf8')).toBe('note b')
    expect(await readdir(path.join(folder, 'Journal'))).toEqual(['a.md'])
  })

  it('refuses a read, a write, a remove and both ends of a move with no judge on the call or a judge that refuses the new path', async () => {
    const made = createLuoshu()
    made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install'), trash: async () => {} })
    await writeFile(path.join(folder, 'journal', 'c.md'), 'note c')
    const tries: [string, unknown][] = [
      ['luoshu.read', { path: 'journal/b.md' }],
      ['luoshu.write', { path: 'journal/new.md', text: 'x' }],
      ['luoshu.remove', { path: 'journal/c.md', baseVersion: sha('note c') }],
      ['luoshu.move', { from: 'journal/b.md', to: 'out.md' }],
      ['luoshu.move', { from: 'a.md', to: 'journal/in.md' }],
    ]
    for (const judge of ['none', 'refusing'] as const) {
      for (const [action, args] of tries) {
        const asked: string[][] = []
        const plain = callOf(action, args)
        const call = judge === 'none' ? plain : judging(plain, asked, { code: 'not-granted' })
        const prepared = await made.provider.prepare(call)
        await renamed(path.join(folder, 'journal'), path.join(folder, 'Journal'))
        await expect(made.provider.perform(call, prepared as Prepared), `${judge} ${action}`).rejects.toEqual({ code: 'not-granted' })
        await renamed(path.join(folder, 'Journal'), path.join(folder, 'journal'))
        expect(asked).toHaveLength(judge === 'none' ? 0 : 1)
      }
    }
    made.close()
    expect((await readdir(path.join(folder, 'journal'))).sort()).toEqual(['b.md', 'c.md'])
    expect((await readdir(folder)).sort()).toEqual(['.git', 'a.md', 'journal'])
  })

  // The note's own folder is gone under the renamed one, so the look at the path resolved again finds it gone
  it('refuses a move from a folder gone under one renamed in case, as from any gone folder', async () => {
    const made = opened()
    const call = callOf('luoshu.move', { from: 'journal/sub/x.md', to: 'y.md' })
    const prepared = await made.provider.prepare(call)
    await rename(path.join(folder, 'journal'), path.join(folder, 'Journal'))
    await expect(made.provider.perform(call, prepared as Prepared)).rejects.toEqual({ code: 'not-granted' })
  })
})

describe('a note too large to answer', () => {
  it('is refused failed and too-large from its size, before it is read', async () => {
    await writeFile(path.join(folder, 'big.md'), 'x'.repeat(2048))
    expect(await ask(opened({ readCap: 1024 }), 'luoshu.read', { path: 'big.md' })).toEqual({ refused: { code: 'failed', reason: 'too-large' } })
    expect(await ask(opened({ readCap: 1024 }), 'luoshu.read', { path: 'a.md' })).toEqual({ text: 'note a', version: sha('note a'), path: 'a.md' })
  })
})

describe('the spellings threat-model row 3 found', () => {
  it.each([
    ['.git by name', '.git/config', 'not-granted'],
    ['.git in another case', '.GIT/config', 'not-granted'],
    ['a parent step', '../outside.md', 'invalid'],
    ['an absolute path', onWindows ? 'C:/notes/a.md' : '/notes/a.md', 'invalid'],
    ['a stream name', 'a.md::$DATA', 'invalid'],
    ['.git as its folder stream', '.git::$INDEX_ALLOCATION/config', 'invalid'],
    ['a device', 'journal/con.md', 'invalid'],
  ])('refuses %s', async (_name, spelled, code) => {
    const made = opened()
    expect(await ask(made, 'luoshu.read', { path: spelled })).toEqual({ refused: { code } })
    expect(await ask(made, 'luoshu.write', { path: spelled, text: 'x' })).toEqual({ refused: { code } })
  })

  it('refuses a link or junction out of the folder', async () => {
    await mkdir(path.join(base, 'outside'))
    await writeFile(path.join(base, 'outside', 'secret.md'), 'secret')
    await symlink(path.join(base, 'outside'), path.join(folder, 'linked'), 'junction')
    const made = opened()
    expect(await ask(made, 'luoshu.read', { path: 'linked/secret.md' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await ask(made, 'luoshu.write', { path: 'linked/new.md', text: 'x' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await ask(made, 'luoshu.list', { folder: 'linked' })).toEqual({ refused: { code: 'not-granted' } })
  })

  it('refuses hetu\'s data and install folders inside the luoshu', async () => {
    const made = createLuoshu()
    await mkdir(path.join(folder, 'data', 'state'), { recursive: true })
    await mkdir(path.join(folder, 'install'))
    made.role.open({ folder, dataDir: path.join(folder, 'data'), installDir: path.join(folder, 'install') })
    expect(await ask(made, 'luoshu.write', { path: 'data/state/switches.json', text: '{}' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await ask(made, 'luoshu.read', { path: 'install/install.json' })).toEqual({ refused: { code: 'not-granted' } })
  })

  // Spelled with no dot, so it answers as a missing note, which aliases.test.ts compares action by action
  it.runIf(onWindows)('answers .git through its 8.3 short name as a missing note', async ({ skip }) => {
    const { stdout } = await run('cmd.exe', ['/d', '/c', 'dir', '/x', '/a'], { cwd: folder })
    const line = stdout.split(/\r?\n/).map(l => l.trimEnd()).find(l => l.endsWith(' .git'))
    const short = line?.slice(0, -' .git'.length).trimEnd().split(/\s+/).at(-1)
    if (short === undefined || !short.includes('~')) {
      if (process.env.CI) throw new Error('no 8.3 short names on this CI volume, GIT~1 unproven')
      return skip('this volume makes no 8.3 short names')
    }
    expect(await readFile(path.join(folder, short, 'config'), 'utf8')).toBe('[core]\n')
    expect(await ask(opened(), 'luoshu.read', { path: `${short}/config` })).toEqual({ refused: { code: 'not-found' } })
    expect(await ask(opened(), 'luoshu.write', { path: `${short}/config`, text: 'x' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await readFile(path.join(folder, '.git', 'config'), 'utf8')).toBe('[core]\n')
  })
})
