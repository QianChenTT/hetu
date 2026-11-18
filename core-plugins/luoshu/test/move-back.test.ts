import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Call, Prepared } from 'hetu-core/api/policy-jobs.ts'
import { createLuoshu, type Luoshu } from '../src/luoshu.ts'

// What another program does right after a move's link, and the unlinks of one path that fail and how
const disk = {
  afterLink: null as null | (() => Promise<void>),
  failing: '',
  fails: 0,
  code: 'EPERM',
}

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    link: (async (from: string, to: string) => {
      await real.link(from, to)
      const act = disk.afterLink
      disk.afterLink = null
      await act?.()
    }) as typeof real.link,
    unlink: (async (file: string) => {
      if (disk.failing !== '' && String(file) === disk.failing && disk.fails > 0) {
        disk.fails--
        throw Object.assign(new Error('held'), { code: disk.code })
      }
      return real.unlink(file)
    }) as typeof real.unlink,
  }
})

const foldsCase = process.platform === 'win32' || process.platform === 'darwin'
const stale = { refused: { code: 'stale' } }

let base: string
let folder: string
let n = 0
const live: Luoshu[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-move-back-')))
  folder = path.join(base, 'notes')
  for (const dir of [path.join(folder, 'box'), path.join(base, 'data'), path.join(base, 'install')]) await mkdir(dir, { recursive: true })
  await writeFile(path.join(folder, 'box', 'm.md'), 'OWN')
})

afterEach(async () => {
  Object.assign(disk, { afterLink: null, failing: '', fails: 0, code: 'EPERM' })
  for (const made of live.splice(0)) made.close()
  await rm(base, { recursive: true, force: true })
})

const at = (...names: string[]) => path.join(folder, ...names)
const names = async (...dir: string[]) => (await readdir(at(...dir))).sort()

// A move of box/m.md to taken.md with a judge that allows the paths prepare gave only. A refusal comes back as
// { refused }
async function moved(): Promise<unknown> {
  const luoshu = createLuoshu({ settleMs: 50 })
  live.push(luoshu)
  luoshu.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
  const call: Call = {
    callId: `c${++n}`, caller: { kind: 'plugin', id: 'beta', half: 'worker', incarnation: 1 }, action: 'luoshu.move',
    args: { from: 'box/m.md', to: 'taken.md' }, deadline: Date.now() + 30000, judge: () => ({ code: 'not-granted' }),
  }
  const prepared = await luoshu.provider.prepare(call) as Prepared
  try {
    return await luoshu.provider.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  }
}

// Right after the link, the caller's note moves out of the from end and another program's note takes it under another
// case, so the file linked is no longer the one the from end holds and the link is taken back
const swapFrom = async () => {
  await rename(at('box', 'm.md'), at('kept.md'))
  await writeFile(at('box', 'M.md'), 'OTHER M')
}

describe.runIf(foldsCase)('a move whose link is taken back', () => {
  it('leaves another program\'s note made at the to end since the link, and answers stale', async () => {
    disk.afterLink = async () => {
      await swapFrom()
      await unlink(at('taken.md'))
      await writeFile(at('taken.md'), 'ANOTHER PROGRAM\'S NEW NOTE')
    }
    expect(await moved()).toEqual(stale)
    expect(await names()).toEqual(['box', 'kept.md', 'taken.md'])
    expect(await readFile(at('taken.md'), 'utf8')).toBe('ANOTHER PROGRAM\'S NEW NOTE')
    expect(await readFile(at('box', 'M.md'), 'utf8')).toBe('OTHER M')
  })

  it('answers failed and leaves no refusal for the caller when the link can\'t be taken back', async () => {
    disk.afterLink = swapFrom
    Object.assign(disk, { failing: at('taken.md'), fails: 1000 })
    const answer = await moved() as { refused: unknown }
    // Anything but a refusal answers failed through the carrier, with a fault for the provider and the call recorded
    expect(answer.refused).toBeInstanceOf(Error)
    expect((answer.refused as Error).message).toMatch(/taken back/)
    expect(await readFile(at('taken.md'), 'utf8')).toBe('OWN')
  }, 15_000)

  it.runIf(process.platform === 'win32')('takes the link back once an unlink held for a moment goes through', async () => {
    disk.afterLink = swapFrom
    Object.assign(disk, { failing: at('taken.md'), fails: 2, code: 'EBUSY' })
    expect(await moved()).toEqual(stale)
    expect(await names()).toEqual(['box', 'kept.md'])
    expect(await names('box')).toEqual(['M.md'])
  })
})

describe('a move whose to end is gone right after the link', () => {
  it('answers stale and leaves the from end as it was', async () => {
    disk.afterLink = () => unlink(at('taken.md'))
    expect(await moved()).toEqual(stale)
    expect(await names()).toEqual(['box'])
    expect(await readFile(at('box', 'm.md'), 'utf8')).toBe('OWN')
  })
})
