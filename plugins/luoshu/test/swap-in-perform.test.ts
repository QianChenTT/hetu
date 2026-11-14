import { mkdtemp, readdir, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import * as disk from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Caller } from 'hetu-core/api/envelope.ts'
import type { Prepared } from 'hetu-core/api/slots.ts'
import { createLuoshu } from '../src/luoshu.ts'

// Each runs once: the next time the luoshu makes a folder, just before or just after it, or the next time it opens a
// write's temp file, just before
let beforeMkdir: (() => Promise<void>) | null = null
let duringMkdir: (() => Promise<void>) | null = null
let beforeTemp: (() => Promise<void>) | null = null
const once = async (hook: 'before' | 'during' | 'temp') => {
  const then = hook === 'before' ? beforeMkdir : hook === 'during' ? duringMkdir : beforeTemp
  if (hook === 'before') beforeMkdir = null
  else if (hook === 'during') duringMkdir = null
  else beforeTemp = null
  await then?.()
}

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    mkdir: async (...args: Parameters<typeof real.mkdir>) => {
      await once('before')
      const made = await real.mkdir(...args)
      await once('during')
      return made
    },
    open: async (...args: Parameters<typeof real.open>) => {
      if (String(args[0]).endsWith('.hetu-tmp')) await once('temp')
      return real.open(...args)
    },
  }
})

const caller: Caller = { kind: 'window', role: 'editor', n: 0 }
let base: string
let folder: string
let n = 0

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-swap-')))
  folder = path.join(base, 'notes')
  for (const dir of [path.join(folder, '.obsidian', 'plugins', 'x'), path.join(folder, 'journal'), path.join(base, 'data'), path.join(base, 'install')]) {
    await disk.mkdir(dir, { recursive: true })
  }
  await disk.writeFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
  await disk.writeFile(path.join(folder, 'a.md'), 'note a')
})

afterEach(async () => {
  beforeMkdir = null
  duringMkdir = null
  beforeTemp = null
  await rm(base, { recursive: true, force: true })
})

// journal swapped for a junction into the dot folder, as another program racing the call could
async function swap(): Promise<void> {
  await rename(path.join(folder, 'journal'), path.join(folder, 'journal-was'))
  await symlink(path.join(folder, '.obsidian', 'plugins', 'x'), path.join(folder, 'journal'), 'junction')
}

async function performed(action: string, args: unknown): Promise<unknown> {
  const made = createLuoshu()
  made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
  const call = { callId: `c${++n}`, caller, action, args, deadline: Date.now() + 30000 }
  const prepared = await made.provider.prepare(call) as Prepared
  try {
    return await made.provider.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  } finally {
    made.close()
  }
}

const dotFolder = () => readdir(path.join(folder, '.obsidian', 'plugins', 'x'))

// The looks before the folders are made passed, so only the looks once they are made stand between the swap and the
// temp file
describe('a folder swapped for a junction while a write runs', () => {
  it('refuses the write once the folders it needs exist and writes nothing into the dot folder', async () => {
    duringMkdir = swap
    expect(await performed('luoshu.write', { path: 'journal/new/planted.js', text: 'planted' })).toEqual({ refused: { code: 'not-granted' } })
    expect(duringMkdir).toBeNull()
    expect(await dotFolder()).toEqual(['main.js'])
    expect(await readFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
  })

  // The first folder made lands in the dot folder through the junction. The look after it ends the making there
  it('makes the folders one level at a time and none past the first one made through the swapped folder', async () => {
    beforeMkdir = swap
    expect(await performed('luoshu.write', { path: 'journal/new/deeper/planted.js', text: 'planted' })).toEqual({ refused: { code: 'not-granted' } })
    expect(beforeMkdir).toBeNull()
    expect((await dotFolder()).sort()).toEqual(['main.js', 'new'])
    expect(await readdir(path.join(folder, '.obsidian', 'plugins', 'x', 'new'))).toEqual([])
  })

  it('makes no folder past the first one made through the swapped folder for the to end of a move', async () => {
    beforeMkdir = swap
    expect(await performed('luoshu.move', { from: 'a.md', to: 'journal/new/deeper/a.md' })).toEqual({ refused: { code: 'not-granted' } })
    expect(await readdir(path.join(folder, '.obsidian', 'plugins', 'x', 'new'))).toEqual([])
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('note a')
  })

  // The temp file is made in the dot folder through the junction. The look before the rename refuses the write and the
  // temp file is removed by the same path, so neither the note nor the temp file stays there
  it('refuses the write once the temp file is written and leaves neither it nor the note in the dot folder', async () => {
    beforeTemp = swap
    expect(await performed('luoshu.write', { path: 'journal/planted.js', text: 'planted' })).toEqual({ refused: { code: 'not-granted' } })
    expect(beforeTemp).toBeNull()
    expect(await dotFolder()).toEqual(['main.js'])
  })
})
