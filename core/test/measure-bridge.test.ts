import { describe, expect, it } from 'vitest'
import { kept, report, type Sitting, summary, verdict, within } from '../../scripts/measure-bridge.ts'

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

  it('holds a loaded run within twice the quiet one and within a frame', () => {
    expect(within(4, 8)).toBe(true)
    expect(within(4, 8.1)).toBe(false)
    expect(within(10, 16)).toBe(true)
    expect(within(10, 17)).toBe(false)
  })

  it('takes each ratio from the medians of the repeats of one sitting', () => {
    const result = verdict([sitting(2, 3, 9, 4), sitting(4, 5, 12, 4), sitting(3, 20, 6, 4)])
    expect(result.runs.quiet.typed.median).toBe(3)
    expect(result.runs.view.typed).toEqual({ repeats: [3, 5, 20], median: 5, spread: true })
    expect(result.ratios).toEqual({ view: 5 / 3, flood: 9 / 3, search: 4 / 3 })
    expect(result.meets).toEqual({ view: true, flood: false, search: true })
    expect(result.loads.flood).toEqual({ drawn: [20_000, 20_000, 20_000], throttled: [3, 3, 3] })
  })

  it('writes each run with its repeats, its ratio and the conditions it was taken under', () => {
    const text = report({
      title: 'Before', commit: 'abc1234', when: '2026-11-14T10:00:00Z', cpus: 16, model: 'Some CPU', conditions: 'other suites running',
    }, verdict([sitting(2, 3, 9, 4), sitting(4, 5, 12, 4), sitting(3, 20, 6, 4)]))
    expect(text).toContain('## Before')
    expect(text).toContain('abc1234')
    expect(text).toContain('16 logical CPUs')
    expect(text).toContain('other suites running')
    expect(text).toContain('| flood | 9.0, 12.0, 6.0 | 9.0 | 3.00 | no, repeats spread |')
    expect(text).toContain('| view | 3.0, 5.0, 20.0 | 5.0 | 1.67 | yes, repeats spread |')
    expect(text).not.toMatch(/;/)
  })
})
