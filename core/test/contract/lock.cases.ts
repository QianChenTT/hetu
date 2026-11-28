import { expect, it } from 'vitest'
import type { Guard, Provider } from '../../api/policy-jobs.ts'
import { MAX_LOCK_MS, MAX_LOCKS_PER_CLIENT, MAX_LOCKS_PER_ROOT } from '../../backend/lock/header.ts'
import { ask, callOf, editorCaller, pluginCaller, type Asking } from './ask.ts'

// lock.* and the lock guard over an empty notes folder, every end on the clock given, which wall time reads too, and
// each lock.changed told kept with its path
export type LockSubject = { provider: Provider, guard: Guard, told: object[] }
export type MakeLock = (clock: { now: number }) => Promise<LockSubject>

const [a, b, c] = ['notes/a.md', 'notes/b.md', 'notes/c.md']
const other: Asking = { caller: pluginCaller('other') }
const pair = (onBehalf: string): Asking => ({ onBehalf })
// lock.changed goes out once the step that noticed the change ended
const settled = () => new Promise(resolve => { setTimeout(resolve, 0) })

export function lockCases(make: MakeLock): void {
  const set = (lock: LockSubject, paths: string[], ms: number, as?: Asking) => ask(lock.provider, 'lock.set', { paths, ms }, as)
  const clear = (lock: LockSubject, paths: string[], as?: Asking) => ask(lock.provider, 'lock.clear', { paths }, as)
  const held = (lock: LockSubject, paths: string[], as?: Asking) => ask(lock.provider, 'lock.held', { paths }, as)
  // The guard on a write, deny answered locked as the router answers it
  const write = (lock: LockSubject, path: string, as?: Asking) => {
    const call = { ...callOf('luoshu.write', {}, as), scope: { paths: [path] } }
    return lock.guard.check(call) === 'deny' ? 'locked' : 'allowed'
  }

  it('sets all of a call\'s paths or none, names held paths as spelled and clears only the holder\'s own', async () => {
    const lock = await make({ now: 0 })
    expect(await set(lock, [a, b], 1000, pair('A'))).toEqual({ ms: 1000 })
    expect(await set(lock, [c, b], 1000, pair('B'))).toEqual({ refused: { code: 'locked' } })
    expect(await held(lock, [a, 'notes/B.md', c])).toEqual({ locks: [{ path: a, until: 1000 }, { path: 'notes/B.md', until: 1000 }] })
    expect(await clear(lock, [a], pair('B'))).toBeNull()
    expect(await held(lock, [a, b])).toEqual({ locks: [{ path: a, until: 1000 }, { path: b, until: 1000 }] })
    expect(await clear(lock, [a], pair('A'))).toBeNull()
    expect(await held(lock, [a, b])).toEqual({ locks: [{ path: b, until: 1000 }] })
  })

  it('renews a lock set again, cuts a longer time to MAX_LOCK_MS and ends a lock at its time', async () => {
    const clock = { now: 0 }
    const lock = await make(clock)
    await set(lock, [a], 1000)
    clock.now = 900
    expect(await set(lock, [a], 1000)).toEqual({ ms: 1000 })
    expect(await set(lock, [b], MAX_LOCK_MS + 5)).toEqual({ ms: MAX_LOCK_MS })
    clock.now = 1899
    expect(await set(lock, [a], 1000, other)).toEqual({ refused: { code: 'locked' } })
    clock.now = 1900
    expect(await held(lock, [a])).toEqual({ locks: [] })
    expect(await set(lock, [a], 1000, other)).toEqual({ ms: 1000 })
  })

  it('keeps every other holder\'s write off a locked note, the holder\'s own chain still writing', async () => {
    const lock = await make({ now: 0 })
    await set(lock, [a], 1000, pair('session#1'))
    expect([write(lock, a, pair('session#1')), write(lock, a, pair('session#2')), write(lock, a), write(lock, a, other), write(lock, b, other)])
      .toEqual(['allowed', 'locked', 'locked', 'locked', 'allowed'])
  })

  it('holds one client\'s sessions together to MAX_LOCKS_PER_CLIENT live locks, another client still taking', async () => {
    const lock = await make({ now: 0 })
    const names = Array.from({ length: MAX_LOCKS_PER_CLIENT }, (_, i) => `notes/n${i}.md`)
    for (let i = 0; i < names.length; i += 64) expect(await set(lock, names.slice(i, i + 64), 1000, pair(`client#${i}`))).toEqual({ ms: 1000 })
    expect(await set(lock, [a], 1000, pair('client#new'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await set(lock, names.slice(0, 64), 2000, pair('client#0'))).toEqual({ ms: 2000 })
    expect(await set(lock, [a], 1000, pair('another#1'))).toEqual({ ms: 1000 })
  })

  it('holds one root plugin\'s clients together to MAX_LOCKS_PER_ROOT live locks, another root still taking', async () => {
    const lock = await make({ now: 0 })
    const names = Array.from({ length: MAX_LOCKS_PER_ROOT }, (_, i) => `notes/r${i}.md`)
    const perClient = MAX_LOCKS_PER_CLIENT / 64
    for (let i = 0; i < names.length; i += 64) {
      expect(await set(lock, names.slice(i, i + 64), 1000, pair(`client${Math.floor(i / 64 / perClient)}#${i}`))).toEqual({ ms: 1000 })
    }
    expect(await set(lock, [a], 1000, pair('fresh#1'))).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await set(lock, [a], 1000, other)).toEqual({ ms: 1000 })
  })

  it('tells lock.changed for each set, renewal, clear and expiry met, the end in wall time', async () => {
    const clock = { now: 0 }
    const lock = await make(clock)
    await set(lock, [a], 1000)
    await set(lock, [b], 1000, other)
    clock.now = 400
    await set(lock, [a], 1000)
    await clear(lock, [a])
    clock.now = 1000
    await held(lock, [b])
    await settled()
    expect(lock.told).toEqual([
      { path: a, locked: true, until: 1000 }, { path: b, locked: true, until: 1000 }, { path: a, locked: true, until: 1400 },
      { path: a, locked: false, until: null }, { path: b, locked: false, until: null },
    ])
  })

  it('refuses a call with no paths invalid and a dot name set or asked about not-granted, a plugin\'s clear leaving it out', async () => {
    const lock = await make({ now: 0 })
    expect(await ask(lock.provider, 'lock.set', { ms: 1000 })).toEqual({ refused: { code: 'invalid' } })
    for (const path of ['notes/.todo.md', '.trash/a.md']) {
      expect(await set(lock, [a, path], 1000), path).toEqual({ refused: { code: 'not-granted' } })
      expect(await held(lock, [path]), path).toEqual({ refused: { code: 'not-granted' } })
      expect(await clear(lock, [path]), path).toBeNull()
      expect(await clear(lock, [path], { caller: editorCaller }), path).toEqual({ refused: { code: 'not-granted' } })
    }
    expect(await held(lock, [a])).toEqual({ locks: [] })
  })

  it('refuses a path spelled so the OS or the path joiner reads another name invalid, a plugin\'s clear leaving it out', async () => {
    const lock = await make({ now: 0 })
    const spellings: unknown[] = ['', '/etc/x', 'C:/x.md', '../x.md', 'notes/../a.md', 'notes//a.md', 'notes\\a.md', 'a:b.md', 'notes/a.md.', 'notes/a.md ',
      'CON.md', 'notes/lpt1.txt', 'a\u0007.md', '\ud800.md', 'x'.repeat(5000), 42, null]
    for (const path of spellings) {
      const shown = JSON.stringify(path).slice(0, 30)
      expect(await ask(lock.provider, 'lock.set', { paths: [path], ms: 1000 }), shown).toEqual({ refused: { code: 'invalid' } })
      expect(await ask(lock.provider, 'lock.held', { paths: [path] }), shown).toEqual({ refused: { code: 'invalid' } })
      expect(await ask(lock.provider, 'lock.clear', { paths: [path] }), shown).toBeNull()
      expect(await ask(lock.provider, 'lock.clear', { paths: [path] }, { caller: editorCaller }), shown).toEqual({ refused: { code: 'invalid' } })
    }
  })
}
