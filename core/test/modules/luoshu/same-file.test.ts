import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Call, Prepared } from '../../../api/policy-jobs.ts'
import { createLuoshu, type Luoshu } from '../../../backend/providers/luoshu/luoshu.ts'

// What another program does to the disk once the version check has closed the note it read, or once the look at a
// move's from end has compared the file at the name with the one looked at
const disk = {
  // The note whose version check's close runs afterClose, once
  name: '',
  afterClose: null as null | (() => Promise<void>),
  // The from end whose second lstat by file id, the one the look makes, runs afterLook, once
  looked: '',
  lstats: 0,
  afterLook: null as null | (() => Promise<void>),
}

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      if (disk.afterClose !== null && String(args[0]) === disk.name && typeof args[1] === 'number') {
        const close = handle.close.bind(handle)
        handle.close = async () => {
          await close()
          const act = disk.afterClose
          disk.afterClose = null
          await act?.()
        }
      }
      return handle
    }) as typeof real.open,
    lstat: (async (...args: Parameters<typeof real.lstat>) => {
      const found = await real.lstat(...args)
      if (disk.afterLook !== null && String(args[0]) === disk.looked && ++disk.lstats === 2) {
        const act = disk.afterLook
        disk.afterLook = null
        await act()
      }
      return found
    }) as typeof real.lstat,
  }
})

const foldsCase = process.platform === 'win32' || process.platform === 'darwin'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const stale = { refused: { code: 'stale' } }

let base: string
let folder: string
let n = 0
const live: Luoshu[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-same-file-')))
  folder = path.join(base, 'notes')
  for (const dir of [path.join(folder, 'box'), path.join(base, 'hold'), path.join(base, 'bin'), path.join(base, 'data'), path.join(base, 'install')]) await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  Object.assign(disk, { name: '', afterClose: null, looked: '', lstats: 0, afterLook: null })
  for (const made of live.splice(0)) made.close()
  await rm(base, { recursive: true, force: true })
})

const at = (...names: string[]) => path.join(folder, ...names)
const names = async (...dir: string[]) => (await readdir(at(...dir))).sort()

// prepare and perform with a judge that allows the paths prepare gave only. A refusal comes back as { refused }
async function performed(action: string, args: unknown): Promise<unknown> {
  const luoshu = createLuoshu({ settleMs: 50 })
  live.push(luoshu)
  let binned = 0
  const trash = async (absolute: string) => {
    await rename(absolute, path.join(base, 'bin', `${++binned}-${path.basename(absolute)}`))
  }
  luoshu.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install'), trash })
  const call: Call = {
    callId: `c${++n}`, caller: { kind: 'plugin', id: 'beta', half: 'worker', incarnation: 1 }, action, args, deadline: Date.now() + 30000,
    judge: () => ({ code: 'not-granted' }),
  }
  const prepared = await luoshu.provider.prepare(call) as Prepared
  try {
    return await luoshu.provider.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  }
}

// The caller's note moves out of the name and another program's note takes it under another case
const swapped = (name: string, other: string) => async () => {
  await rename(at('box', name), path.join(base, 'hold', name))
  await writeFile(at('box', other), 'OTHER')
}

describe.runIf(foldsCase)('a note swapped at its name for another program\'s note after the version check', () => {
  it('is not written over: the write answers stale and the other note stays', async () => {
    await writeFile(at('box', 'n.md'), 'OWN')
    Object.assign(disk, { name: at('box', 'n.md'), afterClose: swapped('n.md', 'N.md') })
    expect(await performed('luoshu.write', { path: 'box/n.md', text: 'MINE', baseVersion: sha('OWN') })).toEqual(stale)
    expect(await names('box')).toEqual(['N.md'])
    expect(await readFile(at('box', 'N.md'), 'utf8')).toBe('OTHER')
  })

  it('is not sent to the bin: the remove answers stale and the other note stays', async () => {
    await writeFile(at('box', 'n.md'), 'OWN')
    Object.assign(disk, { name: at('box', 'n.md'), afterClose: swapped('n.md', 'N.md') })
    expect(await performed('luoshu.remove', { path: 'box/n.md', baseVersion: sha('OWN') })).toEqual(stale)
    expect(await names('box')).toEqual(['N.md'])
    expect(await readdir(path.join(base, 'bin'))).toEqual([])
  })

  it('is not renamed in place: the move answers stale and the other note keeps its name', async () => {
    await writeFile(at('box', 'm.md'), 'OWN')
    Object.assign(disk, { looked: at('box', 'm.md'), afterLook: swapped('m.md', 'm.MD') })
    expect(await performed('luoshu.move', { from: 'box/m.md', to: 'box/M.md' })).toEqual(stale)
    expect(await names('box')).toEqual(['m.MD'])
  })
})

describe('a note left as it was after the version check', () => {
  it('is written over, removed and renamed in place as before', async () => {
    await writeFile(at('box', 'w.md'), 'OWN')
    expect(await performed('luoshu.write', { path: 'box/w.md', text: 'MINE', baseVersion: sha('OWN') })).toEqual({ version: sha('MINE') })
    await writeFile(at('box', 'r.md'), 'OWN')
    expect(await performed('luoshu.remove', { path: 'box/r.md', baseVersion: sha('OWN') })).toBeNull()
    await writeFile(at('box', 'm.md'), 'OWN')
    expect(await performed('luoshu.move', { from: 'box/m.md', to: 'box/M.md' })).toBeNull()
    expect(await names('box')).toEqual(foldsCase ? ['M.md', 'w.md'] : ['M.md', 'w.md'])
    expect(await readdir(path.join(base, 'bin'))).toEqual(['1-r.md'])
  })
})
