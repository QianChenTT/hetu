import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonical, named, type Canonical } from '../lib/canonical.ts'

let base: string
let notes: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-canonical-named-')))
  notes = path.join(base, 'notes')
  await mkdir(path.join(notes, 'box'), { recursive: true })
})

afterEach(async () => {
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
})
