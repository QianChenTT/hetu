import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findPlugins } from '../backend/plugins-manager/find.ts'
import { unpackZip } from '../backend/plugins-manager/unpack.ts'
import { filesFor, hashOf, workerManifest } from './plugins-manager-fakes.ts'
import { makeZip, type ZipEntry } from './zip-maker.ts'

// The known ways a zip attacks the program that unpacks it, each made as its author would make it, against the
// unpacking and the finding an install runs

const made: string[] = []

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

// The staging folder three levels down, so a name that climbs two or three levels lands inside base where the test
// can see it
async function staging(): Promise<{ base: string, into: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'hetu-zip-attacks-'))
  made.push(base)
  const into = path.join(base, 'data', 'staging', 'install-1')
  await mkdir(into, { recursive: true })
  return { base, into }
}

const everything = async (root: string) => (await readdir(root, { recursive: true }))
  .map(name => name.split(path.sep).join('/')).sort()

// A plugin's files as zip entries under its folder
const pluginEntries = (folder: string, id: string, version = '1.0.0'): ZipEntry[] =>
  Object.entries(filesFor(workerManifest(id, { version }))).map(([name, data]) => ({ name: `${folder}/${name}`, data }))

const untouched = ['data', 'data/staging', 'data/staging/install-1']

// The bomb writes 64 MiB before it is stopped, about 2 s on this PC against vitest's 5 s, so it gets ten times that
const BOMB_MS = 20_000

describe('a release zip of built plugins', () => {
  it('unpacks and each plugin is found with the hash of the bytes written', async () => {
    const { into } = await staging()
    const zip = makeZip([...pluginEntries('alpha', 'alpha', '1.2.0'), ...pluginEntries('beta', 'beta')])
    expect(await unpackZip(zip, into)).toBeNull()
    const found = (await findPlugins(into)).plugins
    expect(found.map(each => [each.id, each.version, each.read.problem])).toEqual([['alpha', '1.2.0', null], ['beta', '1.0.0', null]])
    expect(found[0].read.hash).toBe(await hashOf(path.join(into, 'alpha')))
  })
})

describe('Zip Slip', () => {
  it('writes nothing for a name that climbs out, in any spelling', async () => {
    for (const name of ['../../evil.js', 'alpha/../../../evil.js', '..\\..\\evil.js', 'alpha\\..\\..\\..\\evil.js', '/evil.js', 'C:/evil.js', 'C:\\evil.js', 'C:evil.js']) {
      const { base, into } = await staging()
      expect(await unpackZip(makeZip([...pluginEntries('alpha', 'alpha'), { name, data: 'evil' }]), into), name).not.toBeNull()
      expect(await everything(base), name).toEqual(untouched)
    }
  })
})

describe('a link', () => {
  it('refuses a link entry before anything is written through it', async () => {
    const { base, into } = await staging()
    const zip = makeZip([
      ...pluginEntries('alpha', 'alpha'),
      { name: 'alpha/dist', data: '../../../../escape', mode: 0o120777 },
      { name: 'alpha/dist/worker.js', data: 'evil' },
    ])
    expect(await unpackZip(zip, into)).toBe('special')
    expect(await everything(base)).toEqual(untouched)
  })
})

describe('bombs', () => {
  it('stops two directory records over one block of data at 64 MiB written, as Fifield\'s bomb is made', async () => {
    const { into } = await staging()
    const block: ZipEntry = { name: 'alpha/0.bin', data: Buffer.alloc(1024 * 1024) }
    const copies = Array.from({ length: 70 }, (_, i): ZipEntry => ({ name: `alpha/${i + 1}.bin`, sameDataAs: 0 }))
    const zip = makeZip([block, ...copies])
    expect(zip.length).toBeLessThan(20_000)
    expect(await unpackZip(zip, into)).toBe('too-big')
    expect(await readdir(into)).toEqual([])
  }, BOMB_MS)

  it('writes a zip inside the zip as bytes and never opens it, so nesting as 42.zip does unpacks one level', async () => {
    const { into } = await staging()
    const inner = makeZip([{ name: 'big.bin', data: Buffer.alloc(1024 * 1024) }])
    expect(await unpackZip(makeZip([...pluginEntries('alpha', 'alpha'), { name: 'alpha/inner.zip', data: inner }]), into)).toBeNull()
    expect(await everything(into)).toEqual(['alpha', 'alpha/hetu-plugin.json', 'alpha/inner.zip', 'alpha/worker.js'])
    expect(await readFile(path.join(into, 'alpha', 'inner.zip'))).toEqual(inner)
  })
})

describe('two readers, two answers', () => {
  it('refuses a manifest twice, in the same or another case, so no reader picks one of two', async () => {
    for (const second of ['alpha/hetu-plugin.json', 'alpha/HETU-PLUGIN.json', 'ALPHA/hetu-plugin.json']) {
      const { into } = await staging()
      const more = JSON.stringify(workerManifest('alpha', { capabilities: [{ type: 'notes.read', scope: '**' }] }))
      expect(await unpackZip(makeZip([...pluginEntries('alpha', 'alpha'), { name: second, data: more }]), into), second).toBe('duplicate')
      expect(await readdir(into)).toEqual([])
    }
  })

  it('writes under the central directory\'s name whatever the local header says, and the hash is of the bytes written', async () => {
    const { into } = await staging()
    const zip = makeZip([...pluginEntries('alpha', 'alpha'), { name: 'alpha/extra.js', localName: 'alpha/../../evil.js', data: 'extra' }])
    expect(await unpackZip(zip, into)).toBeNull()
    expect(await everything(into)).toEqual(['alpha', 'alpha/extra.js', 'alpha/hetu-plugin.json', 'alpha/worker.js'])
    const [found] = (await findPlugins(into)).plugins
    expect(found.read.files.find(file => file.path === 'extra.js')?.bytes.toString()).toBe('extra')
    expect(found.read.hash).toBe(await hashOf(path.join(into, 'alpha')))
  })
})

describe('a locked zip', () => {
  it('refuses an entry ZipCrypto encrypted, whose bytes no one could read before they run', async () => {
    const { into } = await staging()
    const zip = makeZip([...pluginEntries('alpha', 'alpha'), { name: 'alpha/payload.js', data: Buffer.alloc(40, 7), flags: 1 }])
    expect(await unpackZip(zip, into)).toBe('encrypted')
    expect(await readdir(into)).toEqual([])
  })
})
