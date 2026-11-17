import { describe, expect, it } from 'vitest'
import { held, kept, report, type Sitting, summary, verdict, within } from '../../scripts/measure-bridge.ts'

const flat = (p95: number) => ({ median: p95 / 2, p95, max: p95 * 2 })
const sitting = (quiet: number, view: number, flood: number, search: number): Sitting => ({
  quiet: { typed: flat(quiet), marked: flat(quiet + 1) },
  view: { typed: flat(view), marked: flat(view + 1), load: { draws: 100 } },
  flood: { typed: flat(flood), marked: flat(flood + 1), load: { drawn: 20_000, throttled: 3 } },
  search: { typed: flat(search), marked: flat(search + 1), load: { reads: 469 } },
})

describe('the bridge measurement', () => {
  it('takes the median, the 95th percentile and the most of 100 keys by nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 - i)
    expect(summary(values)).toEqual({ median: 50, p95: 95, max: 100 })
    expect(summary([3, 1, 2])).toEqual({ median: 2, p95: 3, max: 3 })
  })

  it('keeps the median of the repeats and says when they disagree by more than half of it', () => {
    expect(kept([4, 3, 3])).toEqual({ repeats: [4, 3, 3], median: 3, spread: false })
    expect(kept([2, 3, 5])).toEqual({ repeats: [2, 3, 5], median: 3, spread: true })
  })

  it('holds a loaded run within twice the quiet one, however long a frame is', () => {
    expect(within(4, 8)).toBe(true)
    expect(within(4, 8.1)).toBe(false)
    expect(within(10, 17)).toBe(true)
    expect(within(15, 30)).toBe(true)
    expect(within(15, 30.1)).toBe(false)
  })

  it("holds each load of one sitting to that sitting's quiet run, by the 95th percentile", () => {
    expect(held(sitting(4, 8, 8.1, 3))).toEqual({
      view: { ratio: 2, within: true }, flood: { ratio: 8.1 / 4, within: false }, search: { ratio: 3 / 4, within: true },
    })
    expect(held(sitting(40, 80, 81, 30))).toEqual({
      view: { ratio: 2, within: true }, flood: { ratio: 81 / 40, within: false }, search: { ratio: 30 / 40, within: true },
    })
    // Medians that agree while the 95th percentile is past twice the quiet run's
    const tail = sitting(10, 10, 10, 10)
    tail.flood.typed = { median: 5, p95: 25, max: 40 }
    expect(held(tail).flood).toEqual({ ratio: 2.5, within: false })
  })

  it('takes each ratio from the medians of the repeats and holds each repeat to its own quiet run', () => {
    const result = verdict([sitting(2, 3, 9, 4), sitting(4, 5, 12, 4), sitting(3, 20, 6, 4)])
    expect(result.runs.quiet.typed.median).toBe(3)
    expect(result.runs.view.typed).toEqual({ repeats: [3, 5, 20], median: 5, spread: true })
    expect(result.ratios).toEqual({ view: 5 / 3, flood: 9 / 3, search: 4 / 3 })
    // view's medians are within twice quiet's while its third repeat is not
    expect(result.meets).toEqual({ view: false, flood: false, search: true })
    expect(result.runs.flood.typedMedian).toEqual({ repeats: [4.5, 6, 3], median: 4.5, spread: true })
    expect(result.runs.quiet.markedMedian.median).toBe(2)
    expect(result.loads.flood).toEqual({ drawn: [20_000, 20_000, 20_000], throttled: [3, 3, 3] })
  })

  it('keeps the viewport events the marking plugin heard in each run of each repeat and none for a sitting that counted none', () => {
    const counted = (n: number) => {
      const made = sitting(2, 3, 3, 3)
      for (const name of ['quiet', 'view', 'flood', 'search'] as const) made[name].ranges = n
      return made
    }
    expect(verdict([counted(100), counted(101), counted(99)]).ranges).toEqual({ quiet: [100, 101, 99], view: [100, 101, 99], flood: [100, 101, 99], search: [100, 101, 99] })
    expect(verdict([sitting(2, 3, 3, 3)]).ranges).toBeNull()
  })

  it('writes each run with its repeats, its ratio and the conditions it was taken under', () => {
    const text = report({
      title: 'Before', commit: 'abc1234', when: '2026-11-14T10:00:00Z', cpus: 16, model: 'Some CPU', conditions: 'other suites running',
    }, verdict([sitting(2, 3, 9, 4), sitting(4, 5, 12, 4), sitting(3, 20, 6, 4)]))
    expect(text).toContain('## Before')
    expect(text).toContain('abc1234')
    expect(text).toContain('16 logical CPUs')
    expect(text).toContain('other suites running')
    expect(text).toContain('| flood | 9.0, 12.0, 6.0 | 9.0 | 4.5, 6.0, 3.0 | 4.5 | 3.00 | no, repeats spread |')
    expect(text).toContain('| view | 3.0, 5.0, 20.0 | 5.0 | 1.5, 2.5, 10.0 | 2.5 | 1.67 | no, repeats spread |')
    expect(text).toContain('| quiet | 2.0, 4.0, 3.0 | 3.0 | 1.0, 2.0, 1.5 | 1.5 |  | repeats spread |')
    expect(text).toContain('| search | 4.0, 4.0, 4.0 | 4.0 | 2.0, 2.0, 2.0 | 2.0 | 1.33 | yes |')
    expect(text).toContain('within twice the quiet run')
    // What the table computes: the ratio of the medians and the bar held by each repeat
    expect(text).toContain('| run | 95th percentile, repeats | 95th percentile | median, repeats | median | ratio of the medians to quiet | each repeat within the bar |')
    expect(text).toContain("The ratio is the median of the three 95th percentiles of a load over the quiet run's")
    expect(text).not.toContain('editor.viewport events')
    expect(text).not.toMatch(/;/)
  })

  it('writes the viewport events the marking plugin heard in each run when the sittings counted them', () => {
    const made = sitting(2, 3, 3, 3)
    made.quiet.ranges = 100
    made.view.ranges = 101
    made.flood.ranges = 100
    made.search.ranges = 102
    const text = report({ title: 'On', commit: 'abc1234', when: 'now', cpus: 16, model: 'Some CPU', conditions: '' }, verdict([made]))
    expect(text).toContain('- editor.viewport events the marking plugin heard while the keys were typed: quiet 100, view 101, flood 100, search 102')
  })
})
