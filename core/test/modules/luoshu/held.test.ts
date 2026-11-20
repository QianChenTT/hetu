import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from '../../../api/envelope.ts'
import type { Call } from '../../../api/policy-jobs.ts'
import { createLuoshu, type Luoshu } from '../../../backend/providers/luoshu/luoshu.ts'

// What luoshu keeps for a call between prepare and its end comes back to nothing once the call ends, a call refused at
// prepare included, since the router releases only a call that prepare took

const window: Caller = { kind: 'window', role: 'editor', n: 0 }
let root: string
let notes: string
let id = 0

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-held-')))
  notes = path.join(root, 'notes')
  await mkdir(path.join(root, 'data'))
  await mkdir(path.join(root, 'install'))
  await mkdir(path.join(notes, '.git'), { recursive: true })
  await writeFile(path.join(notes, 'kept.md'), 'kept')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function started(): Luoshu {
  const made = createLuoshu()
  made.role.open({ folder: notes, dataDir: path.join(root, 'data'), installDir: path.join(root, 'install') })
  return made
}

const call = (action: string, args: unknown): Call => ({
  callId: `held${++id}`, caller: window, root: window, action, args, deadline: Date.now() + 30000,
})

describe('what luoshu holds for a call', () => {
  it('holds something from a prepare it took until the call is released', async () => {
    const made = started()
    const one = call('luoshu.read', { path: 'kept.md' })
    const prepared = await made.provider.prepare(one)
    expect('scope' in prepared).toBe(true)
    expect(made.calls()).toBe(1)
    made.provider.release?.(one, prepared as never)
    expect(made.calls()).toBe(0)
  })

  it('holds nothing once a call it took has performed', async () => {
    const made = started()
    const one = call('luoshu.read', { path: 'kept.md' })
    const prepared = await made.provider.prepare(one)
    await made.provider.perform(one, prepared as never)
    expect(made.calls()).toBe(0)
  })

  it.each([
    ['a path that is no text', 'luoshu.read', { path: 7 }],
    ['a dot folder', 'luoshu.read', { path: '.git/config' }],
    ['a path out of the folder', 'luoshu.write', { path: '../out.md', text: 'x' }],
    ['a listed folder that is no text', 'luoshu.list', { folder: 7 }],
    ['a move with no to', 'luoshu.move', { from: 'kept.md' }],
    ['a move to a dot folder', 'luoshu.move', { from: 'kept.md', to: '.git/kept.md' }],
  ])('holds nothing after a prepare it refused for %s', async (_, action, args) => {
    const made = started()
    const answer = await made.provider.prepare(call(action, args))
    expect('code' in answer).toBe(true)
    expect(made.calls()).toBe(0)
  })
})
