import { describe, expect, it } from 'vitest'
import { CoreLink } from '../frontend/mount/link.ts'
import { filterNames, LIST_WAIT_MS, listNames, PALETTE_PAGES } from '../frontend/mount/palette.ts'
import { fakeCore } from './mount-fakes.ts'

// A luoshu listing a page of size names at a time, as luoshu.list answers
function listing(names: string[], size = 3) {
  const core = fakeCore({
    'luoshu.list': args => {
      const after = (args as { after?: string }).after
      const start = after === undefined ? 0 : names.indexOf(after) + 1
      const page = names.slice(start, start + size)
      const next = start + size < names.length ? page.at(-1)! : null
      return { ok: true, result: { paths: page, next } }
    },
  })
  const link = new CoreLink(core.bridge)
  link.start()
  return { core, link }
}

describe('listing names for the palette', () => {
  it('follows next a page at a time to the end', async () => {
    const { link, core } = listing(['a.md', 'b.md', 'c.md', 'd.md', 'e.md'])
    expect(await listNames(link)).toEqual({ names: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], cut: false })
    expect(core.calls('luoshu.list').map(call => call.args)).toEqual([{}, { after: 'c.md' }])
  })

  it('stops after the pages it may take and says it was cut', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `n${String(i).padStart(2, '0')}.md`)
    const { link, core } = listing(names, 1)
    const listed = await listNames(link, { pages: 4 })
    expect(listed).toEqual({ names: names.slice(0, 4), cut: true })
    expect(core.calls('luoshu.list')).toHaveLength(4)
    expect(PALETTE_PAGES).toBe(20)
  })

  it('waits and asks again for the same page when a listing is throttled, and goes on from there', async () => {
    const names = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']
    let throttles = 2
    const core = fakeCore({
      'luoshu.list': args => {
        const after = (args as { after?: string }).after
        if (after === 'c.md' && throttles-- > 0) return { ok: false, refusal: { code: 'throttled' } }
        const start = after === undefined ? 0 : names.indexOf(after) + 1
        const page = names.slice(start, start + 3)
        return { ok: true, result: { paths: page, next: start + 3 < names.length ? page.at(-1)! : null } }
      },
    })
    const link = new CoreLink(core.bridge)
    link.start()
    const waits: number[] = []
    const pages: string[][] = []
    const listed = await listNames(link, { wait: async ms => void waits.push(ms), onPage: page => void pages.push(page) })
    expect(listed).toEqual({ names, cut: false })
    expect(waits).toEqual([1000, 1000])
    expect(core.calls('luoshu.list').map(call => call.args)).toEqual([{}, { after: 'c.md' }, { after: 'c.md' }, { after: 'c.md' }])
    expect(pages).toEqual([['a.md', 'b.md', 'c.md'], ['d.md', 'e.md']])
  })

  it(`gives up with what it has once it waited ${LIST_WAIT_MS / 1000} s in all`, async () => {
    const core = fakeCore({ 'luoshu.list': () => ({ ok: false, refusal: { code: 'throttled' } }) })
    const link = new CoreLink(core.bridge)
    link.start()
    let waited = 0
    const listed = await listNames(link, { wait: async ms => void (waited += ms) })
    expect(listed).toEqual({ names: [], cut: false, refused: 'throttled' })
    expect(waited).toBe(LIST_WAIT_MS)
  })

  it('answers the refusal with what it listed so far', async () => {
    const core = fakeCore({ 'luoshu.list': () => ({ ok: false, refusal: { code: 'unavailable' } }) })
    const link = new CoreLink(core.bridge)
    link.start()
    expect(await listNames(link)).toEqual({ names: [], cut: false, refused: 'unavailable' })
  })
})

describe('filtering names', () => {
  const names = ['d/a/i/l/y.md', 'journal/daily/2026.md', 'Daily.md', 'notes/other.md', 'ideas.md']

  it('keeps name order for an empty query, up to the most it shows', () => {
    expect(filterNames(names, '')).toEqual(names)
    expect(filterNames(names, '', 2)).toEqual(names.slice(0, 2))
  })

  it('ranks a whole substring over letters in order, then by where the match starts, ignoring case', () => {
    expect(filterNames(names, 'daily')).toEqual(['Daily.md', 'journal/daily/2026.md', 'd/a/i/l/y.md'])
  })

  it('leaves out names that hold the letters out of order', () => {
    expect(filterNames(['abc.md', 'cba.md'], 'abc')).toEqual(['abc.md'])
  })
})
