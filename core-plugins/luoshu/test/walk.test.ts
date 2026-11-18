import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Call, Prepared } from 'hetu-core/api/slots.ts'
import { createLuoshu, type Luoshu } from '../src/luoshu.ts'

// The walk's stat of a.md waits until the test lets it go, standing in for a large folder on a busy machine
const held = vi.hoisted(() => ({ name: '', release: () => {}, reached: false }))

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  const stat = (async (file: string, options?: { bigint?: boolean }) => {
    if (options?.bigint === true && held.name !== '' && file === held.name) {
      held.reached = true
      await new Promise<void>(resolve => {
        held.release = resolve
      })
    }
    return fs.stat(file, options)
  }) as typeof fs.stat
  return { ...fs, stat, default: { ...fs, stat } }
})

let base: string
let folder: string
let made: Luoshu | null = null

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-walk-')))
  folder = path.join(base, 'notes')
  for (const dir of [folder, path.join(base, 'data'), path.join(base, 'install')]) await mkdir(dir, { recursive: true })
  await writeFile(path.join(folder, 'a.md'), 'note a')
  held.name = path.join(folder, 'a.md')
  held.reached = false
})

afterEach(async () => {
  held.name = ''
  held.release()
  made?.close()
  made = null
  await rm(base, { recursive: true, force: true })
})

describe('the walk taken when the watch began', () => {
  it('keeps no save waiting while it is still running', async () => {
    made = createLuoshu({ publish: () => {}, settleMs: 100 })
    made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
    await vi.waitFor(() => expect(held.reached).toBe(true))
    const call: Call = { callId: 'w1', caller: { kind: 'window', role: 'editor', n: 0 }, action: 'luoshu.write', args: { path: 'b.md', text: 'saved' }, deadline: Date.now() + 30000 }
    const saving = (async () => made!.provider.perform(call, await made!.provider.prepare(call) as Prepared))()
    const answer = await Promise.race([saving, new Promise(resolve => setTimeout(() => resolve('still waiting'), 2000))])
    expect(answer).toEqual({ version: expect.any(String) })
  })
})
