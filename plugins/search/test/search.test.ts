import path from 'node:path'
import { type FakeCore, fakeCore, type FakeMode } from '@hetu/sdk/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { Index } from '../src/index.ts'
import search from '../src/worker.ts'

const manifest = path.join(import.meta.dirname, '..', 'hetu-plugin.json')
const cores: FakeCore[] = []

afterEach(async () => {
  for (const core of cores.splice(0)) await core.close()
})

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => Promise<boolean>, ms = 2000): Promise<void> {
  for (let waited = 0; !(await check()); waited += 10) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(10)
  }
}

function core(mode?: FakeMode): FakeCore {
  const made = fakeCore({ manifest, ...(mode === undefined ? {} : { mode }) })
  cores.push(made)
  return made
}

// The paths a query found, or the refusal's code
async function query(fake: FakeCore, text: unknown, grants?: Parameters<FakeCore['call']>[2]): Promise<string[] | string> {
  const reply = await fake.call('search.query', { text }, grants)
  return reply.ok ? (reply.result as { paths: string[] }).paths : reply.refusal.code
}

const finds = (fake: FakeCore, text: string, paths: string[], ms?: number) => until(async () => JSON.stringify(await query(fake, text)) === JSON.stringify(paths), ms)

describe('search with the grants its manifest asks for', () => {
  it('indexes a note it hears about and finds it', async () => {
    const fake = core()
    expect(await fake.start(search)).toEqual({ state: 'ready' })
    await fake.luoshu.write('notes/a.md', 'The quick brown fox')
    await finds(fake, 'quick fox', ['notes/a.md'])
    expect(await query(fake, 'slow fox')).toEqual([])
  })

  it('answers only what the caller may read', async () => {
    const fake = core()
    await fake.start(search)
    await fake.luoshu.write('public/a.md', 'fox')
    await fake.luoshu.write('private/b.md', 'fox', { outside: true })
    await finds(fake, 'fox', ['private/b.md', 'public/a.md'])
    const narrow = { grants: [{ type: 'plugin.call' as const, targets: ['search'] }, { type: 'luoshu.read' as const, paths: ['public/**'] }] }
    expect(await query(fake, 'fox', narrow)).toEqual(['public/a.md'])
  })

  it('forgets a note that is gone', async () => {
    const fake = core()
    await fake.start(search)
    await fake.luoshu.write('notes/a.md', 'fox')
    await finds(fake, 'fox', ['notes/a.md'])
    await fake.luoshu.remove('notes/a.md')
    await finds(fake, 'fox', [])
  })

  it('keeps its index across a restart through the cache', async () => {
    const fake = core()
    await fake.start(search)
    await fake.luoshu.write('notes/a.md', 'fox')
    await finds(fake, 'fox', ['notes/a.md'])
    await fake.stop()
    expect(await fake.start(search)).toEqual({ state: 'ready' })
    expect(await query(fake, 'fox')).toEqual(['notes/a.md'])
  })

  it('keeps a note through a read that fails for a while, then reads it again', async () => {
    const fake = core()
    await fake.start(search)
    await fake.luoshu.write('notes/a.md', 'fox')
    await finds(fake, 'fox', ['notes/a.md'])
    fake.luoshu.refuseNext('unavailable')
    await fake.luoshu.write('notes/a.md', 'alpha fox again')
    await tick(100)
    expect(await query(fake, 'fox')).toEqual(['notes/a.md'])
    await finds(fake, 'alpha', ['notes/a.md'], 4000)
  })

  it('indexes a note whose first read failed once the luoshu answers again', async () => {
    const fake = core()
    await fake.start(search)
    fake.luoshu.refuseNext('starting')
    fake.luoshu.refuseNext('unavailable')
    await fake.luoshu.write('notes/b.md', 'otter')
    await finds(fake, 'otter', ['notes/b.md'], 4000)
  })

  it('forgets a note it may no longer read', async () => {
    const fake = core()
    await fake.start(search)
    await fake.luoshu.write('notes/a.md', 'fox')
    await finds(fake, 'fox', ['notes/a.md'])
    fake.luoshu.refuseNext('not-granted')
    await fake.luoshu.write('notes/a.md', 'fox')
    await finds(fake, 'fox', [])
  })

  it('reads a resync a batch at a time, so its other calls never wait behind it', async () => {
    const fake = fakeCore({ manifest, latencyMs: 5 })
    cores.push(fake)
    await fake.start(search)
    for (let i = 0; i < 100; i++) await fake.luoshu.write(`notes/${i}.md`, `fox ${i}`)
    await until(async () => (await query(fake, 'fox')).length === 100, 10_000)
    fake.luoshu.busiest()
    // One event at a time, so a burst drops some and a resync of every note search knows follows
    fake.limits.eventCredits = 1
    for (let i = 0; i < 5; i++) await fake.luoshu.write(`notes/${i}.md`, `fox again ${i}`)
    await tick(500)
    const peak = fake.luoshu.busiest()
    // Unbatched, the SDK put 64 reads in flight at once, all it may
    expect(peak).toBeGreaterThan(8)
    expect(peak).toBeLessThanOrEqual(17)
  })

  it('refuses a query that isn\'t { text: string }', async () => {
    const fake = core()
    await fake.start(search)
    expect(await query(fake, 5)).toBe('invalid')
    const reply = await fake.call('search.query', { text: 'fox', more: 1 })
    expect(reply.ok ? null : reply.refusal.code).toBe('invalid')
  })
})

describe('search with every grant', () => {
  it('indexes and finds', async () => {
    const fake = core('allow-all')
    await fake.start(search)
    await fake.luoshu.write('notes/a.md', 'fox')
    await finds(fake, 'fox', ['notes/a.md'])
  })
})

describe('search with no grant', () => {
  it('stays up when its subscribe is refused and answers with nothing', async () => {
    const fake = core('deny-all')
    expect(await fake.start(search)).toEqual({ state: 'ready' })
    await fake.luoshu.write('notes/a.md', 'fox')
    await tick(30)
    expect(await query(fake, 'fox')).toEqual([])
  })
})

describe('search while the gate is down', () => {
  it('stays up while the gate is down and still saves its index at stop', async () => {
    const fake = core('gate-failed')
    expect(await fake.start(search)).toEqual({ state: 'ready' })
    expect(await query(fake, 'fox')).toBe('policy-down')
    await fake.stop()
    expect(fake.stored('cache', 'index')).toEqual({ v: 1, notes: {} })
  })
})

describe('search while the luoshu is missing', () => {
  it('waits for the luoshu and starts with lastStop once it is back', async () => {
    const fake = core('dependency-missing')
    expect(await fake.start(search)).toEqual({ state: 'waiting', reason: 'dependency:luoshu:absent' })
    expect(await fake.restore()).toEqual({ state: 'ready' })
    await fake.luoshu.write('notes/a.md', 'fox')
    await finds(fake, 'fox', ['notes/a.md'])
  })
})

describe('the index', () => {
  it('finds a note by every word of the query in any case', () => {
    const index = new Index()
    index.add('a.md', 'Hello World')
    index.add('b.md', 'hello there, 世界')
    expect(index.search('HELLO')).toEqual(['a.md', 'b.md'])
    expect(index.search('hello world')).toEqual(['a.md'])
    expect(index.search('世界')).toEqual(['b.md'])
    expect(index.search('')).toEqual([])
    index.remove('a.md')
    expect(index.search('hello')).toEqual(['b.md'])
  })

  it('starts empty from a saved index it can\'t read', () => {
    expect(Index.from(null).paths()).toEqual([])
    expect(Index.from({ v: 2, notes: { 'a.md': ['x'] } }).paths()).toEqual([])
    expect(Index.from({ v: 1, notes: { 'a.md': [1] } }).paths()).toEqual([])
    expect(Index.from({ v: 1, notes: { 'a.md': ['x'] } }).search('x')).toEqual(['a.md'])
  })
})
