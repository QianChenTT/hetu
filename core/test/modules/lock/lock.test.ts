import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from '../../../api/envelope.ts'
import type { Call, GuardCall } from '../../../api/policy-jobs.ts'
import { MAX_LOCK_MS, MAX_LOCKS_PER_ROOT } from '../../../backend/lock/header.ts'
import { createLock, type Lock } from '../../../backend/lock/lock.ts'

// The lock module on its own, with a real notes folder for the canonical paths and a clock the test moves

const plugin = (id: string, half = 'worker'): Caller => ({ kind: 'plugin', id, half, incarnation: 1 })
const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const handler = plugin('mcp-http-handler', 'host')
const leases = plugin('leases')

// A chain: the root caller, the onBehalf it set and the caller at the end of it
type Chain = { root: Caller, onBehalf?: string, caller?: Caller }
const agent = (field: string): Chain => ({ root: handler, onBehalf: field, caller: leases })

let base: string
let folder: string
let n = 0

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-lock-')))
  folder = path.join(base, 'notes')
  await mkdir(path.join(base, 'data'))
  await mkdir(path.join(base, 'install'))
  await mkdir(path.join(folder, '.git'), { recursive: true })
  await mkdir(path.join(folder, 'projects'), { recursive: true })
  await writeFile(path.join(folder, 'projects', 'plan.md'), 'plan')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

function made() {
  let now = 1_000_000
  const lock = createLock({ clock: () => now })
  lock.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
  return { lock, pass: (ms: number) => { now += ms } }
}

const callOf = (action: string, args: unknown, chain: Chain): Call => ({
  callId: `c${++n}`, caller: chain.caller ?? chain.root, root: chain.root,
  ...(chain.onBehalf !== undefined ? { onBehalf: chain.onBehalf } : {}),
  action, args, deadline: Date.now() + 30000,
})

// prepare then perform, as the router makes a call. A refusal from either comes back as the value thrown or given
async function ask(lock: Lock, action: string, args: unknown, chain: Chain): Promise<unknown> {
  const call = callOf(action, args, chain)
  const prepared = await lock.provider.prepare(call)
  if (!('scope' in prepared)) return { refused: prepared }
  try {
    return await lock.provider.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  }
}

// What the guard answers a write, remove or move on these canonical paths from a chain
function check(lock: Lock, paths: string[], chain: Chain, action = 'luoshu.write'): unknown {
  const call: GuardCall = {
    callId: `g${++n}`, caller: chain.caller ?? chain.root, root: chain.root,
    ...(chain.onBehalf !== undefined ? { onBehalf: chain.onBehalf } : {}),
    action, scope: { paths },
  }
  return lock.guard.check(call)
}

describe('lock.set', () => {
  it('keeps every other holder off the note and lets its own holder write', async () => {
    const { lock } = made()
    expect(await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, agent('claude-code#1'))).toEqual({ ms: 600000 })
    expect(check(lock, ['projects/plan.md'], agent('claude-code#1'))).toBe('allow')
    expect(check(lock, ['projects/other.md'], { root: plugin('search') })).toBe('allow')
    expect(check(lock, ['projects/plan.md'], { root: plugin('search') })).toBe('deny')
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('deny')
  })

  // The root plugin and the whole field, so each session is its own holder and a plugin in the chain is not
  it('holds the lock for the chain\'s root plugin and its whole onBehalf, whichever plugin in the chain called', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, agent('claude-code#1'))
    expect(check(lock, ['projects/plan.md'], { root: handler, onBehalf: 'claude-code#1', caller: plugin('mcp') })).toBe('allow')
    expect(check(lock, ['projects/plan.md'], agent('claude-code#2'))).toBe('deny')
    expect(check(lock, ['projects/plan.md'], agent('claude-code'))).toBe('deny')
    expect(check(lock, ['projects/plan.md'], { root: handler })).toBe('deny')
    expect(check(lock, ['projects/plan.md'], { root: leases, onBehalf: 'claude-code#1' })).toBe('deny')
  })

  it('takes no holder from the arguments', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000, holder: 'claude-code#2', onBehalf: 'claude-code#2' }, agent('claude-code#1'))
    expect(check(lock, ['projects/plan.md'], agent('claude-code#2'))).toBe('deny')
    expect(check(lock, ['projects/plan.md'], agent('claude-code#1'))).toBe('allow')
  })

  // A window's onBehalf names whose edits a save carries and makes no pair, so the human is one holder
  it('holds a window\'s lock for the window whatever its onBehalf says', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, { root: editor, onBehalf: 'claude-code#1' })
    expect(check(lock, ['projects/plan.md'], { root: { ...editor, n: 2 } })).toBe('allow')
    expect(check(lock, ['projects/plan.md'], agent('claude-code#1'))).toBe('deny')
  })

  it('answers locked with nothing else on a note another holder locks with none of the paths it named locked', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, agent('claude-code#1'))
    const answer = await ask(lock, 'lock.set', { paths: ['projects/new.md', 'projects/plan.md'], ms: 600000 }, agent('claude-code#2'))
    expect(answer).toEqual({ refused: { code: 'locked' } })
    expect(check(lock, ['projects/new.md'], { root: plugin('search') })).toBe('allow')
  })

  it('renews a lock its own holder sets again, from the time of the second set', async () => {
    const { lock, pass } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 1000 }, agent('claude-code#1'))
    pass(900)
    expect(await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 1000 }, agent('claude-code#1'))).toEqual({ ms: 1000 })
    pass(900)
    expect(check(lock, ['projects/plan.md'], agent('claude-code#2'))).toBe('deny')
  })

  // A crashed or switched off holder never keeps a note locked
  it('frees the note once the time is up, for writes and for another holder\'s set', async () => {
    const { lock, pass } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 1000 }, agent('claude-code#1'))
    pass(999)
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('deny')
    pass(1)
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('allow')
    expect(await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 1000 }, agent('claude-code#2'))).toEqual({ ms: 1000 })
  })

  it('cuts a time over the cap to the cap rather than refusing it', async () => {
    const { lock, pass } = made()
    expect(await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: Number.MAX_SAFE_INTEGER }, agent('claude-code#1'))).toEqual({ ms: MAX_LOCK_MS })
    pass(MAX_LOCK_MS - 1)
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('deny')
    pass(1)
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('allow')
  })

  // Pairs together, so one plugin can't fill main with locks by naming new fields
  it('refuses a root plugin past its live locks with quota, the expired ones not counted', async () => {
    const { lock, pass } = made()
    for (let i = 0; i < MAX_LOCKS_PER_ROOT; i += 64) {
      const paths = Array.from({ length: 64 }, (_, j) => `many/${i + j}.md`)
      expect(await ask(lock, 'lock.set', { paths, ms: 1000 }, agent(`claude-code#${i}`))).toEqual({ ms: 1000 })
    }
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('claude-code#new'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, { root: leases })).toEqual({ ms: 1000 })
    pass(1000)
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('claude-code#new'))).toEqual({ ms: 1000 })
  })
})

describe('the canonical paths', () => {
  // Case, Unicode form and spellings of one name meet at one key, as luoshu's latch does
  it('keys a lock by the canonical key, so another spelling of the note is still locked', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['Projects/PLAN.md', 'café.md'], ms: 600000 }, agent('claude-code#1'))
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('deny')
    expect(check(lock, ['café.md'], { root: editor })).toBe('deny')
    expect(check(lock, ['CAFÉ.md'], { root: editor })).toBe('deny')
  })

  it('gives the canonical paths as the scope of every lock action', async () => {
    const { lock } = made()
    for (const action of ['lock.set', 'lock.clear', 'lock.held']) {
      const prepared = await lock.provider.prepare(callOf(action, { paths: ['projects/plan.md', 'new.md'], ms: 1000 }, agent('claude-code#1')))
      expect([action, prepared]).toEqual([action, { scope: { paths: ['projects/plan.md', 'new.md'] } }])
    }
  })

  it('refuses a bad spelling invalid, .git not-granted and every path with no folder open unavailable', async () => {
    const { lock } = made()
    expect(await ask(lock, 'lock.set', { paths: ['a\\b.md'], ms: 1000 }, agent('claude-code#1'))).toEqual({ refused: { code: 'invalid' } })
    expect(await ask(lock, 'lock.set', { paths: ['.git/config'], ms: 1000 }, agent('claude-code#1'))).toEqual({ refused: { code: 'not-granted' } })
    const closed = createLock({ clock: () => 0 })
    expect(await ask(closed, 'lock.held', { paths: ['a.md'] }, agent('claude-code#1'))).toEqual({ refused: { code: 'unavailable' } })
  })

  it('frees every lock when the core opens another folder while the same one again keeps them', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, agent('claude-code#1'))
    const opening = { folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') }
    lock.role.open(opening)
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('deny')
    lock.role.open({ ...opening, folder: path.join(base, 'data') })
    lock.role.open(opening)
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('allow')
  })
})

describe('lock.clear', () => {
  it('lets a plugin clear the locks its own chain holds', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, agent('claude-code#1'))
    expect(await ask(lock, 'lock.clear', { paths: ['PROJECTS/plan.md', 'free.md'] }, agent('claude-code#1'))).toBeNull()
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('allow')
  })

  it('refuses a plugin clearing another holder\'s lock with locked and nothing else, clearing none of the paths', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, agent('claude-code#1'))
    await ask(lock, 'lock.set', { paths: ['mine.md'], ms: 600000 }, agent('claude-code#2'))
    expect(await ask(lock, 'lock.clear', { paths: ['mine.md', 'projects/plan.md'] }, agent('claude-code#2'))).toEqual({ refused: { code: 'locked' } })
    expect(await ask(lock, 'lock.clear', { paths: ['projects/plan.md'] }, { root: editor, caller: leases })).toEqual({ refused: { code: 'locked' } })
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('deny')
    expect(check(lock, ['mine.md'], { root: editor })).toBe('deny')
  })

  // The human taking a note over
  it('lets a window clear any holder\'s lock', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, agent('claude-code#1'))
    expect(await ask(lock, 'lock.clear', { paths: ['projects/plan.md'] }, { root: editor })).toBeNull()
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('allow')
    expect(check(lock, ['projects/plan.md'], agent('claude-code#2'))).toBe('allow')
  })
})

describe('lock.held', () => {
  it('names the paths asked about that any holder locks, as the caller spelled them with no holder named', async () => {
    const { lock, pass } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 1000 }, agent('claude-code#1'))
    await ask(lock, 'lock.set', { paths: ['b.md'], ms: 5000 }, { root: leases })
    const asked = { paths: ['Projects/Plan.md', 'b.md', 'free.md'] }
    expect(await ask(lock, 'lock.held', asked, { root: plugin('git') })).toEqual({ paths: ['Projects/Plan.md', 'b.md'] })
    pass(1000)
    expect(await ask(lock, 'lock.held', asked, { root: plugin('git') })).toEqual({ paths: ['b.md'] })
  })
})

describe('the guard', () => {
  it('answers at once with no promise, from the table alone', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, agent('claude-code#1'))
    const answer = check(lock, ['projects/plan.md'], { root: editor })
    expect(typeof answer).toBe('string')
  })

  it('checks both ends of a move', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, agent('claude-code#1'))
    expect(check(lock, ['free.md', 'projects/plan.md'], { root: editor }, 'luoshu.move')).toBe('deny')
    expect(check(lock, ['projects/plan.md', 'free.md'], { root: editor }, 'luoshu.move')).toBe('deny')
    expect(check(lock, ['free.md', 'other.md'], { root: editor }, 'luoshu.move')).toBe('allow')
  })

  // A call with no paths is no write the router hands it, so it can't answer for one
  it('throws on a call with no paths, which the router counts as guard-down', () => {
    const { lock } = made()
    expect(() => lock.guard.check({ callId: 'x', caller: editor, root: editor, action: 'luoshu.write', scope: {} })).toThrow()
  })
})
