import { mkdtemp, readdir, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import * as disk from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Caller } from 'hetu-core/api/envelope.ts'
import type { Prepared } from 'hetu-core/api/slots.ts'
import { createLuoshu } from '../src/luoshu.ts'

// Runs once, the next time the luoshu makes the folders a write needs, after they are made
let duringMkdir: (() => Promise<void>) | null = null

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    mkdir: async (...args: Parameters<typeof real.mkdir>) => {
      const made = await real.mkdir(...args)
      const then = duringMkdir
      duringMkdir = null
      await then?.()
      return made
    },
  }
})

const caller: Caller = { kind: 'window', role: 'editor', n: 0 }
let base: string
let folder: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-swap-')))
  folder = path.join(base, 'notes')
  for (const dir of [path.join(folder, '.obsidian', 'plugins', 'x'), path.join(folder, 'journal'), path.join(base, 'data'), path.join(base, 'install')]) {
    await disk.mkdir(dir, { recursive: true })
  }
  await disk.writeFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
})

afterEach(async () => {
  duringMkdir = null
  await rm(base, { recursive: true, force: true })
})

// The look before the version check passed, so only the look once the folders exist stands between the swap and the
// temp file
describe('a folder swapped for a junction while a write runs', () => {
  it('refuses the write once the folders it needs exist and writes nothing into the dot folder', async () => {
    const made = createLuoshu()
    made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
    const call = { callId: 'c1', caller, action: 'luoshu.write', args: { path: 'journal/planted.js', text: 'planted' }, deadline: Date.now() + 30000 }
    const prepared = await made.provider.prepare(call) as Prepared
    duringMkdir = async () => {
      await rename(path.join(folder, 'journal'), path.join(folder, 'journal-was'))
      await symlink(path.join(folder, '.obsidian', 'plugins', 'x'), path.join(folder, 'journal'), 'junction')
    }
    await expect(made.provider.perform(call, prepared)).rejects.toEqual({ code: 'not-granted' })
    made.close()
    expect(duringMkdir).toBeNull()
    expect(await readdir(path.join(folder, '.obsidian', 'plugins', 'x'))).toEqual(['main.js'])
    expect(await readFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
  })
})
