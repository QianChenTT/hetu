import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import { MAX_LOCK_MS, MAX_LOCKS_PER_CLIENT, MAX_LOCKS_PER_ROOT } from '../backend/lock/header.ts'
import { definePlugin, type PluginContext } from '../sdk/plugin.ts'
import { Refused } from '../sdk/refused.ts'
import type { LockChangedEvent } from '../sdk/events.ts'
import { type FakeCore, fakeCore, type FakeCoreOptions } from '../sdk/testing/index.ts'
import { versionOf } from '../sdk/testing/providers.ts'

const cores: FakeCore[] = []
afterEach(async () => {
  for (const core of cores.splice(0)) await core.close()
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
      .toEqual({ ok: true, result: { locks: [{ path: 'notes/A.md', until: 60_000 }, { path: 'notes/b.md', until: 60_000 }] } })
    expect(await by(ctx, 'lock.clear', { paths: ['notes/a.md'] })).toEqual({ ok: true, result: null })
    expect(await by(ctx, 'lock.held', { paths: ['notes/a.md', 'notes/b.md'] }))
      .toEqual({ ok: true, result: { locks: [{ path: 'notes/b.md', until: 60_000 }] } })
  })

  it('refuses a second holder locked with nobody named and sets none of its paths', async () => {
    const { fake, ctx } = await started()
    await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 60_000 })
    const reply = await fake.call('lock.set', { paths: ['notes/c.md', 'notes/a.md'], ms: 60_000 }, { as: 'other', grants: OTHER })
    expect(reply).toEqual({ ok: false, refusal: { code: 'locked', action: 'lock.set' } })
    expect(await by(ctx, 'lock.held', { paths: ['notes/c.md'] })).toEqual({ ok: true, result: { locks: [] } })
  })

  it('renews a lock set again and cuts a longer time to MAX_LOCK_MS', async () => {
    const { ctx, clock } = await started()
    await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 1000 })
    clock.now = 900
    expect(await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 1000 })).toEqual({ ok: true, result: { ms: 1000 } })
    clock.now = 1500
    expect(await by(ctx, 'lock.held', { paths: ['notes/a.md'] })).toEqual({ ok: true, result: { locks: [{ path: 'notes/a.md', until: 1900 }] } })
    expect(await by(ctx, 'lock.set', { paths: ['notes/b.md'], ms: MAX_LOCK_MS + 5 })).toEqual({ ok: true, result: { ms: MAX_LOCK_MS } })
  })

  it('lets a lock end at its time on the clock a test moves, so another holder may set it', async () => {
    const { fake, ctx, clock } = await started()
    await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 1000 })
    clock.now = 999
    expect(await byOther(fake, 'lock.set', { paths: ['notes/a.md'], ms: 1000 })).toEqual({ ok: false, code: 'locked' })
    clock.now = 1000
    expect(await by(ctx, 'lock.held', { paths: ['notes/a.md'] })).toEqual({ ok: true, result: { locks: [] } })
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
    expect(await by(ctx, 'lock.held', { paths: ['notes/a.md'] })).toEqual({ ok: true, result: { locks: [{ path: 'notes/a.md', until: 60_000 }] } })
    expect(await by(ctx, 'luoshu.write', { path: 'notes/a.md', text: 'x', baseVersion: versionOf('a') }, 'session#1')).toMatchObject({ ok: true })
    expect(await by(ctx, 'lock.clear', { paths: ['notes/a.md'] }, 'session#1')).toEqual({ ok: true, result: null })
    expect(await by(ctx, 'lock.held', { paths: ['notes/a.md'] })).toEqual({ ok: true, result: { locks: [] } })
  })

  it('judges lock.set by the paths its grant names, as the gate does', async () => {
    const { ctx } = await started()
    expect(await by(ctx, 'lock.set', { paths: ['secret/a.md'], ms: 1000 })).toEqual({ ok: false, code: 'not-granted' })
  })
})

// Waits for what a port delivers later than the reply the caller waited for
async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
}
const settle = () => new Promise(resolve => { setTimeout(resolve, 30) })

// The plugin under test subscribed to lock.changed, each event it hears kept whole
async function hearing(capabilities: Capability[]): Promise<{ fake: FakeCore, ctx: PluginContext, clock: { now: number }, heard: LockChangedEvent[] }> {
  const { fake, ctx, clock } = await started({ manifest: manifest(capabilities) })
  const heard: LockChangedEvent[] = []
  await ctx.events.on('lock.changed', event => { heard.push(event) })
  return { fake, ctx, clock, heard }
}

const SUBSCRIBES: Capability = { type: 'events.subscribe', topics: ['lock.changed'] }

describe('the fake core\'s lock.changed', () => {
  it('tells a plugin that reads the note each set, renewal, clear and expiry, the end on the test\'s clock and no holder', async () => {
    const { fake, ctx, clock, heard } = await hearing([...manifest().capabilities, SUBSCRIBES])
    await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 1000 }, 'client#1')
    clock.now = 400
    await by(ctx, 'lock.set', { paths: ['notes/a.md'], ms: 1000 }, 'client#1')
    await by(ctx, 'lock.clear', { paths: ['notes/a.md'] }, 'client#1')
    await byOther(fake, 'lock.set', { paths: ['notes/b.md'], ms: 1000 })
    clock.now = 1400
    await by(ctx, 'lock.held', { paths: ['notes/b.md'] })
    await until(() => heard.length === 5)
    expect(heard).toStrictEqual([
      { topic: 'lock.changed', path: 'notes/a.md', locked: true, until: 1000 },
      { topic: 'lock.changed', path: 'notes/a.md', locked: true, until: 1400 },
      { topic: 'lock.changed', path: 'notes/a.md', locked: false, until: null },
      { topic: 'lock.changed', path: 'notes/b.md', locked: true, until: 1400 },
      { topic: 'lock.changed', path: 'notes/b.md', locked: false, until: null },
    ])
  })

  it('tells a plugin nothing of a note it may only list or may not read', async () => {
    const { fake, heard } = await hearing([
      SUBSCRIBES, { type: 'luoshu.read', paths: ['notes/**'] }, { type: 'luoshu.list', paths: ['shared/**'] },
    ])
    for (const path of ['secret/a.md', 'shared/a.md', 'notes/c.md']) {
      expect(await byOther(fake, 'lock.set', { paths: [path], ms: 1000 })).toMatchObject({ ok: true })
      expect(await byOther(fake, 'lock.clear', { paths: [path] })).toMatchObject({ ok: true })
    }
    await until(() => heard.length === 2)
    await settle()
    expect(heard.map(event => `${event.path} ${event.locked}`)).toEqual(['notes/c.md true', 'notes/c.md false'])
  })
})

// events.dropped says lock.changed events were missed, so a plugin asks lock.held again for the notes it follows and
// rebuilds each lock and its timer from the ends it answers
describe('the fake core\'s lock.changed past a plugin\'s credits', () => {
  it('drops what the plugin can\'t take, tells it to resync and lets lock.held rebuild every lock with its end', async () => {
    const { fake, ctx } = await started({ manifest: manifest([...manifest().capabilities, SUBSCRIBES]), limits: { eventCredits: 2 } })
    let release = () => {}
    const busy = new Promise<void>(resolve => { release = resolve })
    const heard: string[] = []
    const resynced: string[][] = []
    await ctx.events.on('lock.changed', async event => {
      heard.push(event.path)
      await busy
    }, { onResync: topics => { resynced.push(topics) } })
    const paths = ['notes/a.md', 'notes/b.md', 'notes/c.md', 'notes/d.md']
    for (const [i, path] of paths.entries()) {
      expect(await byOther(fake, 'lock.set', { paths: [path], ms: 1000 * (i + 1) })).toMatchObject({ ok: true })
    }
    await settle()
    release()
    await until(() => resynced.length === 1)
    expect(resynced).toEqual([['lock.changed']])
    expect(heard).toEqual(['notes/a.md', 'notes/b.md'])
    expect(await by(ctx, 'lock.held', { paths })).toEqual({ ok: true, result: { locks: paths.map((path, i) => ({ path, until: 1000 * (i + 1) })) } })
  })
})
