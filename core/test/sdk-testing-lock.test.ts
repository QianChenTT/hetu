import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import type { Call, ProviderRefusal } from '../api/policy-jobs.ts'
import { MAX_LOCK_MS, MAX_LOCKS_PER_CLIENT, MAX_LOCKS_PER_ROOT } from '../backend/lock/header.ts'
import { createLock } from '../backend/lock/lock.ts'
import { definePlugin, type PluginContext } from '../sdk/plugin.ts'
import { Refused } from '../sdk/refused.ts'
import { type FakeCore, fakeCore, type FakeCoreOptions } from '../sdk/testing/index.ts'
import { versionOf } from '../sdk/testing/providers.ts'

const cores: FakeCore[] = []
let base: string | undefined
afterEach(async () => {
  for (const core of cores.splice(0)) await core.close()
  if (base !== undefined) await rm(base, { recursive: true, force: true })
  base = undefined
})

// A plugin that locks, reads and writes notes, the way leases and mcp would
const manifest = (capabilities: Capability[] = [
  { type: 'lock.set', paths: ['notes/**'] },
  { type: 'luoshu.read', paths: ['notes/**'] },
  { type: 'luoshu.write', paths: ['notes/**'] },
]) => ({ id: 'keeper', name: 'Keeper', version: '1.0.0', api: '^4', entries: { worker: 'dist/worker.js' }, capabilities })

// Another root plugin, tester calls named as it
const OTHER: Capability[] = [{ type: 'lock.set', paths: ['**'] }, { type: 'luoshu.read', paths: ['**'] }, { type: 'luoshu.write', paths: ['**'] }]

// A fake core whose lock reads now, with the plugin under test started and its ctx kept for the test
async function started(options: Partial<FakeCoreOptions> = {}): Promise<{ fake: FakeCore, ctx: PluginContext, clock: { now: number } }> {
  const clock = { now: 0 }
  const fake = fakeCore({ manifest: manifest(), notes: { 'notes/a.md': 'a', 'notes/b.md': 'b' }, clock: () => clock.now, ...options })
  cores.push(fake)
  let ctx: PluginContext | null = null
  await fake.start(definePlugin({ start: given => { ctx = given } }))
  return { fake, ctx: ctx!, clock }
}

type Answer = { ok: true, result: unknown } | { ok: false, code: string, reason?: string }
type Action = 'lock.set' | 'lock.clear' | 'lock.held' | 'luoshu.write'

// One action from the plugin under test as the root of its own chain, onBehalf naming the pair when given
async function by(ctx: PluginContext, action: Action, args: object, onBehalf?: string): Promise<Answer> {
  const options = onBehalf === undefined ? {} : { onBehalf }
  const calls: Record<Action, () => Promise<unknown>> = {
    'lock.set': () => ctx.lock.set(args as { paths: string[], ms: number }, options),
    'lock.clear': () => ctx.lock.clear(args as { paths: string[] }, options),
    'lock.held': () => ctx.lock.held(args as { paths: string[] }, options),
    'luoshu.write': () => ctx.luoshu.write(args as { path: string, text: string, baseVersion?: string }, options),
  }
  try {
    return { ok: true, result: await calls[action]() }
  } catch (err) {
    if (!(err instanceof Refused)) throw err
    return { ok: false, code: err.code, ...(err.reason === undefined ? {} : { reason: err.reason }) }
  }
}

// One action from the other root plugin
async function byOther(fake: FakeCore, action: Action, args: object): Promise<Answer> {
  const reply = await fake.call(action, args, { as: 'other', grants: OTHER })
  if (reply.ok) return reply
  return { ok: false, code: reply.refusal.code, ...(reply.refusal.reason === undefined ? {} : { reason: reply.refusal.reason }) }
}

const names = (count: number, from = 0) => Array.from({ length: count }, (_, i) => `notes/n${from + i}.md`)
const chunks = (paths: string[]) => Array.from({ length: Math.ceil(paths.length / 64) }, (_, i) => paths.slice(i * 64, i * 64 + 64))

describe('the fake core\'s lock', () => {
  it('sets, names held paths as spelled and clears', async () => {
    const { ctx } = await started()
    expect(await by(ctx, 'lock.set', { paths: ['notes/a.md', 'notes/b.md'], ms: 60_000 })).toEqual({ ok: true, result: { ms: 60_000 } })
    expect(await by(ctx, 'lock.held', { paths: ['notes/A.md', 'notes/c.md', 'notes/b.md'] }))
      .toEqual({ ok: true, result: { paths: ['notes/A.md', 'notes/b.md'] } })
    expect(await by(ctx, 'lock.clear', { paths: ['notes/a.md'] })).toEqual({ ok: true, result: null })
    expect(await by(ctx, 'lock.held', { paths: ['notes/a.md', 'notes/b.md'] })).toEqual({ ok: true, result: { paths: ['notes/b.md'] } })
  })

  it('refuses a second holder locked with nobody named and sets none of its paths', async () => {
    const { fake, ctx } = await started()
    await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 60_000 })
    const reply = await fake.call('lock.set', { paths: ['notes/c.md', 'notes/a.md'], ms: 60_000 }, { as: 'other', grants: OTHER })
    expect(reply).toEqual({ ok: false, refusal: { code: 'locked', action: 'lock.set' } })
    expect(await by(ctx, 'lock.held', { paths: ['notes/c.md'] })).toEqual({ ok: true, result: { paths: [] } })
  })

  it('renews a lock set again and cuts a longer time to MAX_LOCK_MS', async () => {
    const { ctx, clock } = await started()
    await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 1000 })
    clock.now = 900
    expect(await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 1000 })).toEqual({ ok: true, result: { ms: 1000 } })
    clock.now = 1500
    expect(await by(ctx, 'lock.held', { paths: ['notes/a.md'] })).toEqual({ ok: true, result: { paths: ['notes/a.md'] } })
    expect(await by(ctx, 'lock.set', { paths: ['notes/b.md'], ms: MAX_LOCK_MS + 5 })).toEqual({ ok: true, result: { ms: MAX_LOCK_MS } })
  })

  it('lets a lock end at its time on the clock a test moves, so another holder may set it', async () => {
    const { fake, ctx, clock } = await started()
    await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 1000 })
    clock.now = 999
    expect(await byOther(fake, 'lock.set', { paths: ['notes/a.md'], ms: 1000 })).toEqual({ ok: false, code: 'locked' })
    clock.now = 1000
    expect(await by(ctx, 'lock.held', { paths: ['notes/a.md'] })).toEqual({ ok: true, result: { paths: [] } })
    expect(await byOther(fake, 'lock.set', { paths: ['notes/a.md'], ms: 1000 })).toEqual({ ok: true, result: { ms: 1000 } })
  })

  it('holds one root plugin\'s pairs together to MAX_LOCKS_PER_ROOT live locks, renewing still allowed', async () => {
    const { fake, ctx } = await started()
    const all = names(MAX_LOCKS_PER_ROOT)
    for (const [i, paths] of chunks(all).entries()) {
      expect(await by(ctx, 'lock.set', { paths, ms: 60_000 }, `pair-${i}`)).toMatchObject({ ok: true })
    }
    expect(await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 60_000 }, 'pair-new')).toEqual({ ok: false, code: 'failed', reason: 'quota' })
    expect(await by(ctx, 'lock.set', { paths: all.slice(0, 64), ms: 60_000 }, 'pair-0')).toEqual({ ok: true, result: { ms: 60_000 } })
    expect(await byOther(fake, 'lock.set', { paths: ['notes/a.md'], ms: 60_000 })).toEqual({ ok: true, result: { ms: 60_000 } })
  })

  it('holds one client\'s sessions together to MAX_LOCKS_PER_CLIENT live locks, another client and the plugin itself still taking', async () => {
    const { fake, ctx } = await started()
    const all = names(MAX_LOCKS_PER_CLIENT)
    for (const [i, paths] of chunks(all).entries()) {
      expect(await by(ctx, 'lock.set', { paths, ms: 60_000 }, `client#${i}`)).toMatchObject({ ok: true })
    }
    expect(await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 60_000 }, 'client#new')).toEqual({ ok: false, code: 'failed', reason: 'quota' })
    expect(await by(ctx, 'lock.set', { paths: all.slice(0, 64), ms: 60_000 }, 'client#0')).toEqual({ ok: true, result: { ms: 60_000 } })
    expect(await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 60_000 }, 'another#1')).toEqual({ ok: true, result: { ms: 60_000 } })
    expect(await by(ctx, 'lock.set', { paths: ['notes/b.md'], ms: 60_000 })).toEqual({ ok: true, result: { ms: 60_000 } })
    expect(await byOther(fake, 'lock.set', { paths: ['notes/c.md'], ms: 60_000 })).toEqual({ ok: true, result: { ms: 60_000 } })
  })

  it('refuses another holder\'s write onto a locked note locked, as the router answers the lock guard', async () => {
    const { fake, ctx } = await started()
    await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 60_000 })
    expect(await byOther(fake, 'luoshu.write', { path: 'notes/a.md', text: 'theirs' })).toEqual({ ok: false, code: 'locked' })
    expect(fake.luoshu.read('notes/a.md')).toBe('a')
    expect(await by(ctx, 'luoshu.write', { path: 'notes/a.md', text: 'mine', baseVersion: versionOf('a') })).toMatchObject({ ok: true })
    expect(fake.luoshu.read('notes/a.md')).toBe('mine')
    expect(await byOther(fake, 'luoshu.write', { path: 'notes/b.md', text: 'theirs', baseVersion: versionOf('b') })).toMatchObject({ ok: true })
  })

  it('holds by the root plugin with the whole onBehalf field, a pair clearing only its own', async () => {
    const { ctx } = await started()
    await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 60_000 }, 'session#1')
    expect(await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 60_000 }, 'session#2')).toEqual({ ok: false, code: 'locked' })
    expect(await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 60_000 })).toEqual({ ok: false, code: 'locked' })
    expect(await by(ctx, 'luoshu.write', { path: 'notes/a.md', text: 'x' }, 'session#2')).toEqual({ ok: false, code: 'locked' })
    expect(await by(ctx, 'lock.clear', { paths: ['notes/a.md'] }, 'session#2')).toEqual({ ok: true, result: null })
    expect(await by(ctx, 'lock.held', { paths: ['notes/a.md'] })).toEqual({ ok: true, result: { paths: ['notes/a.md'] } })
    expect(await by(ctx, 'luoshu.write', { path: 'notes/a.md', text: 'x', baseVersion: versionOf('a') }, 'session#1')).toMatchObject({ ok: true })
    expect(await by(ctx, 'lock.clear', { paths: ['notes/a.md'] }, 'session#1')).toEqual({ ok: true, result: null })
    expect(await by(ctx, 'lock.held', { paths: ['notes/a.md'] })).toEqual({ ok: true, result: { paths: [] } })
  })

  it('judges lock.set by the paths its grant names, as the gate does', async () => {
    const { ctx } = await started()
    expect(await by(ctx, 'lock.set', { paths: ['secret/a.md'], ms: 1000 })).toEqual({ ok: false, code: 'not-granted' })
  })
})

// Who calls in a script: the plugin under test with or without a pair, or another root plugin
type Who = { plugin: 'keeper' | 'other', onBehalf?: string }
type Step = { at?: number, who: Who, action: Action, args: object }

const keeper = (onBehalf?: string): Who => (onBehalf === undefined ? { plugin: 'keeper' } : { plugin: 'keeper', onBehalf })
const other: Who = { plugin: 'other' }

// Two pairs and another root through set, renewal, refusals, writes, clears, expiry and the per-client cap
function script(): Step[] {
  const [a, b, c] = ['notes/a.md', 'notes/b.md', 'notes/c.md']
  const filler = chunks(names(MAX_LOCKS_PER_CLIENT - 1))
  return [
    { who: keeper('A'), action: 'lock.set', args: { paths: [a, b], ms: 1000 } },
    { who: keeper('B'), action: 'lock.set', args: { paths: [b, c], ms: 1000 } },
    { who: keeper('B'), action: 'lock.held', args: { paths: [a, 'notes/B.md', c] } },
    { who: other, action: 'lock.set', args: { paths: [c], ms: MAX_LOCK_MS + 5 } },
    { who: keeper(), action: 'luoshu.write', args: { path: a, text: 'x' } },
    { who: keeper('A'), action: 'luoshu.write', args: { path: a, text: 'x' } },
    { who: keeper('A'), action: 'luoshu.write', args: { path: c, text: 'x' } },
    { who: other, action: 'luoshu.write', args: { path: c, text: 'x' } },
    { who: keeper('B'), action: 'lock.clear', args: { paths: [a] } },
    { who: keeper('A'), action: 'lock.held', args: { paths: [a] } },
    { at: 900, who: keeper('A'), action: 'lock.set', args: { paths: [a], ms: 1000 } },
    { at: 1000, who: keeper('A'), action: 'lock.held', args: { paths: [a, b] } },
    { at: 1000, who: keeper('B'), action: 'lock.set', args: { paths: [b], ms: 10 } },
    { who: keeper('A'), action: 'lock.clear', args: { paths: [a] } },
    { who: keeper('A'), action: 'lock.held', args: { paths: [a, b] } },
    ...filler.map((paths): Step => ({ who: other, action: 'lock.set', args: { paths, ms: 60_000 } })),
    { who: other, action: 'lock.set', args: { paths: ['notes/one-more.md'], ms: 60_000 } },
    { who: other, action: 'lock.set', args: { paths: [c], ms: 60_000 } },
    { who: keeper('A'), action: 'lock.set', args: { paths: ['notes/one-more.md'], ms: 60_000 } },
    { who: other, action: 'luoshu.write', args: { path: 'notes/one-more.md', text: 'x' } },
  ]
}

// An answer as the contract compares it: a write's result is the luoshu's, so only whether it passed counts
const compared = (action: Action, answer: Answer): Answer => (answer.ok && action === 'luoshu.write' ? { ok: true, result: null } : answer)

describe('the fake core\'s lock against the lock module', () => {
  it('answers one script as createLock does, the router answering the guard\'s deny locked', async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-fake-lock-')))
    for (const name of ['notes', 'data', 'install']) await mkdir(path.join(base, name))
    const now = { at: 0 }
    const real = createLock({ clock: () => now.at })
    real.role.open({ folder: path.join(base, 'notes'), dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
    let n = 0
    async function onReal(step: Step): Promise<Answer> {
      const caller = { kind: 'plugin', id: step.who.plugin, half: 'worker', incarnation: 1 } as const
      const head = { callId: `c${++n}`, caller, root: caller, ...(step.who.onBehalf === undefined ? {} : { onBehalf: step.who.onBehalf }) }
      if (step.action === 'luoshu.write') {
        const answer = real.guard.check({ ...head, action: step.action, scope: { paths: [(step.args as { path: string }).path] } })
        return answer === 'deny' ? { ok: false, code: 'locked' } : { ok: true, result: null }
      }
      const call: Call = { ...head, action: step.action, args: step.args, deadline: Date.now() + 30_000 }
      const prepared = await real.provider.prepare(call)
      if (!('scope' in prepared)) return { ok: false, ...prepared }
      try {
        return { ok: true, result: await real.provider.perform(call, prepared) }
      } catch (err) {
        return { ok: false, ...(err as ProviderRefusal) }
      }
    }

    // No notes, so each write that passes makes a new one and needs no base version
    const { fake, ctx, clock } = await started({ notes: {} })
    const seen = new Set<string>()
    for (const [i, step] of script().entries()) {
      if (step.at !== undefined) now.at = clock.now = step.at
      const expected = compared(step.action, await onReal(step))
      const answer = step.who.plugin === 'other' ? await byOther(fake, step.action, step.args) : await by(ctx, step.action, step.args, step.who.onBehalf)
      expect(compared(step.action, answer), `step ${i} ${JSON.stringify(step).slice(0, 120)}`).toEqual(expected)
      seen.add(expected.ok ? `${step.action} ok` : `${expected.code} ${expected.reason ?? ''}`.trim())
    }
    // The script meets each kind of answer, so it can't pass on a lock that answers one kind for all
    expect([...seen].sort()).toEqual(['failed quota', 'lock.clear ok', 'lock.held ok', 'lock.set ok', 'locked', 'luoshu.write ok'])
  // Each of the module's paths turned canonical on the disk, past five seconds on a busy Windows machine
  }, 60_000)
})
