import { mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Call, Prepared } from 'hetu-core/api/policy-jobs.ts'
import { createLuoshu, type Luoshu } from '../src/luoshu.ts'

// What another program does to the disk right after an open or right before a link of the name given, as many times
// as times says
const racing = { name: '', times: 0, opens: 0, after: async () => {}, noLinks: false }

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      if (racing.name !== '' && String(args[0]) === racing.name) {
        racing.opens++
        if (racing.times > 0) {
          racing.times--
          await racing.after()
        }
      }
      return handle
    }) as typeof real.open,
    link: (async (from: string, to: string) => {
      // A volume with no hard links
      if (racing.noLinks) throw Object.assign(new Error('no links'), { code: 'ENOTSUP' })
      if (racing.name !== '' && from === racing.name && racing.times > 0) {
        racing.times--
        await racing.after()
      }
      return real.link(from, to)
    }) as typeof real.link,
  }
})

let base: string
let folder: string
let n = 0
const live: Luoshu[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-reopen-')))
  folder = path.join(base, 'notes')
  for (const dir of [path.join(folder, 'box'), path.join(base, 'data'), path.join(base, 'install')]) await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  Object.assign(racing, { name: '', times: 0, opens: 0, after: async () => {}, noLinks: false })
  for (const made of live.splice(0)) made.close()
  await rm(base, { recursive: true, force: true })
})

const at = (...names: string[]) => path.join(folder, ...names)

async function performed(action: string, args: unknown, allowed: (paths: readonly string[]) => boolean, between = async () => {}): Promise<unknown> {
  const luoshu = createLuoshu({ settleMs: 50 })
  live.push(luoshu)
  luoshu.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
  const call: Call = {
    callId: `c${++n}`, caller: { kind: 'plugin', id: 'beta', half: 'worker', incarnation: 1 }, action, args, deadline: Date.now() + 30000,
    judge: (paths: readonly string[]) => (allowed(paths) ? null : { code: 'not-granted' }),
  }
  const prepared = await luoshu.provider.prepare(call) as Prepared
  await between()
  try {
    return await luoshu.provider.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  }
}

// Windows refuses a rename over a file held open, so the one opened moves away first
const replaced = (name: string, text: string) => async () => {
  await writeFile(`${name}.next`, text)
  await rename(name, `${name}.was${racing.opens}`)
  await rename(`${name}.next`, name)
}

describe('a note replaced at its name after the open', () => {
  it('is opened again and the read answers the note as it is now', async () => {
    await writeFile(at('box', 'n.md'), 'first')
    Object.assign(racing, { name: at('box', 'n.md'), times: 1, after: replaced(at('box', 'n.md'), 'second') })
    expect(await performed('luoshu.read', { path: 'box/n.md' }, () => true)).toMatchObject({ text: 'second', path: 'box/n.md' })
    expect(racing.opens).toBe(2)
  })

  it('answers stale once it is replaced after each of three opens', async () => {
    await writeFile(at('box', 'n.md'), 'first')
    Object.assign(racing, { name: at('box', 'n.md'), times: 3, after: replaced(at('box', 'n.md'), 'again') })
    expect(await performed('luoshu.read', { path: 'box/n.md' }, () => true)).toEqual({ refused: { code: 'stale' } })
    expect(racing.opens).toBe(3)
  })
})

describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('a move whose from end another program swaps for a note under another case just before the link', () => {
  it('takes the link back and refuses the move when the gate allows the case prepare kept only', async () => {
    await writeFile(at('box', 'm.md'), 'own note')
    Object.assign(racing, {
      name: at('box', 'm.md'),
      times: 1,
      after: async () => {
        await rename(at('box', 'm.md'), at('kept.md'))
        await writeFile(at('box', 'M.md'), 'OTHER M')
      },
    })
    const paths = (asked: readonly string[]) => asked[0] === 'box/m.md' && asked[1] === 'taken.md'
    expect(await performed('luoshu.move', { from: 'box/m.md', to: 'taken.md' }, paths)).toEqual({ refused: { code: 'not-granted' } })
    expect((await readdir(folder)).sort()).toEqual(['box', 'kept.md'])
    expect(await readdir(at('box'))).toEqual(['M.md'])
  })

  it('refuses a move on a volume with no hard links once the from end resolves to a note another program made under another case', async () => {
    racing.noLinks = true
    const paths = (asked: readonly string[]) => asked[0] === 'box/m.md' && asked[1] === 'taken.md'
    const made = await performed('luoshu.move', { from: 'box/m.md', to: 'taken.md' }, paths, () => writeFile(at('box', 'M.md'), 'OTHER M'))
    expect(made).toEqual({ refused: { code: 'not-granted' } })
    expect(await readdir(folder)).toEqual(['box'])
    expect(await readdir(at('box'))).toEqual(['M.md'])
  })
})
