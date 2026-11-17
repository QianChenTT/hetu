import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonical, lastNamed, named, type Canonical } from '../lib/canonical.ts'

// What another program does right before a realpath of the path given, once
const disk = { at: '', before: null as null | (() => Promise<void>) }

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    realpath: (async (...args: Parameters<typeof real.realpath>) => {
      if (disk.before !== null && String(args[0]) === disk.at) {
        const act = disk.before
        disk.before = null
        await act()
      }
      return real.realpath(...args)
    }) as typeof real.realpath,
  }
})

let base: string
let notes: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-canonical-named-')))
  notes = path.join(base, 'notes')
  await mkdir(path.join(notes, 'box'), { recursive: true })
})

afterEach(async () => {
  Object.assign(disk, { at: '', before: null })
  await rm(base, { recursive: true, force: true })
})

const resolved = async (input: string) => (await canonical(notes, input)) as Canonical
const identity = async (absolute: string) => {
  const found = await stat(absolute, { bigint: true })
  return { ino: found.ino, dev: found.dev }
}

describe('a file looked at again by name once it is open', () => {
  it('is held at the path judged when the spelling still names the file, with no judge asked', async () => {
    await writeFile(path.join(notes, 'box', 'n.md'), 'n')
    const target = await resolved('box/n.md')
    const asked: string[] = []
    const found = await named(target, await identity(target.absolute), () => canonical(notes, 'box/n.md'), now => !!asked.push(now.relative))
    expect(found).toEqual({ state: 'held', target })
    expect(asked).toEqual([])
  })

  it('is replaced when the name holds another file than the one opened, with no judge asked', async () => {
    await writeFile(path.join(notes, 'box', 'n.md'), 'n')
    const target = await resolved('box/n.md')
    const opened = await identity(target.absolute)
    await writeFile(path.join(notes, 'box', 'other.md'), 'other')
    await rename(path.join(notes, 'box', 'other.md'), target.absolute)
    const asked: string[] = []
    expect(await named(target, opened, () => canonical(notes, 'box/n.md'), now => !!asked.push(now.relative))).toEqual({ state: 'replaced' })
    expect(asked).toEqual([])
  })

  it('is replaced when the name holds nothing by then', async () => {
    await writeFile(path.join(notes, 'box', 'n.md'), 'n')
    const target = await resolved('box/n.md')
    const opened = await identity(target.absolute)
    await rm(target.absolute)
    expect(await named(target, opened, () => canonical(notes, 'box/n.md'), () => true)).toEqual({ state: 'replaced' })
  })

  it('is moved when the spelling gives another key or nothing canonical', async () => {
    await writeFile(path.join(notes, 'box', 'n.md'), 'n')
    const target = await resolved('box/n.md')
    const opened = await identity(target.absolute)
    expect(await named(target, opened, () => canonical(notes, 'box/m.md'), () => true)).toEqual({ state: 'moved' })
    expect(await named(target, opened, () => canonical(notes, '.git/n.md'), () => true)).toEqual({ state: 'moved' })
  })

  describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('under another case of the last name', () => {
    it('asks the judge about the path the file has and is held there when it allows, moved when it does not', async () => {
      // The caller's spelling at prepare, before a note under another case was made
      const target = await resolved('box/n.md')
      await writeFile(path.join(notes, 'box', 'N.md'), 'other')
      const opened = await identity(target.absolute)
      const asked: string[] = []
      const allowed = await named(target, opened, () => canonical(notes, 'box/n.md'), now => !!asked.push(now.relative))
      expect(allowed).toMatchObject({ state: 'held', target: { relative: 'box/N.md', key: target.key } })
      const refused = await named(target, opened, () => canonical(notes, 'box/n.md'), now => !asked.push(now.relative))
      expect(refused).toEqual({ state: 'moved' })
      expect(asked).toEqual(['box/N.md', 'box/N.md'])
    })
  })

  describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('a name another file or none held while the spelling was resolved', () => {
    // Another program swaps two files at one name: the caller's own note under box/n.md, or no file, while the spelling
    // resolves, the file opened, another note under box/N.md, back by the lstat. The resolve gives the path judged and
    // the lstat, which looks the name up without case, finds the file opened
    it('is replaced when the path resolved is not the one the file opened is stored under, with no judge asked', async () => {
      // The caller's spelling at prepare, before the other note was made
      const target = await resolved('box/n.md')
      await writeFile(path.join(notes, 'box', 'N.md'), 'other')
      const opened = await identity(target.absolute)
      const asked: string[] = []
      const found = await named(target, opened, async () => target, now => !!asked.push(now.relative))
      expect(found).toEqual({ state: 'replaced' })
      expect(asked).toEqual([])
    })

    it('is replaced when another file is stored under the path resolved by the time it resolves to itself', async () => {
      const target = await resolved('box/n.md')
      await writeFile(path.join(notes, 'box', 'N.md'), 'other')
      const opened = await identity(target.absolute)
      // The file opened leaves the name and the caller's own note takes it under the spelling resolved
      disk.at = target.absolute
      disk.before = async () => {
        await rename(path.join(notes, 'box', 'N.md'), path.join(base, 'away.md'))
        await writeFile(target.absolute, 'own')
      }
      expect(await named(target, opened, async () => target, () => true)).toEqual({ state: 'replaced' })
    })
  })
})

describe('the last name alone resolved again once the folder\'s look held', () => {
  it('gives what canonical gives for a note there, spelled as stored or in another case', async () => {
    await writeFile(path.join(notes, 'box', 'N.md'), 'n')
    const target = await resolved('box/N.md')
    expect(await lastNamed(target, 'box/N.md')).toEqual(await canonical(notes, 'box/N.md'))
    expect(await lastNamed(target, 'box/n.md')).toEqual(await canonical(notes, 'box/n.md'))
  })

  it('gives null for a folder swapped for a junction, a dot name and a note in hetu\'s own folder', async () => {
    await writeFile(path.join(notes, 'box', 'n.md'), 'n')
    const target = await resolved('box/n.md')
    await mkdir(path.join(notes, 'other'))
    await writeFile(path.join(notes, 'other', 'n.md'), 'other')
    await rename(path.join(notes, 'box'), path.join(notes, 'was'))
    await symlink(path.join(notes, 'other'), path.join(notes, 'box'), 'junction')
    expect(await lastNamed(target, 'box/n.md')).toBeNull()
    await rm(path.join(notes, 'box'))
    await rename(path.join(notes, 'was'), path.join(notes, 'box'))
    await writeFile(path.join(notes, 'box', '.hidden'), 'dot')
    expect(await lastNamed(target, 'box/.hidden')).toBeNull()
    expect(await lastNamed(target, 'box/n.md', { dataDir: path.join(notes, 'box') })).toBeNull()
    // A folder of hetu's own that can't be resolved, as canonical refuses every path then
    expect(await lastNamed(target, 'box/n.md', { dataDir: path.join(base, 'data') })).toBeNull()
    await mkdir(path.join(base, 'data'))
    expect(await lastNamed(target, 'box/n.md', { dataDir: path.join(base, 'data') })).toEqual(await canonical(notes, 'box/n.md'))
  })
})
