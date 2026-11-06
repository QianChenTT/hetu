import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashFiles, readFiles } from '../lib/hash-files.ts'
import { HOLD_TIMEOUT, holdOpen, onWindows, releaseAfter, releaseAll } from './hold.ts'

let dir: string

async function folder(name: string, files: Record<string, string | Buffer>) {
  const root = path.join(dir, name)
  await mkdir(root, { recursive: true })
  for (const [file, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), bytes)
  }
  return root
}

const hashOf = async (root: string) => hashFiles(await readFiles(root))
const file = (name: string, bytes: string) => ({ path: name, bytes: Buffer.from(bytes) })
const bytesOf = (text: string | Buffer) => typeof text === 'string' ? Buffer.from(text) : text

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hetu-hash-'))
})

afterEach(async () => {
  await releaseAll()
  await rm(dir, { recursive: true, force: true })
})

// What contentHash in state.ts gave for this folder before the split into readFiles and hashFiles. Every entry written
// before the split holds a hash made that way, so a change here would fail every one
const pinned = {
  'a.js': 'export const a = 1\n',
  'B.js': 'export const b = 2\n',
  'a/b.js': 'import "../a.js"\n',
  'sub/a.js': 'zero',
  'sub/deep/x.wasm': Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0x0a]),
  'empty.txt': '',
}
const PINNED_HASH = 'dfd672f224574b9ccd17bf5cdd8f3b69af77325575489b8674ed340f8b82b262'

describe('the hash', () => {
  it('gives the hash contentHash gave for the same folder before the split', async () => {
    expect(await hashOf(await folder('search', pinned))).toBe(PINNED_HASH)
  })

  it('hashes each file by path, size and bytes in sorted order', async () => {
    const root = await folder('search', { 'b.js': 'two', 'sub/a.js': 'one', 'a.js': 'zero' })
    const expected = createHash('sha256')
      .update('a.js\u00004\u0000zero')
      .update('b.js\u00003\u0000two')
      .update('sub/a.js\u00003\u0000one')
      .digest('hex')
    expect(await hashOf(root)).toBe(expected)
  })

  // NTFS lists a.js/b.js, a.js, B.js in that order, so the hash only matches if the code sorts by code unit itself
  it('sorts by code unit, not in the order the file system lists', async () => {
    const root = await folder('search', { 'a.js': '1', 'a/b.js': '2', 'B.js': '3' })
    const expected = createHash('sha256')
      .update('B.js\u00001\u00003')
      .update('a.js\u00001\u00001')
      .update('a/b.js\u00001\u00002')
      .digest('hex')
    expect(await hashOf(root)).toBe(expected)
  })

  // Two bytes and one character, so a size counted in characters gives another hash than every stored one
  it('frames multi-byte text by its size in bytes', async () => {
    const root = await folder('search', { 'a.md': '\u00e9' })
    expect(await hashOf(root)).toBe(createHash('sha256').update('a.md\u00002\u0000\u00e9').digest('hex'))
  })

  it('tells apart the same bytes split across files differently', async () => {
    const one = await folder('one', { 'a': 'xy', 'b': 'z' })
    const two = await folder('two', { 'a': 'x', 'b': 'yz' })
    expect(await hashOf(one)).not.toBe(await hashOf(two))
  })

  // contentHash took them in, so leaving them out would change the hash of every plugin that holds one
  it('hashes dot-named files and folders like any other', async () => {
    const root = await folder('search', { '.a.js': 'x', '.hidden/b.js': 'y' })
    const expected = createHash('sha256')
      .update('.a.js\u00001\u0000x')
      .update('.hidden/b.js\u00001\u0000y')
      .digest('hex')
    expect(await hashOf(root)).toBe(expected)
  })

  it('takes the files in any order', async () => {
    const files = await readFiles(await folder('search', pinned))
    expect(hashFiles([...files].reverse())).toBe(PINNED_HASH)
  })

  it('refuses a path twice, which no folder holds', () => {
    expect(() => hashFiles([file('a.js', '1'), file('b.js', '2'), file('a.js', '1')])).toThrow(/a file twice: a\.js/)
  })

  it('counts an empty file and leaves out an empty folder, which holds no bytes', async () => {
    const root = await folder('search', { 'a.js': '1' })
    const before = await hashOf(root)
    await mkdir(path.join(root, 'empty'))
    expect(await hashOf(root)).toBe(before)
    await writeFile(path.join(root, 'empty', 'b.js'), '')
    expect(await hashOf(root)).not.toBe(before)
  })
})

describe('reading the files', () => {
  it('gives each file once with its path and bytes, in the order the hash takes', async () => {
    const files = await readFiles(await folder('search', pinned))
    expect(files.map(f => f.path)).toEqual(['B.js', 'a.js', 'a/b.js', 'empty.txt', 'sub/a.js', 'sub/deep/x.wasm'])
    for (const { path: name, bytes } of files) expect(bytes).toEqual(bytesOf(pinned[name as keyof typeof pinned]))
  })

  // The loader runs these bytes, so a file changed on disk after the read can't reach what was hashed
  it('keeps the bytes it read, whatever happens on disk after', async () => {
    const root = await folder('search', { 'a.js': 'checked' })
    const files = await readFiles(root)
    const hash = hashFiles(files)
    await writeFile(path.join(root, 'a.js'), 'swapped')
    expect(files[0].bytes.toString()).toBe('checked')
    expect(hashFiles(files)).toBe(hash)
    expect(await hashOf(root)).not.toBe(hash)
  })

  it('refuses a link inside the folder', async () => {
    const outside = await folder('outside', { 'secret.js': '1' })
    const root = await folder('search', { 'a.js': '1' })
    await symlink(outside, path.join(root, 'link'), 'junction')
    await expect(readFiles(root)).rejects.toThrow(/not a file or folder: link/)
  })

  // The message counts: a folder link read through throws EISDIR, which a bare rejects would take too
  it('refuses a link inside a subfolder', async () => {
    const outside = await folder('outside', { 'secret.js': '1' })
    const root = await folder('search', { 'sub/a.js': '1' })
    await symlink(outside, path.join(root, 'sub', 'link'), 'junction')
    await expect(readFiles(root)).rejects.toThrow(/not a file or folder: sub\/link/)
  })

  // Windows needs a privilege for a link to a file, the junction above covers a link there
  it.skipIf(onWindows)('refuses a link to a file inside the folder', async () => {
    const outside = await folder('outside', { 'secret.js': '1' })
    const root = await folder('search', { 'a.js': '1' })
    await symlink(path.join(outside, 'secret.js'), path.join(root, 'sub.js'))
    await expect(readFiles(root)).rejects.toThrow(/not a file or folder: sub\.js/)
  })

  it('refuses a folder that is itself a link', async () => {
    const outside = await folder('outside', { 'a.js': '1' })
    const link = path.join(dir, 'search')
    await symlink(outside, link, 'junction')
    await expect(readFiles(link)).rejects.toThrow(/not a folder/)
  })

  it('refuses a file where the folder should be', async () => {
    await writeFile(path.join(dir, 'search'), 'a file')
    await expect(readFiles(path.join(dir, 'search'))).rejects.toThrow(/not a folder/)
  })

  // A read of a FIFO waits for a writer forever, so the listing alone refuses one
  it.skipIf(onWindows)('refuses a special file without reading it', async () => {
    const root = await folder('search', { 'a.js': '1' })
    execFileSync('mkfifo', [path.join(root, 'pipe')])
    await expect(readFiles(root)).rejects.toThrow(/not a file or folder: pipe/)
  })

  it('answers a missing folder with ENOENT, which the loader reads as missing code', async () => {
    await expect(readFiles(path.join(dir, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(onWindows)('waits out a short hold on a file', async () => {
    const root = await folder('search', { 'a.js': '1' })
    // Read-only too, which a read gets past, so only the read's own retry waits out the hold
    await chmod(path.join(root, 'a.js'), 0o444)
    const holder = await holdOpen(path.join(root, 'a.js'), 'None')
    const [files] = await Promise.all([readFiles(root), releaseAfter(holder, 300)])
    expect(files.map(f => f.path)).toEqual(['a.js'])
  }, HOLD_TIMEOUT)
})
