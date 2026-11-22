import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findPlugins } from '../backend/plugins-manager/find.ts'
import { unpackZip } from '../backend/plugins-manager/unpack.ts'

// Zips made by other tools, kept as they came out, so the reader is tried on more than one author's idea of a zip.
// python-streamed.zip: Python 3.14's zipfile writing to a stream it can't seek, so every entry has a data descriptor
// (flag bit 3), the manifest stored, worker.js deflated with an extended timestamp extra field (0x5455) and a Unix mode
// with no file type bits. bsdtar.zip: Windows' tar.exe (bsdtar 3.8.9) with -a, data descriptors on files, the ux and UT
// extra fields and Unix modes. bsdtar-cp437.zip: the same with --options zip:hdrcharset=CP437, café.txt named in CP437
// with no UTF-8 flag. compress-archive-ps51.zip: Windows PowerShell 5.1's Compress-Archive, which writes \ between the
// segments of a name, read as /
const fixtures = path.join(import.meta.dirname, 'fixtures', 'zips')

const made: string[] = []

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function unpacked(fixture: string) {
  const into = path.join(await mkdtemp(path.join(tmpdir(), 'hetu-zip-fixtures-')), 'staging')
  made.push(path.dirname(into))
  await mkdir(into)
  const zip = await readFile(path.join(fixtures, fixture))
  const problem = (await unpackZip(zip, into)).problem
  const files = (await readdir(into, { recursive: true })).map(name => name.split(path.sep).join('/')).sort()
  return { zip, into, problem, files }
}

// The general purpose flags of every local header, found by their signature
function localFlags(zip: Buffer): number[] {
  const flags: number[] = []
  for (let at = zip.indexOf('PK\u0003\u0004'); at !== -1; at = zip.indexOf('PK\u0003\u0004', at + 4)) flags.push(zip.readUInt16LE(at + 6))
  return flags
}

describe('zips made by other tools', () => {
  it('unpacks Python\'s streamed zip, each entry with a data descriptor', async () => {
    const { zip, into, problem, files } = await unpacked('python-streamed.zip')
    expect(localFlags(zip).every(flag => (flag & 0x8) !== 0)).toBe(true)
    expect(problem).toBeNull()
    expect(files).toEqual(['fixture-python', 'fixture-python/dist', 'fixture-python/dist/worker.js', 'fixture-python/hetu-plugin.json'])
    expect(await readFile(path.join(into, 'fixture-python', 'dist', 'worker.js'), 'utf8')).toBe('// fixture-python worker\nexport {}\n')
    expect((await findPlugins(into)).plugins.map(each => each.id)).toEqual(['fixture-python'])
  })

  it('unpacks bsdtar\'s zip, with its extra fields and Unix modes', async () => {
    const { zip, into, problem, files } = await unpacked('bsdtar.zip')
    expect(localFlags(zip).some(flag => (flag & 0x8) !== 0)).toBe(true)
    expect(problem).toBeNull()
    expect(files).toEqual(['fixture-tar', 'fixture-tar/dist', 'fixture-tar/dist/worker.js', 'fixture-tar/hetu-plugin.json'])
    expect((await findPlugins(into)).plugins.map(each => each.id)).toEqual(['fixture-tar'])
  })

  it('reads a name written in CP437 as the character it names', async () => {
    const { zip, into, problem, files } = await unpacked('bsdtar-cp437.zip')
    expect(localFlags(zip).every(flag => (flag & 0x800) === 0)).toBe(true)
    expect(zip.includes(Buffer.from('caf\u0082.txt', 'latin1'))).toBe(true)
    expect(problem).toBeNull()
    expect(files).toContain('fixture-tar-cp437/café.txt')
    expect(await readFile(path.join(into, 'fixture-tar-cp437', 'café.txt'), 'utf8')).toBe('café\n')
  })

  it('unpacks Compress-Archive\'s zip, its backslashes read as folders', async () => {
    const { zip, into, problem, files } = await unpacked('compress-archive-ps51.zip')
    expect(zip.includes(Buffer.from('fixture-compress-archive\\hetu-plugin.json'))).toBe(true)
    expect(problem).toBeNull()
    expect(files).toEqual(['fixture-compress-archive', 'fixture-compress-archive/dist', 'fixture-compress-archive/dist/worker.js', 'fixture-compress-archive/hetu-plugin.json'])
    expect((await findPlugins(into)).plugins.map(each => each.id)).toEqual(['fixture-compress-archive'])
  })
})
