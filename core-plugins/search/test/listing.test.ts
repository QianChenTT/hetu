import { definePlugin, Refused } from '@hetu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { listAll, RETRY_MS, WAIT_MS } from '../src/listing.ts'
import search from '../src/worker.ts'
import { close, core, finds, query, until } from './helpers.ts'

afterEach(close)

// A luoshu of names paged two at a time, refusing the pages a test names with the codes it names, in turn
function luoshu(names: string[], refusals: Record<string, string[]> = {}) {
  const asked: (string | undefined)[] = []
  const list = async ({ after }: { after?: string }) => {
    asked.push(after)
    const code = refusals[after ?? '']?.shift()
    if (code !== undefined) throw new Refused(code as never, 'luoshu.list')
    const from = after === undefined ? 0 : names.indexOf(after) + 1
    const paths = names.slice(from, from + 2)
    return { paths, next: from + 2 < names.length ? paths.at(-1)! : null }
  }
  return { list, asked }
}

function waits() {
  const waited: number[] = []
  return { waited, wait: async (ms: number) => { waited.push(ms) } }
}

describe('a listing', () => {
  it('takes every page, each after the last name of the one before', async () => {
    const { list, asked } = luoshu(['a.md', 'b.md', 'c.md', 'd.md', 'e.md'])
    expect(await listAll(list)).toEqual({ paths: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], refused: null })
    expect(asked).toEqual([undefined, 'b.md', 'd.md'])
  })

  // The SDK tries a throttled call again within its deadline, past which the page comes back throttled here
  it('asks for a throttled page again a second later and goes on from it', async () => {
    const { list, asked } = luoshu(['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], { 'b.md': ['throttled', 'throttled'] })
    const { waited, wait } = waits()
    expect(await listAll(list, wait)).toEqual({ paths: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], refused: null })
    expect(asked).toEqual([undefined, 'b.md', 'b.md', 'b.md', 'd.md'])
    expect(waited).toEqual([RETRY_MS, RETRY_MS])
  })

  it('ends at any other refusal with the pages it has', async () => {
    const { list } = luoshu(['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], { 'b.md': ['unavailable'] })
    const { waited, wait } = waits()
    expect(await listAll(list, wait)).toEqual({ paths: ['a.md', 'b.md'], refused: 'unavailable' })
    expect(waited).toEqual([])
  })

  it('gives up on a page still throttled once it waited WAIT_MS in all', async () => {
    const { list } = luoshu(['a.md', 'b.md', 'c.md'], { 'b.md': Array(1000).fill('throttled') })
    const { waited, wait } = waits()
    expect(await listAll(list, wait)).toEqual({ paths: ['a.md', 'b.md'], refused: 'throttled' })
    expect(waited.reduce((sum, ms) => sum + ms, 0)).toBe(WAIT_MS)
  })
})

// The index an older run left in the cache under the same plugin id
const older = (notes: Record<string, string[]>) => definePlugin({ start: async ctx => {
  await ctx.cache.set({ key: 'index', value: { v: 1, notes } })
} })

describe('the listing at start', () => {
  it('reads every note of a folder it never heard of and only notes', async () => {
    const { fake } = core({ notes: { 'a.md': 'fox', 'deep/er/b.md': 'otter fox', 'c.txt': 'heron' } })
    expect(await fake.start(search)).toEqual({ state: 'ready' })
    await finds(fake, 'fox', ['a.md', 'deep/er/b.md'])
    expect(await query(fake, 'heron')).toEqual([])
  })

  // A page holds 1000 names
  it('reads past the first page', async () => {
    const notes: Record<string, string> = {}
    for (let i = 0; i < 1005; i++) notes[`notes/${String(i).padStart(4, '0')}.md`] = `word${i}`
    const { fake } = core({ notes })
    await fake.start(search)
    await finds(fake, 'word1004', ['notes/1004.md'], 10_000)
  }, 15_000)

  it('reads a note again that changed while search wasn\'t running and drops one no longer listed', async () => {
    const { fake } = core({ notes: { 'notes/a.md': 'new words' } })
    await fake.start(older({ 'notes/a.md': ['old'], 'notes/gone.md': ['old'] }))
    await fake.stop()
    await fake.start(search)
    await finds(fake, 'new', ['notes/a.md'])
    await finds(fake, 'old', [])
    await fake.stop()
    expect(fake.stored('cache', 'index')).toEqual({ v: 1, notes: { 'notes/a.md': ['new', 'words'] } })
  })

  it('reads the listed notes a batch at a time', async () => {
    const notes: Record<string, string> = {}
    for (let i = 0; i < 100; i++) notes[`notes/${i}.md`] = `fox ${i}`
    const { fake } = core({ notes, latencyMs: 5 })
    await fake.start(search)
    await until(async () => (await query(fake, 'fox')).length === 100, 10_000)
    const peak = fake.luoshu.busiest()
    expect(peak).toBeGreaterThan(8)
    expect(peak).toBeLessThanOrEqual(17)
  }, 15_000)

  it('keeps the index it has when the listing is refused', async () => {
    const { fake } = core({ notes: { 'notes/a.md': 'fox' } })
    await fake.start(older({ 'notes/cached.md': ['heron'] }))
    await fake.stop()
    fake.luoshu.refuseNext('unavailable')
    await fake.start(search)
    await finds(fake, 'heron', ['notes/cached.md'])
    await fake.luoshu.write('notes/b.md', 'otter')
    await finds(fake, 'otter', ['notes/b.md'])
    expect(await query(fake, 'heron')).toEqual(['notes/cached.md'])
    expect(await query(fake, 'fox')).toEqual([])
  })
})
