import { describe, expect, it } from 'vitest'
import { CoreLink } from '../frontend/mount/link.ts'
import { filterNames, listNames, PALETTE_PAGES } from '../frontend/mount/palette.ts'
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
    const listed = await listNames(link, 4)
    expect(listed).toEqual({ names: names.slice(0, 4), cut: true })
    expect(core.calls('luoshu.list')).toHaveLength(4)
    expect(PALETTE_PAGES).toBe(20)
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
