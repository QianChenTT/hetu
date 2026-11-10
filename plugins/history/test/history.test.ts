import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findProgram } from 'hetu-core/lib/clean-env.ts'
import { createHistory } from '../src/history.ts'
import { ask, callOf, cleanup, commitOf, editor, git, logOf, place, started, type Place } from './helpers.ts'

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const onWindows = process.platform === 'win32'
const exists = (file: string) => stat(file).then(() => true, () => false)
const note = (where: Place, name: string, content: string | Buffer) => writeFile(path.join(where.notes, ...name.split('/')), content)

let where: Place

beforeEach(async () => {
  where = await place()
  await mkdir(path.join(where.notes, 'journal'))
  await note(where, 'a.md', 'note a')
  await note(where, 'journal/b.md', 'note b')
})

afterEach(cleanup)

describe('before it can serve', () => {
  it('answers unavailable until it has started and a notes folder is picked', async () => {
    const history = createHistory()
    expect(await ask(history, 'history.log', { path: 'a.md' })).toEqual({ refused: { code: 'unavailable' } })
    await history.start(where.dataDir)
    expect(await ask(history, 'history.log', { path: 'a.md' })).toEqual({ refused: { code: 'unavailable' } })
    history.role.open({ folder: null, dataDir: where.dataDir, installDir: where.installDir })
    expect(await ask(history, 'history.commit', { paths: ['a.md'], message: 'x' })).toEqual({ refused: { code: 'unavailable' } })
    history.role.open({ folder: where.notes, dataDir: where.dataDir, installDir: where.installDir })
    expect(await ask(history, 'history.log', { path: 'a.md' })).toEqual({ commits: [] })
  })

  it('throws at start with no git on the path, so it reads as failed, and never takes one inside the data folder', async () => {
    await expect(createHistory({ path: '' }).start(where.dataDir)).rejects.toThrow(/git/)
    await expect(createHistory({ path: where.notes }).start(where.dataDir)).rejects.toThrow(/git/)
    const real = await findProgram('git', { path: process.env.PATH, outside: [] })
    expect(real).not.toBeNull()
    // The whole of the real git's folder taken as the data folder: every git on that path lies inside it
    await expect(createHistory({ path: path.dirname(real!) }).start(path.dirname(real!))).rejects.toThrow(/git/)
  })

  it('answers unavailable when the only git lies inside the notes folder picked', async () => {
    const real = (await findProgram('git', { path: process.env.PATH, outside: [] }))!
    const history = createHistory({ path: path.dirname(real) })
    await history.start(where.dataDir)
    history.role.open({ folder: path.dirname(real), dataDir: where.dataDir, installDir: where.installDir })
    expect(await ask(history, 'history.log', { path: 'a.md' })).toEqual({ refused: { code: 'unavailable' } })
  })
})

describe('a commit', () => {
  it('records a note as it is now, lists it and reads it back with the hash of its bytes', async () => {
    const history = await started(where)
    const commit = await commitOf(history, ['a.md'], 'first save')
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    const log = await logOf(history, 'a.md')
    expect(log).toEqual([{ commit, author: 'git', committer: 'git', date: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/), message: 'first save' }])
    expect(await ask(history, 'history.read', { path: 'a.md', commit })).toEqual({ text: 'note a', version: sha256('note a') })
  })

  it('answers null and writes nothing when the notes hold nothing the last commit doesn\'t', async () => {
    const history = await started(where)
    const first = await commitOf(history, ['a.md'])
    expect(await commitOf(history, ['a.md'], 'again')).toBeNull()
    expect((await logOf(history, 'a.md')).map(entry => entry.commit)).toEqual([first])
  })

  it('lists a note\'s commits newest first, only those that changed it, and keeps every old version readable', async () => {
    const history = await started(where)
    const first = await commitOf(history, ['a.md', 'journal/b.md'], 'both')
    await note(where, 'a.md', 'note a, edited')
    const second = await commitOf(history, ['a.md'], 'a again')
    await note(where, 'journal/b.md', 'note b, edited')
    const third = await commitOf(history, ['journal/b.md'], 'b again')
    expect((await logOf(history, 'a.md')).map(entry => [entry.commit, entry.message])).toEqual([[second, 'a again'], [first, 'both']])
    expect((await logOf(history, 'journal/b.md')).map(entry => entry.commit)).toEqual([third, first])
    expect((await logOf(history, 'a.md', 1)).map(entry => entry.commit)).toEqual([second])
    expect(await ask(history, 'history.read', { path: 'a.md', commit: first })).toMatchObject({ text: 'note a' })
    expect(await ask(history, 'history.read', { path: 'a.md', commit: third })).toMatchObject({ text: 'note a, edited' })
  })

  it('records a note that is gone as removed, and one never there as nothing', async () => {
    const history = await started(where)
    const first = await commitOf(history, ['a.md'])
    await rm(path.join(where.notes, 'a.md'))
    const second = await commitOf(history, ['a.md'], 'removed')
    expect(second).toMatch(/^[0-9a-f]{40}$/)
    expect(await ask(history, 'history.read', { path: 'a.md', commit: second })).toEqual({ refused: { code: 'not-found' } })
    expect(await ask(history, 'history.read', { path: 'a.md', commit: first })).toMatchObject({ text: 'note a' })
    expect(await commitOf(history, ['never.md'], 'nothing')).toBeNull()
  })

  it('stores the bytes exactly, whatever line endings, marks or attribute files the notes folder holds', async () => {
    const history = await started(where)
    await note(where, '.gitattributes', '* text eol=crlf working-tree-encoding=UTF-16 filter=plant ident\n')
    await note(where, '.gitignore', '*\n')
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line one\r\nline two\n$Id$\n')])
    await note(where, 'endings.md', bytes)
    const commit = await commitOf(history, ['endings.md'])
    const read = await ask(history, 'history.read', { path: 'endings.md', commit }) as { text: string, version: string }
    expect(read.version).toBe(sha256(bytes))
    expect(Buffer.from(read.text, 'utf8').equals(bytes)).toBe(true)
  })

  it('stores a file that isn\'t text exactly and refuses to read it back as text', async () => {
    const history = await started(where)
    await note(where, 'image.bin', Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]))
    const commit = await commitOf(history, ['image.bin'])
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    expect(await ask(history, 'history.read', { path: 'image.bin', commit })).toEqual({ refused: { code: 'failed', reason: 'not-text' } })
  })

  it('refuses a file over the cap and commits none of the call', async () => {
    const history = await started(where, { fileBytes: 64 })
    await note(where, 'big.md', 'x'.repeat(65))
    expect(await ask(history, 'history.commit', { paths: ['a.md', 'big.md'], message: 'x' })).toEqual({ refused: { code: 'failed', reason: 'too-large' } })
    expect(await logOf(history, 'a.md')).toEqual([])
    expect(await commitOf(history, ['a.md'])).toMatch(/^[0-9a-f]{40}$/)
  })

  // Each note under the file cap, all of them together past the commit's
  it('refuses a commit whose notes together are past the cap on one commit, and commits none of it', async () => {
    const history = await started(where, { fileBytes: 64, commitBytes: 100 })
    await note(where, 'one.md', 'x'.repeat(60))
    await note(where, 'two.md', 'y'.repeat(60))
    expect(await ask(history, 'history.commit', { paths: ['one.md', 'two.md'], message: 'x' })).toEqual({ refused: { code: 'failed', reason: 'too-large' } })
    expect(await logOf(history, 'one.md')).toEqual([])
    expect(await commitOf(history, ['one.md'])).toMatch(/^[0-9a-f]{40}$/)
  })

  it('matches a path as it is written, so a name with a bracket lists only its own commits', async () => {
    const history = await started(where)
    await note(where, 'b.md', 'note b')
    await note(where, '[ab].md', 'a note whose name is a pattern')
    const plain = await commitOf(history, ['a.md', 'b.md'], 'plain names')
    const bracket = await commitOf(history, ['[ab].md'], 'the bracket name')
    expect((await logOf(history, '[ab].md')).map(entry => entry.commit)).toEqual([bracket])
    expect((await logOf(history, 'a.md')).map(entry => entry.commit)).toEqual([plain])
    expect(await ask(history, 'history.read', { path: '[ab].md', commit: bracket })).toMatchObject({ text: 'a note whose name is a pattern' })
    expect(await ask(history, 'history.read', { path: '[ab].md', commit: plain })).toEqual({ refused: { code: 'not-found' } })
  })

  it('takes a folder where a note was and a note where a folder was', async () => {
    const history = await started(where)
    await note(where, 'x', 'a note named x')
    await commitOf(history, ['x'], 'x as a note')
    await rm(path.join(where.notes, 'x'))
    await mkdir(path.join(where.notes, 'x'))
    await note(where, 'x/y.md', 'a note under x')
    const second = await commitOf(history, ['x', 'x/y.md'], 'x as a folder')
    expect(await ask(history, 'history.read', { path: 'x/y.md', commit: second })).toMatchObject({ text: 'a note under x' })
    await rm(path.join(where.notes, 'x'), { recursive: true })
    await note(where, 'x', 'a note again')
    const third = await commitOf(history, ['x/y.md', 'x'], 'x as a note again')
    expect(await ask(history, 'history.read', { path: 'x', commit: third })).toMatchObject({ text: 'a note again' })
  })

  it('lets a note under a new folder replace the note that had the folder\'s name, without the old note being named', async () => {
    const history = await started(where)
    await note(where, 'x', 'a note named x')
    const first = await commitOf(history, ['x'], 'x as a note')
    await rm(path.join(where.notes, 'x'))
    await mkdir(path.join(where.notes, 'x'))
    await note(where, 'x/y.md', 'a note under x')
    const second = await commitOf(history, ['x/y.md'], 'only the new note')
    expect(second).toMatch(/^[0-9a-f]{40}$/)
    expect(await ask(history, 'history.read', { path: 'x/y.md', commit: second })).toMatchObject({ text: 'a note under x' })
    expect(await ask(history, 'history.read', { path: 'x', commit: second })).toEqual({ refused: { code: 'not-found' } })
    expect(await ask(history, 'history.read', { path: 'x', commit: first })).toMatchObject({ text: 'a note named x' })
    // And back: a note named x again, with only x named
    await rm(path.join(where.notes, 'x'), { recursive: true })
    await note(where, 'x', 'a note again')
    const third = await commitOf(history, ['x'], 'only the note')
    expect(await ask(history, 'history.read', { path: 'x', commit: third })).toMatchObject({ text: 'a note again' })
    expect(await ask(history, 'history.read', { path: 'x/y.md', commit: third })).toEqual({ refused: { code: 'not-found' } })
  })

  it('names the caller as the committer and the client the call was made for as the author', async () => {
    const history = await started(where)
    await commitOf(history, ['a.md'], 'by the plugin')
    await note(where, 'a.md', 'edited for an agent')
    await commitOf(history, ['a.md'], 'for an agent', { onBehalf: 'https://agent.example/client <evil@example.com>\nSigned-off-by: x' })
    await note(where, 'a.md', 'edited in the window')
    await commitOf(history, ['a.md'], 'in the window', { caller: editor })
    const log = await logOf(history, 'a.md')
    expect(log.map(entry => [entry.author, entry.committer])).toEqual([
      ['window.editor', 'window.editor'],
      ['https://agent.example/client evil@example.com Signed-off-by: x', 'git'],
      ['git', 'git'],
    ])
  })

  it('falls back to the caller when the label holds nothing a name may', async () => {
    const history = await started(where)
    await commitOf(history, ['a.md'], 'odd label', { onBehalf: '<>' })
    expect((await logOf(history, 'a.md'))[0].author).toBe('git')
  })

  it('keeps the message as written, several lines and a leading dash included', async () => {
    const history = await started(where)
    const message = '--amend looks like a flag\n\nbody line one\nbody line two'
    await commitOf(history, ['a.md'], message)
    expect((await logOf(history, 'a.md'))[0].message).toBe(message)
  })

  it('takes a path once when it is named twice', async () => {
    const history = await started(where)
    const commit = await commitOf(history, ['a.md', 'a.md', 'journal/b.md'])
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    expect(await logOf(history, 'a.md')).toHaveLength(1)
  })

  it('runs commits one at a time, so many at once all land', async () => {
    const history = await started(where)
    const names = Array.from({ length: 8 }, (_, i) => `n${i}.md`)
    for (const name of names) await note(where, name, `note ${name}`)
    const commits = await Promise.all(names.map(name => commitOf(history, [name], `save ${name}`)))
    expect(new Set(commits).size).toBe(8)
    for (const [i, name] of names.entries()) {
      expect((await logOf(history, name)).map(entry => entry.commit)).toEqual([commits[i]])
      expect(await ask(history, 'history.read', { path: name, commit: commits[i] })).toMatchObject({ text: `note ${name}` })
    }
  })
})

describe('the paths it takes', () => {
  it('prepares the canonical path, which the gate then judges', async () => {
    const history = await started(where)
    const prepared = await history.provider.prepare(callOf('history.commit', { paths: ['journal/b.md', 'a.md'], message: 'x' }))
    expect(prepared).toEqual({ scope: { paths: ['journal/b.md', 'a.md'] } })
    const call = callOf('history.log', { path: onWindows ? 'JOURNAL/B.MD' : 'journal/b.md' })
    expect(await history.provider.prepare(call)).toEqual({ scope: { paths: ['journal/b.md'] } })
    history.provider.release?.(call, { scope: { paths: ['journal/b.md'] } })
  })

  it.each([
    ['.git/config', 'not-granted'],
    ['journal/.git/config', 'not-granted'],
    ['../outside.md', 'invalid'],
    ['/etc/passwd', 'invalid'],
    ['journal\\b.md', 'invalid'],
    ['a.md:stream', 'invalid'],
    ['con', 'invalid'],
  ])('refuses %s in prepare, before git or the disk hears of it', async (bad, code) => {
    const history = await started(where)
    await mkdir(path.join(where.notes, '.git'))
    await mkdir(path.join(where.notes, 'journal', '.git'))
    await writeFile(path.join(where.notes, '.git', 'config'), '[core]\n')
    await writeFile(path.join(where.notes, 'journal', '.git', 'config'), '[core]\n')
    expect(await ask(history, 'history.commit', { paths: ['a.md', bad], message: 'x' })).toEqual({ refused: { code } })
    expect(await ask(history, 'history.log', { path: bad })).toEqual({ refused: { code } })
    expect(await ask(history, 'history.read', { path: bad, commit: 'a'.repeat(40) })).toEqual({ refused: { code } })
  })

  it('refuses a link that leads out of the notes folder, and hetu\'s own folders inside it', async () => {
    const outside = path.join(where.base, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'secret.md'), 'secret')
    await symlink(outside, path.join(where.notes, 'link'), 'junction')
    const history = await started(where)
    expect(await ask(history, 'history.commit', { paths: ['link/secret.md'], message: 'x' })).toEqual({ refused: { code: 'not-granted' } })
    // A notes folder picked around hetu's own folders
    const wide = createHistory()
    await wide.start(where.dataDir)
    wide.role.open({ folder: where.base, dataDir: where.dataDir, installDir: where.installDir })
    expect(await ask(wide, 'history.commit', { paths: ['data/state/switches.json'], message: 'x' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await ask(wide, 'history.commit', { paths: ['notes/a.md'], message: 'x' })).toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/) })
  })

  it('answers not-found for a commit that isn\'t there or holds no such note', async () => {
    const history = await started(where)
    const commit = await commitOf(history, ['a.md'])
    expect(await ask(history, 'history.read', { path: 'a.md', commit: 'b'.repeat(40) })).toEqual({ refused: { code: 'not-found' } })
    expect(await ask(history, 'history.read', { path: 'journal/b.md', commit })).toEqual({ refused: { code: 'not-found' } })
    expect(await ask(history, 'history.read', { path: 'journal', commit })).toEqual({ refused: { code: 'not-found' } })
  })
})

describe('where the history lives', () => {
  it('keeps a repo of its own under the data folder, with no hooks folder, and puts nothing in the notes folder', async () => {
    const history = await started(where)
    const before = (await readdir(where.notes, { recursive: true })).sort()
    await commitOf(history, ['a.md'])
    expect((await readdir(where.notes, { recursive: true })).sort()).toEqual(before)
    const home = path.join(where.dataDir, 'host', 'history')
    const repos = (await readdir(home)).filter(name => /^[0-9a-f]{16}$/.test(name))
    expect(repos).toHaveLength(1)
    const repo = path.join(home, repos[0], 'shadow.git')
    expect(await exists(path.join(repo, 'HEAD'))).toBe(true)
    expect(await exists(path.join(repo, 'hooks'))).toBe(false)
  })

  it('keeps each notes folder\'s history apart and finds it again when the folder is picked again', async () => {
    const other = path.join(where.base, 'other')
    await mkdir(other)
    await writeFile(path.join(other, 'a.md'), 'the other a')
    const history = await started(where)
    const first = await commitOf(history, ['a.md'], 'in notes')
    history.role.open({ folder: other, dataDir: where.dataDir, installDir: where.installDir })
    expect(await logOf(history, 'a.md')).toEqual([])
    expect(await ask(history, 'history.read', { path: 'a.md', commit: first })).toEqual({ refused: { code: 'not-found' } })
    const second = await commitOf(history, ['a.md'], 'in other')
    history.role.open({ folder: where.notes, dataDir: where.dataDir, installDir: where.installDir })
    expect((await logOf(history, 'a.md')).map(entry => entry.commit)).toEqual([first])
    expect(second).not.toBe(first)
  })

  it('ends a call prepared under one folder once another is picked', async () => {
    const history = await started(where)
    const call = callOf('history.commit', { paths: ['a.md'], message: 'x' })
    const prepared = await history.provider.prepare(call)
    history.role.open({ folder: path.join(where.base, 'elsewhere'), dataDir: where.dataDir, installDir: where.installDir })
    await expect(history.provider.perform(call, prepared as never)).rejects.toEqual({ code: 'unavailable' })
  })

  it('passes a git planted in the notes folder by and uses the next one on the path', async () => {
    const planted = path.join(where.notes, 'bin')
    await mkdir(planted)
    // Running this would fail every call: an empty file under git's name
    await writeFile(path.join(planted, onWindows ? 'git.exe' : 'git'), '', { mode: 0o755 })
    const history = await started(where, { path: [planted, process.env.PATH].join(path.delimiter) })
    expect(await commitOf(history, ['a.md'])).toMatch(/^[0-9a-f]{40}$/)
  })

  it('stops serving once closed', async () => {
    const history = await started(where)
    history.close()
    expect(await ask(history, 'history.log', { path: 'a.md' })).toEqual({ refused: { code: 'unavailable' } })
  })

  it('reads a note only at a commit, never through the id of a tree', async () => {
    const history = await started(where)
    await note(where, 'journal/a.md', 'the a in journal')
    const commit = (await commitOf(history, ['a.md', 'journal/a.md']))!
    const repo = path.join(where.dataDir, 'host', 'history', (await readdir(path.join(where.dataDir, 'host', 'history'))).find(name => /^[0-9a-f]{16}$/.test(name))!, 'shadow.git')
    const { stdout } = await promisify(execFile)('git', ['--git-dir', repo, 'rev-parse', `${commit}:journal`])
    expect(await ask(history, 'history.read', { path: 'a.md', commit: stdout.trim() })).toEqual({ refused: { code: 'not-found' } })
    expect(await ask(history, 'history.read', { path: 'a.md', commit })).toMatchObject({ text: 'note a' })
  })
})

describe('what a stopped git leaves behind', () => {
  async function repoDir(): Promise<string> {
    const home = path.join(where.dataDir, 'host', 'history')
    return path.join(home, (await readdir(home)).find(name => /^[0-9a-f]{16}$/.test(name))!, 'shadow.git')
  }

  it('commits through an index lock a git ended mid-write left, since history alone writes its repo', async () => {
    const history = await started(where)
    await commitOf(history, ['a.md'])
    await writeFile(path.join(await repoDir(), 'index.lock'), '')
    await note(where, 'a.md', 'note a, edited')
    expect(await commitOf(history, ['a.md'])).toMatch(/^[0-9a-f]{40}$/)
  })

  it('commits only the notes a call names, whatever an earlier git left staged in the index', async () => {
    const history = await started(where)
    await commitOf(history, ['a.md'])
    // A blob staged under another name, as a git ended between update-index and commit-tree would leave it
    const repo = await repoDir()
    const run = promisify(execFile)
    const { stdout: blob } = await run('git', ['--git-dir', repo, 'hash-object', '-w', path.join(where.notes, 'a.md')])
    await run('git', ['--git-dir', repo, 'update-index', '--add', '--cacheinfo', `100644,${blob.trim()},stray.md`])
    await note(where, 'a.md', 'note a, edited')
    const commit = (await commitOf(history, ['a.md']))!
    const { stdout } = await run('git', ['--git-dir', repo, 'ls-tree', '--name-only', '-r', commit])
    expect(stdout.trim().split('\n')).toEqual(['a.md'])
  })
})

describe('a call that waits its turn', () => {
  it('answers timeout for a call whose deadline passed before its turn, and commits nothing', async () => {
    const history = await started(where)
    const call = { ...callOf('history.commit', { paths: ['a.md'], message: 'late' }), deadline: Date.now() - 1 }
    const prepared = await history.provider.prepare(call)
    await expect(history.provider.perform(call, prepared as never)).rejects.toEqual({ code: 'timeout' })
    expect(await logOf(history, 'a.md')).toEqual([])
  })

  it('ends a call queued behind another once a new folder is picked while it waits', async () => {
    const history = await started(where)
    const first = callOf('history.commit', { paths: ['a.md'], message: 'first' })
    const second = callOf('history.commit', { paths: ['journal/b.md'], message: 'second' })
    const [p1, p2] = [await history.provider.prepare(first), await history.provider.prepare(second)]
    const running = history.provider.perform(first, p1 as never)
    const waiting = history.provider.perform(second, p2 as never)
    history.role.open({ folder: path.join(where.base, 'elsewhere'), dataDir: where.dataDir, installDir: where.installDir })
    await running.catch(() => {})
    await expect(waiting).rejects.toEqual({ code: 'unavailable' })
  })
})

describe('a page of the log', () => {
  // 90 messages of 4096 characters at three bytes each are past a megabyte
  it('answers a large page of the longest messages', async () => {
    const history = await started(where)
    const message = '河'.repeat(4096)
    for (let i = 0; i < 90; i++) {
      await note(where, 'a.md', `version ${i}`)
      await commitOf(history, ['a.md'], message)
    }
    const listed = await logOf(history, 'a.md', 200)
    expect(listed).toHaveLength(90)
    expect(listed[0].message).toBe(message)
  }, 180000)
})

describe('whose call it is', () => {
  it('serves any caller the carrier hands it, a plugin or a window, since the gate decided', async () => {
    const history = await started(where)
    await commitOf(history, ['a.md'], 'x', { caller: git })
    expect(await ask(history, 'history.log', { path: 'a.md' }, { caller: editor })).toMatchObject({ commits: [{ message: 'x' }] })
  })
})
