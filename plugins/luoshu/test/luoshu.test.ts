import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from 'hetu-core/api/envelope.ts'
import type { Call, Prepared } from 'hetu-core/api/slots.ts'
import { createLuoshu, type Luoshu } from '../src/luoshu.ts'

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
  it('answers the text and the hash of its bytes', async () => {
    expect(await ask(opened(), 'luoshu.read', { path: 'journal/b.md' })).toEqual({ text: 'note b', version: sha('note b') })
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
})

describe('the lock from prepare to perform', () => {
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

  it('is one lock for every spelling of one name', async ({ skip }) => {
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

  it.runIf(onWindows)('refuses .git through its 8.3 short name', async ({ skip }) => {
    const { stdout } = await run('cmd.exe', ['/d', '/c', 'dir', '/x', '/a'], { cwd: folder })
    const line = stdout.split(/\r?\n/).map(l => l.trimEnd()).find(l => l.endsWith(' .git'))
    const short = line?.slice(0, -' .git'.length).trimEnd().split(/\s+/).at(-1)
    if (short === undefined || !short.includes('~')) {
      if (process.env.CI) throw new Error('no 8.3 short names on this CI volume, GIT~1 unproven')
      return skip('this volume makes no 8.3 short names')
    }
    expect(await readFile(path.join(folder, short, 'config'), 'utf8')).toBe('[core]\n')
    expect(await ask(opened(), 'luoshu.read', { path: `${short}/config` })).toEqual({ refused: { code: 'not-granted' } })
  })
})
