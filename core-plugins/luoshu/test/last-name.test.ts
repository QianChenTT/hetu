import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Call, Prepared } from 'hetu-core/api/policy-jobs.ts'
import { createLuoshu, type Luoshu } from '../src/luoshu.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
let base: string
let folder: string
let n = 0
const live: Luoshu[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-last-name-')))
  folder = path.join(base, 'notes')
  for (const dir of [path.join(folder, 'box'), path.join(base, 'data'), path.join(base, 'install'), path.join(base, 'bin')]) await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  for (const made of live.splice(0)) made.close()
  await rm(base, { recursive: true, force: true })
})

function opened(): Luoshu {
  const made = createLuoshu({ settleMs: 50 })
  live.push(made)
  let binned = 0
  const trash = async (absolute: string) => {
    await rename(absolute, path.join(base, 'bin', `${++binned}-${path.basename(absolute)}`))
  }
  made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install'), trash })
  return made
}

// A call whose judge answers as the gate would for a caller granted the paths allowed and keeps each ask
function judging(action: string, args: unknown, allowed: (paths: readonly string[]) => boolean) {
  const asked: string[][] = []
  const call: Call = {
    callId: `c${++n}`, caller: { kind: 'plugin', id: 'beta', half: 'worker', incarnation: 1 }, action, args, deadline: Date.now() + 30000,
    judge: (paths: readonly string[]) => {
      asked.push([...paths])
      return allowed(paths) ? null : { code: 'not-granted' }
    },
  }
  return { call, asked }
}

// prepare, what another program does on the disk, then perform. A refusal from either comes back as { refused }
async function across(luoshu: Luoshu, call: Call, between: () => Promise<void>): Promise<unknown> {
  const prepared = await luoshu.provider.prepare(call)
  if (!('scope' in prepared)) return { refused: prepared }
  await between()
  try {
    return await luoshu.provider.perform(call, prepared as Prepared)
  } catch (err) {
    return { refused: err }
  }
}

const at = (...names: string[]) => path.join(folder, ...names)
const names = async (...dir: string[]) => (await readdir(at(...dir))).sort()
const only = (...paths: string[]) => (asked: readonly string[]) => asked.length === paths.length && asked.every((one, i) => one === paths[i])
const notGranted = { refused: { code: 'not-granted' } }

// Windows and macOS read two cases of one name as one file
describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('a note another program makes under another case of its last name after prepare', () => {
  it('refuses a read the gate allows only under the case prepare kept', async () => {
    const { call, asked } = judging('luoshu.read', { path: 'box/n.md' }, only('box/n.md'))
    expect(await across(opened(), call, () => writeFile(at('box', 'N.md'), 'OTHER N'))).toEqual(notGranted)
    expect(asked).toEqual([['box/N.md']])
  })

  it('reads the note under the case it has when the gate allows that case', async () => {
    const { call, asked } = judging('luoshu.read', { path: 'box/n.md' }, () => true)
    expect(await across(opened(), call, () => writeFile(at('box', 'N.md'), 'OTHER N'))).toEqual({ text: 'OTHER N', version: sha('OTHER N'), path: 'box/N.md' })
    expect(asked).toEqual([['box/N.md']])
  })

  it('refuses a read of a note the human renamed in case to a caller granted the old case only', async () => {
    await writeFile(at('box', 'n.md'), 'own note')
    const { call, asked } = judging('luoshu.read', { path: 'box/n.md' }, only('box/n.md'))
    expect(await across(opened(), call, () => rename(at('box', 'n.md'), at('box', 'N.md')))).toEqual(notGranted)
    expect(asked).toEqual([['box/N.md']])
  })

  it('refuses a read with no judge on the call', async () => {
    const { call } = judging('luoshu.read', { path: 'box/n.md' }, () => true)
    expect(await across(opened(), { ...call, judge: undefined }, () => writeFile(at('box', 'N.md'), 'OTHER N'))).toEqual(notGranted)
  })

  it('refuses a move from the case prepare kept and leaves both ends as they were', async () => {
    const { call, asked } = judging('luoshu.move', { from: 'box/m.md', to: 'taken.md' }, only('box/m.md', 'taken.md'))
    expect(await across(opened(), call, () => writeFile(at('box', 'M.md'), 'OTHER M'))).toEqual(notGranted)
    expect(asked).toEqual([['box/M.md', 'taken.md']])
    expect(await names('box')).toEqual(['M.md'])
    expect(await names()).toEqual(['box'])
  })

  it('moves the note under the case it has when the gate allows that case for the from end', async () => {
    const { call, asked } = judging('luoshu.move', { from: 'box/m.md', to: 'taken.md' }, () => true)
    expect(await across(opened(), call, () => writeFile(at('box', 'M.md'), 'OTHER M'))).toBe(null)
    expect(asked).toEqual([['box/M.md', 'taken.md']])
    expect(await names('box')).toEqual([])
    expect(await readFile(at('taken.md'), 'utf8')).toBe('OTHER M')
  })

  it('refuses the to end of a move that only changes the spelling once the from end resolves to another case', async () => {
    await writeFile(at('box', 'm.md'), 'own note')
    const { call, asked } = judging('luoshu.move', { from: 'box/m.md', to: 'box/mm.md' }, only('box/m.md', 'box/mm.md'))
    expect(await across(opened(), call, () => rename(at('box', 'm.md'), at('box', 'M.md')))).toEqual(notGranted)
    expect(asked).toEqual([['box/M.md', 'box/mm.md']])
    expect(await names('box')).toEqual(['M.md'])
  })

  it('refuses a remove at the other note\'s version under the case prepare kept and leaves the note', async () => {
    const { call, asked } = judging('luoshu.remove', { path: 'box/r.md', baseVersion: sha('OTHER R') }, only('box/r.md'))
    expect(await across(opened(), call, () => writeFile(at('box', 'R.md'), 'OTHER R'))).toEqual(notGranted)
    expect(asked).toEqual([['box/R.md']])
    expect(await names('box')).toEqual(['R.md'])
  })

  it('refuses a write at the other note\'s version under the case prepare kept and leaves the note', async () => {
    const { call, asked } = judging('luoshu.write', { path: 'box/w.md', text: 'MINE', baseVersion: sha('OTHER W') }, only('box/w.md'))
    expect(await across(opened(), call, () => writeFile(at('box', 'W.md'), 'OTHER W'))).toEqual(notGranted)
    expect(asked).toEqual([['box/W.md']])
    expect(await names('box')).toEqual(['W.md'])
    expect(await readFile(at('box', 'W.md'), 'utf8')).toBe('OTHER W')
  })
})
