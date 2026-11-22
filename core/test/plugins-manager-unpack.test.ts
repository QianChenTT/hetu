import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Options } from 'yauzl'
import { nameProblem, unpackLimits, unpackZip } from '../backend/plugins-manager/unpack.ts'
import { makeZip, type ZipEntry } from './zip-maker.ts'

// The reader's own size check, switched off for one test so the cap is seen to count what lands on disk and not lean on
// the sizes a zip declares
const reader = vi.hoisted(() => ({ sizesUnchecked: false }))
vi.mock('yauzl', async importOriginal => {
  const real = await importOriginal<typeof import('yauzl')>()
  return {
    ...real,
    fromBufferPromise: (buffer: Buffer, options?: Options) =>
      real.fromBufferPromise(buffer, reader.sizesUnchecked ? { ...options, validateEntrySizes: false } : options),
  }
})

// A clear that fails, as one a Windows lock outlasts, a write that fails, as a full disk's, and writes that take at most
// 7 bytes each, as a write may
const disk = vi.hoisted(() => ({ clearFails: false, writeFails: false, shortWrites: false }))
vi.mock('../backend/plugins-manager/folders.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../backend/plugins-manager/folders.ts')>()
  return {
    ...real,
    clear: async (dir: string) => {
      if (disk.clearFails) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return real.clear(dir)
    },
  }
})
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const open = async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args)
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'write' && disk.writeFails) return async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) }
        if (key === 'write' && disk.shortWrites) {
          return async (buffer: Buffer, offset = 0) => target.write(buffer, offset, Math.min(7, buffer.length - offset))
        }
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  return { ...real, open }
})

const made: string[] = []

afterEach(async () => {
  reader.sizesUnchecked = false
  disk.clearFails = false
  disk.writeFails = false
  disk.shortWrites = false
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

// A temp folder holding an empty staging folder, so a write that climbs one level out lands where a test can see it
async function staging(): Promise<{ base: string, into: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'hetu-unpack-'))
  made.push(base)
  const into = path.join(base, 'staging')
  await mkdir(into)
  return { base, into }
}

const listed = async (root: string) => (await readdir(root, { recursive: true, withFileTypes: true }))
  .map(entry => `${path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')}${entry.isDirectory() ? '/' : ''}`)
  .sort()

async function unpacked(entries: readonly ZipEntry[], limits = unpackLimits) {
  const { base, into } = await staging()
  const problem = (await unpackZip(makeZip(entries), into, limits)).problem
  return { problem, base, into, files: await listed(into) }
}

describe('a zip unpacked into a staging folder', () => {
  it('writes each file with its bytes, stored or deflated, and each folder', async () => {
    const { problem, into, files } = await unpacked([
      { name: 'hetu-plugin.json', data: '{"id":"x"}', stored: true },
      { name: 'dist/', mode: 0o040755 },
      { name: 'dist/worker.js', data: 'export {}\n'.repeat(50), mode: 0o100644 },
      { name: 'assets/empty.txt' },
    ])
    expect(problem).toBeNull()
    expect(files).toEqual(['assets/', 'assets/empty.txt', 'dist/', 'dist/worker.js', 'hetu-plugin.json'])
    expect(await readFile(path.join(into, 'hetu-plugin.json'), 'utf8')).toBe('{"id":"x"}')
    expect(await readFile(path.join(into, 'dist', 'worker.js'), 'utf8')).toBe('export {}\n'.repeat(50))
    expect(await readFile(path.join(into, 'assets', 'empty.txt'), 'utf8')).toBe('')
  })

  it('writes all of each chunk when a write takes only part of it', async () => {
    disk.shortWrites = true
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join('')
    const { problem, into } = await unpacked([{ name: 'a.txt', data: text }, { name: 'b.txt', data: text, stored: true }])
    expect(problem).toBeNull()
    expect(await readFile(path.join(into, 'a.txt'), 'utf8')).toBe(text)
    expect(await readFile(path.join(into, 'b.txt'), 'utf8')).toBe(text)
  })

  it('takes only an empty folder', async () => {
    const { base, into } = await staging()
    await writeFile(path.join(into, 'left.txt'), 'x')
    await expect(unpackZip(makeZip([{ name: 'a.txt' }]), into)).rejects.toThrow()
    await expect(unpackZip(makeZip([{ name: 'a.txt' }]), path.join(base, 'none'))).rejects.toThrow()
    await expect(unpackZip(makeZip([{ name: 'a.txt' }]), path.join(into, 'left.txt'))).rejects.toThrow()
    expect(await listed(into)).toEqual(['left.txt'])
  })

  it('refuses bytes that are no zip, a cut-off zip and data that will not inflate', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello hello hello' }])
    const broken = Buffer.from(zip)
    // The deflated data starts after the 30 byte local header and the 5 byte name
    broken.fill(0xff, 35, 40)
    for (const bytes of [Buffer.from('not a zip at all'), zip.subarray(0, zip.length - 10), broken]) {
      const { into } = await staging()
      expect((await unpackZip(bytes, into)).problem).toBe('invalid')
      expect(await listed(into)).toEqual([])
    }
  })

  it('refuses a size the zip declares that its data does not have', async () => {
    expect((await unpacked([{ name: 'a.txt', data: 'x'.repeat(100), declaredSize: 10 }])).problem).toBe('invalid')
    expect((await unpacked([{ name: 'a.txt', data: 'x'.repeat(100), declaredSize: 1000 }])).problem).toBe('invalid')
  })
})

describe('what a refusal leaves', () => {
  it('says nothing is left when the folder was emptied', async () => {
    const bad = makeZip([{ name: 'a.js', data: 'x' }, { name: 'a.js.', data: 'x' }])
    const { into } = await staging()
    expect(await unpackZip(bad, into)).toEqual({ problem: 'name', leftovers: false })
    expect(await unpackZip(makeZip([{ name: 'a.js', data: 'x' }]), (await staging()).into)).toEqual({ problem: null, leftovers: false })
  })

  it('keeps the refusal and says something may be left when the folder can not be emptied', async () => {
    const { into } = await staging()
    disk.clearFails = true
    expect(await unpackZip(makeZip([{ name: 'a.js', data: 'x' }, { name: 'a.js.', data: 'x' }]), into)).toEqual({ problem: 'name', leftovers: true })
  })

  it('throws the failure itself, not the clear\'s, when neither the write nor the clear goes through', async () => {
    const { into } = await staging()
    disk.writeFails = true
    disk.clearFails = true
    await expect(unpackZip(makeZip([{ name: 'a.js', data: 'x' }]), into)).rejects.toMatchObject({ code: 'ENOSPC' })
  })
})

describe('the Finder\'s resource forks', () => {
  it('skips every entry under __MACOSX/ and writes the rest', async () => {
    const { problem, files } = await unpacked([
      { name: 'hetu-plugin.json', data: '{}' },
      { name: '__MACOSX/', mode: 0o040755 },
      { name: '__MACOSX/._hetu-plugin.json', data: 'fork' },
      { name: '__MACOSX/dist/._worker.js', data: 'fork' },
      { name: 'dist/worker.js', data: 'x' },
    ])
    expect(problem).toBeNull()
    expect(files).toEqual(['dist/', 'dist/worker.js', 'hetu-plugin.json'])
  })

  it('skips only the folder at the top named exactly so', async () => {
    const { problem, files } = await unpacked([{ name: 'alpha/__MACOSX/a.txt', data: 'x' }, { name: '__MACOSXY/b.txt', data: 'x' }])
    expect(problem).toBeNull()
    expect(files).toEqual(['__MACOSXY/', '__MACOSXY/b.txt', 'alpha/', 'alpha/__MACOSX/', 'alpha/__MACOSX/a.txt'])
  })
})

describe('names', () => {
  it('refuses a name that climbs as climbing, not only as a trailing dot', () => {
    for (const name of ['..', '../a.js', 'a/../../b.js', 'a/../b.js', 'a/..']) expect(nameProblem(name), name).toBe('a .. segment')
  })

  it('refuses a name that is absolute, names a drive or holds another separator', () => {
    for (const name of ['/a.js', '//server/share/a.js', 'C:/a.js', 'C:a.js', 'c:', 'a\\b.js', '..\\a.js']) {
      expect(nameProblem(name), name).not.toBeNull()
    }
  })

  it('refuses an empty name, an empty segment and a . segment', () => {
    for (const name of ['', 'a//b.js', 'a/', './a.js', 'a/./b.js', 'a/.']) expect(nameProblem(name), name).not.toBeNull()
  })

  it('refuses what Windows reads as another name: a stream, a device, a trailing dot or space, its reserved characters', () => {
    for (const name of ['a.js:stream', 'con', 'CON', 'aux.js', 'dist/nul.txt', 'lpt1', 'COM9.json', 'a.js.', 'dist./a.js', 'a.js ', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b']) {
      expect(nameProblem(name), name).not.toBeNull()
    }
  })

  it('refuses control characters and the characters HFS+ skips when it compares names', () => {
    for (const name of ['a\u0000b', 'a\u001fb', 'a\u007fb', 'a\u200cb.js', 'a\ufeffb.js', 'a\u202eb.js']) expect(nameProblem(name), JSON.stringify(name)).not.toBeNull()
  })

  it('takes plain names, dot files and names in any script', () => {
    for (const name of ['hetu-plugin.json', 'dist/worker.js', '.well-known/a.txt', 'a..b.js', 'console.js', 'nul-safe/x.js', 'locales/zh-CN.json', '思源/字体.ttf', 'a b/c d.txt']) {
      expect(nameProblem(name), name).toBeNull()
    }
  })

  it('caps a segment at 255 characters, a name at 1,024 and the depth at 32 segments', () => {
    const segment = (length: number) => 'a'.repeat(length)
    expect(nameProblem(segment(255))).toBeNull()
    expect(nameProblem(`x/${segment(256)}`)).toBe('a segment longer than 255 characters')
    // Ten segments of 100 and their slashes are 1,010 characters
    const long = (length: number) => [...Array.from({ length: 10 }, () => segment(100)), segment(length - 1010)].join('/')
    expect(nameProblem(long(1024))).toBeNull()
    expect(nameProblem(long(1025))).toBe('longer than 1,024 characters')
    const deep = (depth: number) => Array.from({ length: depth }, () => 'a').join('/')
    expect(nameProblem(deep(32))).toBeNull()
    expect(nameProblem(deep(33))).toBe('deeper than 32 segments')
  })

  it('refuses a zip with a bad name and writes nothing of it', async () => {
    for (const name of ['a/./b.js', 'a//b.js', 'a.js:x', 'dist/con.js', 'a.js.', 'a\u200cb.js']) {
      const { problem, files } = await unpacked([{ name: 'first.js', data: 'x' }, { name, data: 'x' }])
      expect(problem, name).toBe('name')
      expect(files, name).toEqual([])
    }
  })

  it('reads a backslash between segments as a folder, as Compress-Archive writes them', async () => {
    const { problem, files } = await unpacked([{ name: 'dist\\worker.js', data: 'x' }, { name: 'hetu-plugin.json', data: '{}' }])
    expect(problem).toBeNull()
    expect(files).toEqual(['dist/', 'dist/worker.js', 'hetu-plugin.json'])
  })

  it('still refuses a name with backslashes that climbs out, is absolute or names a drive', async () => {
    for (const name of ['..\\evil.js', 'a\\..\\..\\evil.js', '\\evil.js', '\\\\server\\share\\evil.js', 'C:\\evil.js', 'a\\.\\b.js']) {
      const { problem, base, files } = await unpacked([{ name, data: 'x' }])
      expect(problem, name).not.toBeNull()
      expect(files, name).toEqual([])
      expect(await readdir(base), name).toEqual(['staging'])
    }
  })

  it('refuses a zip whose name climbs out, and nothing lands beside the folder', async () => {
    for (const name of ['../evil.js', 'a/../../evil.js', '/evil.js', 'C:/evil.js', '..\\evil.js']) {
      const { problem, base, files } = await unpacked([{ name, data: 'x' }])
      expect(problem, name).not.toBeNull()
      expect(files).toEqual([])
      expect(await readdir(base)).toEqual(['staging'])
    }
  })
})

describe('duplicates', () => {
  it('refuses a name twice, in another case or another Unicode form', async () => {
    const pairs = [['a.js', 'a.js'], ['a.js', 'A.JS'], ['dist/a.js', 'DIST/a.js'], ['\u00e9.js', 'e\u0301.js'], ['a/', 'a']]
    for (const [first, second] of pairs) {
      const { problem, files } = await unpacked([{ name: first, data: 'x' }, { name: second, data: 'y' }])
      expect(problem, `${first} ${second}`).toBe('duplicate')
      expect(files).toEqual([])
    }
  })

  it('refuses a file where another entry needs a folder, in either order', async () => {
    for (const names of [['a', 'A/b.js'], ['a/b.js', 'A'], ['a/b', 'a/B/c.js']]) {
      expect((await unpacked(names.map(name => ({ name, data: 'x' })))).problem, names.join(' ')).toBe('duplicate')
    }
  })

  it('takes a folder entry after the files in it', async () => {
    const { problem, files } = await unpacked([{ name: 'dist/a.js', data: 'x' }, { name: 'dist/' }, { name: 'DIST/' }])
    expect(problem).toBeNull()
    expect(files).toEqual(['dist/', 'dist/a.js'])
  })
})

describe('links and other special entries', () => {
  it('refuses a link, a device, a pipe and a socket as Unix modes record them', async () => {
    for (const mode of [0o120777, 0o020644, 0o060644, 0o010644, 0o140755]) {
      const { problem, files } = await unpacked([{ name: 'a.js', data: 'x' }, { name: 'b', data: '../../outside', mode }])
      expect(problem, mode.toString(8)).toBe('special')
      expect(files).toEqual([])
    }
  })

  it('refuses a folder recorded as a file and a file recorded as a folder', async () => {
    expect((await unpacked([{ name: 'a/', mode: 0o100644 }])).problem).toBe('special')
    expect((await unpacked([{ name: 'a.js', data: 'x', mode: 0o040755 }])).problem).toBe('special')
  })

  it('refuses an entry marked as a Windows reparse point', async () => {
    expect((await unpacked([{ name: 'a', data: 'x', dosAttributes: 0x400 }])).problem).toBe('special')
  })

  it('takes plain files and folders from Windows tools, with no Unix mode', async () => {
    expect((await unpacked([{ name: 'a/', dosAttributes: 0x10 }, { name: 'a/b.js', data: 'x', dosAttributes: 0x20 }])).problem).toBeNull()
  })
})

describe('encrypted entries', () => {
  it('refuses an entry with the encrypted flag, stored or deflated', async () => {
    expect((await unpacked([{ name: 'a.js', data: 'x', flags: 1 }])).problem).toBe('encrypted')
    // A stored encrypted entry's data is 12 bytes of header longer than the file
    expect((await unpacked([{ name: 'a.js', data: 'x'.repeat(20), declaredSize: 8, flags: 1, stored: true }])).problem).toBe('encrypted')
  })

  it('refuses the strong encryption flag, which the reader refuses as no zip it reads', async () => {
    expect((await unpacked([{ name: 'a.js', data: 'x', flags: 0x40 }])).problem).toBe('invalid')
  })
})

describe('the caps', () => {
  it('are 2,000 entries and 64 MiB', () => {
    expect(unpackLimits).toEqual({ entries: 2000, bytes: 64 * 1024 * 1024 })
  })

  it('refuses more entries than the cap before writing any', async () => {
    const entries = Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.txt` }))
    const { problem, files } = await unpacked(entries)
    expect(problem).toBe('too-many')
    expect(files).toEqual([])
  })

  it('takes entries up to the cap, folder entries counted', async () => {
    const entries = [{ name: 'a/' }, { name: 'b/' }, { name: 'c.txt' }]
    expect((await unpacked(entries, { entries: 3, bytes: 100 })).problem).toBeNull()
    expect((await unpacked(entries, { entries: 2, bytes: 100 })).problem).toBe('too-many')
  })

  it('counts each folder a name implies as an entry, once', async () => {
    const deep = [{ name: 'a/b/c/d/e/f/g/h/i/j/k.txt', data: 'x' }]
    expect((await unpacked(deep, { entries: 11, bytes: 100 })).problem).toBeNull()
    const { problem, files } = await unpacked(deep, { entries: 10, bytes: 100 })
    expect(problem).toBe('too-many')
    expect(files).toEqual([])
    const shared = [{ name: 'a/b/x.txt' }, { name: 'a/b/y.txt' }, { name: 'a/' }, { name: 'A/B/' }]
    expect((await unpacked(shared, { entries: 4, bytes: 100 })).problem).toBeNull()
    expect((await unpacked(shared, { entries: 3, bytes: 100 })).problem).toBe('too-many')
  })

  it('takes bytes up to the cap and refuses one past it, across entries', async () => {
    expect((await unpacked([{ name: 'a', data: 'x'.repeat(600) }, { name: 'b', data: 'x'.repeat(400) }], { entries: 10, bytes: 1000 })).problem).toBeNull()
    const { problem, files } = await unpacked([{ name: 'a', data: 'x'.repeat(600) }, { name: 'b', data: 'x'.repeat(401) }], { entries: 10, bytes: 1000 })
    expect(problem).toBe('too-big')
    expect(files).toEqual([])
  })

  it('counts the bytes written, not the sizes the zip declares', async () => {
    reader.sizesUnchecked = true
    const { problem, files } = await unpacked([{ name: 'a', data: 'x'.repeat(5000), declaredSize: 10 }], { entries: 10, bytes: 1000 })
    expect(problem).toBe('too-big')
    expect(files).toEqual([])
  })
})
