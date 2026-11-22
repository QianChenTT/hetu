import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from '../../../api/envelope.ts'
import type { Call, GuardCall } from '../../../api/policy-jobs.ts'
import { MAX_LOCK_MS, MAX_LOCKS_PER_CLIENT, MAX_LOCKS_PER_ROOT } from '../../../backend/lock/header.ts'
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

// The wall clock stands this far ahead of the module's, so an end told in wall time shows it was turned
const WALL = 1_700_000_000_000

// told holds each lock.changed the module published, once the step that noticed it ended. publish throws while throws
// is set
function made() {
  let now = 1_000_000
  const told: { path: string, change: unknown }[] = []
  const state = { throws: false }
  const lock = createLock({
    clock: () => now,
    wall: () => WALL + now,
    publish: (path, change) => {
      if (state.throws) throw new Error('the bus broke')
      told.push({ path, change })
    },
  })
  lock.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
  return { lock, told, state, pass: (ms: number) => { now += ms } }
}

// The step that noticed a change ended, so what it told has gone out
const flushed = () => new Promise<void>(resolve => { setImmediate(resolve) })
const locked = (path: string, until: number) => ({ path, change: { locked: true, until: WALL + until } })
const unlocked = (path: string) => ({ path, change: { locked: false, until: null } })

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

// Sets count locks on many/<prefix><i>.md for a chain, 64 paths a call, each set taken
async function fill(lock: Lock, prefix: string, count: number, chain: Chain): Promise<void> {
  for (let i = 0; i < count; i += 64) {
    const paths = Array.from({ length: Math.min(64, count - i) }, (_, j) => `many/${prefix}${i + j}.md`)
    expect(await ask(lock, 'lock.set', { paths, ms: 1000 }, chain)).toEqual({ ms: 1000 })
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

  // Pairs together, so one plugin can't fill main with locks by naming new fields. Each client its own, so the root's
  // cap is reached past the clients' own
  it('refuses a root plugin past its live locks with quota, the expired ones not counted', async () => {
    const { lock, pass } = made()
    for (let i = 0; i < MAX_LOCKS_PER_ROOT; i += 64) {
      const paths = Array.from({ length: 64 }, (_, j) => `many/${i + j}.md`)
      expect(await ask(lock, 'lock.set', { paths, ms: 1000 }, agent(`client-${i}#1`))).toEqual({ ms: 1000 })
    }
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('client-new#1'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, { root: leases })).toEqual({ ms: 1000 })
    pass(1000)
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('client-new#1'))).toEqual({ ms: 1000 })
  // A thousand paths each turned canonical on the disk, past five seconds on a busy Windows machine
  }, 60_000)

  // The field up to its first # as a pair's grants are keyed, so a client opening more sessions gets no more locks
  it('holds a client\'s sessions under one root to MAX_LOCKS_PER_CLIENT live locks together while another client still takes', async () => {
    const { lock } = made()
    await fill(lock, 'a', MAX_LOCKS_PER_CLIENT / 2, agent('claude-code#1'))
    await fill(lock, 'b', MAX_LOCKS_PER_CLIENT / 2, agent('claude-code#2'))
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('claude-code#3'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('claude-code'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(lock, 'lock.set', { paths: ['many/a0.md', 'one.md'], ms: 1000 }, agent('claude-code#1'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(check(lock, ['one.md'], { root: editor })).toBe('allow')
    expect(await ask(lock, 'lock.set', { paths: ['many/a0.md', 'many/a1.md'], ms: 1000 }, agent('claude-code#1'))).toEqual({ ms: 1000 })
    await fill(lock, 'c', MAX_LOCKS_PER_CLIENT, agent('codex#1'))
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('codex#2'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
  }, 60_000)

  // grantKeyOf's split, so a session name holding a # of its own is still the same client
  it('takes the client from a field up to its first # when the field holds two', async () => {
    const { lock } = made()
    await fill(lock, 'a', MAX_LOCKS_PER_CLIENT / 2, agent('claude-code#1#x'))
    await fill(lock, 'b', MAX_LOCKS_PER_CLIENT / 2, agent('claude-code#2'))
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('claude-code#3'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('claude-code#1#y'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
  }, 60_000)

  it('gives a client its count back as its sessions\' locks clear and expire', async () => {
    const { lock, pass } = made()
    await fill(lock, 'a', MAX_LOCKS_PER_CLIENT, agent('claude-code#1'))
    const first = Array.from({ length: 64 }, (_, i) => `many/a${i}.md`)
    expect(await ask(lock, 'lock.clear', { paths: first }, agent('claude-code#1'))).toBeNull()
    await fill(lock, 'c', 64, agent('claude-code#2'))
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('claude-code#2'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    pass(1000)
    await fill(lock, 'd', MAX_LOCKS_PER_CLIENT, agent('claude-code#3'))
  }, 60_000)

  // A plugin calling with no field holds as itself, one client beside its pairs' clients, under the same cap
  it('counts a root plugin\'s locks with no onBehalf as a client of its own, held to the same cap', async () => {
    const { lock } = made()
    await fill(lock, 'a', MAX_LOCKS_PER_CLIENT, { root: handler })
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, { root: handler })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(lock, 'lock.set', { paths: ['one.md'], ms: 1000 }, agent('claude-code#1'))).toEqual({ ms: 1000 })
  }, 60_000)
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

  // The clear needs no grant, so its answer must not tell a plugin whether another holder locks a path
  it('leaves another holder\'s lock where a plugin clears, answering as for a path no one locks', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 600000 }, agent('claude-code#1'))
    await ask(lock, 'lock.set', { paths: ['mine.md'], ms: 600000 }, agent('claude-code#2'))
    const free = await ask(lock, 'lock.clear', { paths: ['free.md'] }, agent('claude-code#2'))
    expect(await ask(lock, 'lock.clear', { paths: ['mine.md', 'projects/plan.md'] }, agent('claude-code#2'))).toEqual(free)
    expect(await ask(lock, 'lock.clear', { paths: ['projects/plan.md'] }, { root: editor, caller: leases })).toEqual(free)
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('deny')
    expect(check(lock, ['mine.md'], { root: editor })).toBe('allow')
  })

  // With no gate before prepare, a refusal from the disk would tell a link out of the notes folder from a plain name
  it('answers a plugin\'s clear on a path canonical refuses as on a missing name, clearing nothing', async () => {
    const { lock } = made()
    await mkdir(path.join(base, 'outside'))
    await symlink(path.join(base, 'outside'), path.join(folder, 'linked'), 'junction')
    const missing = await ask(lock, 'lock.clear', { paths: ['plainmissing/x.md'] }, { root: plugin('search') })
    expect(missing).toBeNull()
    for (const paths of [['linked/x.md'], ['.git/config'], ['plainmissing/x.md', 'linked/x.md']]) {
      expect([paths, await ask(lock, 'lock.clear', { paths }, { root: plugin('search') })]).toEqual([paths, missing])
    }
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
  it('answers one entry per lock asked about, its path as the caller spelled it with its end and no holder named', async () => {
    const { lock, pass } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 1000 }, agent('claude-code#1'))
    await ask(lock, 'lock.set', { paths: ['b.md'], ms: 5000 }, { root: leases })
    const asked = { paths: ['Projects/Plan.md', 'b.md', 'free.md'] }
    expect(await ask(lock, 'lock.held', asked, { root: plugin('git') })).toStrictEqual({
      locks: [{ path: 'Projects/Plan.md', until: WALL + 1_001_000 }, { path: 'b.md', until: WALL + 1_005_000 }],
    })
    pass(1000)
    expect(await ask(lock, 'lock.held', asked, { root: plugin('git') })).toStrictEqual({ locks: [{ path: 'b.md', until: WALL + 1_005_000 }] })
  })

  it('leaves out a path no lock holds and an expired lock, answering an empty list when none is held', async () => {
    const { lock, pass } = made()
    await ask(lock, 'lock.set', { paths: ['a.md'], ms: 1000 }, { root: leases })
    expect(await ask(lock, 'lock.held', { paths: ['free.md', 'a.md'] }, { root: plugin('git') }))
      .toStrictEqual({ locks: [{ path: 'a.md', until: WALL + 1_001_000 }] })
    pass(1000)
    expect(await ask(lock, 'lock.held', { paths: ['free.md', 'a.md'] }, { root: plugin('git') })).toStrictEqual({ locks: [] })
  })

  it('answers in the order the call names the paths, each spelling of one note an entry of its own', async () => {
    const { lock } = made()
    await ask(lock, 'lock.set', { paths: ['b.md'], ms: 2000 }, { root: leases })
    await ask(lock, 'lock.set', { paths: ['a.md'], ms: 1000 }, agent('claude-code#1'))
    expect(await ask(lock, 'lock.held', { paths: ['a.md', 'free.md', 'b.md', 'A.md'] }, { root: plugin('git') })).toStrictEqual({
      locks: [{ path: 'a.md', until: WALL + 1_001_000 }, { path: 'b.md', until: WALL + 1_002_000 }, { path: 'A.md', until: WALL + 1_001_000 }],
    })
  })

  it('reads each end off the wall clock when asked, not the end told when the lock was set', async () => {
    let now = 0
    let wall = WALL
    const lock = createLock({ clock: () => now, wall: () => wall })
    lock.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
    await ask(lock, 'lock.set', { paths: ['a.md'], ms: 1000 }, { root: leases })
    now = 400
    wall = WALL + 60_000
    expect(await ask(lock, 'lock.held', { paths: ['a.md'] }, { root: plugin('git') })).toStrictEqual({ locks: [{ path: 'a.md', until: WALL + 60_600 }] })
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

describe('lock.changed', () => {
  it('tells each path a set locks with when its lock ends in wall time and never who holds it', async () => {
    const { lock, told } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md', 'new.md', 'NEW.md'], ms: 60_000 }, agent('claude-code#1'))
    await flushed()
    expect(told).toEqual([locked('projects/plan.md', 1_060_000), locked('new.md', 1_060_000)])
    expect(JSON.stringify(told)).not.toMatch(/claude-code|mcp-http-handler|holder|onBehalf/)
  })

  // A clock reads fractions of a millisecond, so two renewals a moment apart end at different readings that tell the
  // same whole millisecond
  it('tells a renewal that moves the end by a whole millisecond and nothing for one whose end rounds to the one told', async () => {
    const { lock, told, pass } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 1000 }, agent('claude-code#1'))
    pass(0.3)
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 1000 }, agent('claude-code#1'))
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 1000 }, agent('claude-code#1'))
    // The renewal not told still moved the end past the first one
    pass(999.9)
    expect(check(lock, ['projects/plan.md'], { root: editor })).toBe('deny')
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 5000 }, agent('claude-code#1'))
    await flushed()
    expect(told).toEqual([locked('projects/plan.md', 1_001_000), locked('projects/plan.md', 1_006_000)])
  })

  it('tells nothing for a set refused locked, quota or invalid', async () => {
    const { lock, told } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 1000 }, agent('claude-code#1'))
    expect(await ask(lock, 'lock.set', { paths: ['other.md', 'projects/plan.md'], ms: 1000 }, agent('claude-code#2')))
      .toEqual({ refused: { code: 'locked' } })
    expect(await ask(lock, 'lock.set', { paths: ['other.md'], ms: 0 }, agent('claude-code#2'))).toEqual({ refused: { code: 'invalid' } })
    await fill(lock, 'q', MAX_LOCKS_PER_CLIENT, { root: leases })
    await flushed()
    told.length = 0
    expect(await ask(lock, 'lock.set', { paths: ['other.md'], ms: 1000 }, { root: leases })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    await flushed()
    expect(told).toEqual([])
  })

  it('tells each path a clear unlocks and nothing for a path the clear leaves or no one locked', async () => {
    const { lock, told } = made()
    await ask(lock, 'lock.set', { paths: ['projects/plan.md'], ms: 60_000 }, agent('claude-code#1'))
    await ask(lock, 'lock.set', { paths: ['mine.md'], ms: 60_000 }, agent('claude-code#2'))
    await flushed()
    told.length = 0
    await ask(lock, 'lock.clear', { paths: ['projects/plan.md', 'free.md', 'mine.md'] }, agent('claude-code#2'))
    await flushed()
    expect(told).toEqual([unlocked('mine.md')])
    await ask(lock, 'lock.clear', { paths: ['projects/plan.md', 'free.md'] }, { root: editor })
    await flushed()
    expect(told).toEqual([unlocked('mine.md'), unlocked('projects/plan.md')])
  })

  it('tells an expiry once, when a check, a look or a set on the note notices it and not before', async () => {
    const { lock, told, pass } = made()
    for (const name of ['a.md', 'b.md', 'c.md']) await ask(lock, 'lock.set', { paths: [name], ms: 1000 }, agent('claude-code#1'))
    await flushed()
    told.length = 0
    pass(1000)
    await flushed()
    expect(told).toEqual([])
    expect(check(lock, ['a.md'], { root: editor })).toBe('allow')
    expect(check(lock, ['a.md'], { root: editor })).toBe('allow')
    await flushed()
    expect(told).toEqual([unlocked('a.md')])
    await ask(lock, 'lock.held', { paths: ['b.md'] }, { root: plugin('git') })
    await ask(lock, 'lock.set', { paths: ['c.md'], ms: 1000 }, agent('claude-code#2'))
    await flushed()
    expect(told).toEqual([unlocked('a.md'), unlocked('b.md'), unlocked('c.md'), locked('c.md', 1_002_000)])
  })

  it('tells nothing from inside the guard\'s step, only once that step ended', async () => {
    const { lock, told, pass } = made()
    await ask(lock, 'lock.set', { paths: ['a.md'], ms: 1000 }, agent('claude-code#1'))
    await flushed()
    told.length = 0
    pass(1000)
    check(lock, ['a.md'], { root: editor })
    expect(told).toEqual([])
    await flushed()
    expect(told).toEqual([unlocked('a.md')])
  })

  // Every lock it held named a note of the folder before, so each is told unlocked, expired ones not yet told included
  // At once, while the grants that applied to the old folder's notes still stand
  it('tells every lock another folder frees unlocked at once and nothing when the same folder opens again', async () => {
    const { lock, told, pass } = made()
    await ask(lock, 'lock.set', { paths: ['a.md'], ms: 1000 }, agent('claude-code#1'))
    await ask(lock, 'lock.set', { paths: ['b.md'], ms: 60_000 }, { root: editor })
    pass(1000)
    await flushed()
    told.length = 0
    const opening = { folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') }
    lock.role.open(opening)
    await flushed()
    expect(told).toEqual([])
    lock.role.open({ ...opening, folder: path.join(base, 'data') })
    expect(told).toEqual([unlocked('a.md'), unlocked('b.md')])
    await flushed()
    expect(told).toHaveLength(2)
  })

  it('answers every lock action as before when its publish throws', async () => {
    const { lock, state } = made()
    state.throws = true
    expect(await ask(lock, 'lock.set', { paths: ['a.md'], ms: 1000 }, agent('claude-code#1'))).toEqual({ ms: 1000 })
    expect(check(lock, ['a.md'], { root: editor })).toBe('deny')
    expect(await ask(lock, 'lock.clear', { paths: ['a.md'] }, agent('claude-code#1'))).toBeNull()
    await flushed()
    expect(check(lock, ['a.md'], { root: editor })).toBe('allow')
  })
})

describe('the lock released', () => {
  // Its module switched off or failed: no guard holds any lock, so each is told unlocked at once, an expired one not yet
  // told included, and the table starts empty
  it('tells every lock unlocked at once, frees them all and tells nothing locked again', async () => {
    const { lock, told, pass } = made()
    await ask(lock, 'lock.set', { paths: ['a.md'], ms: 1000 }, agent('claude-code#1'))
    await ask(lock, 'lock.set', { paths: ['b.md'], ms: 60_000 }, { root: editor })
    pass(1000)
    await flushed()
    told.length = 0
    lock.role.release()
    expect(told).toEqual([unlocked('a.md'), unlocked('b.md')])
    await flushed()
    expect(told).toHaveLength(2)
    expect(check(lock, ['b.md'], agent('claude-code#1'))).toBe('allow')
    expect(await ask(lock, 'lock.held', { paths: ['a.md', 'b.md'] }, { root: plugin('git') })).toStrictEqual({ locks: [] })
    lock.role.release()
    await flushed()
    expect(told).toHaveLength(2)
  })
})
