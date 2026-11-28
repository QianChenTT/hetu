import { describe, expect, it } from 'vitest'
import { check, summarize, type Baseline, type Kind, type Measure, type Sample } from './timing.ts'

const machine = { freeGb: 6, load: 4, others: 2 }
const sample = (kind: Kind, ms: Partial<Record<Measure, number>>): Sample => ({
  kind, ms: { ready: 575, shown: 700, editor: 147, firstNote: 11, quit: 280, ...ms }, quitTotalMs: 1030, stoppingMs: 858,
  before: machine, after: machine, othersRose: false,
})
const five = (values: Partial<Record<Measure, number>>[]) => values.map(ms => sample('cold', ms))
// The proposed values, on the cold kind alone
const measures = { 'cold.ready': 575, 'cold.shown': 700, 'cold.editor': 147, 'cold.firstNote': 11, 'cold.quit': 280 }
const set = (more: Partial<Extract<Baseline, { status: 'set' }>> = {}): Baseline => ({ status: 'set', factor: 2, factors: { 'cold.firstNote': 5 }, spreadShare: 1, measures, ...more })

describe('tier 0 timing\'s check', () => {
  it('keeps each measure\'s values in run order with the first, median, slowest and spread', () => {
    const summary = summarize(five([{ shown: 900 }, { shown: 700 }, { shown: 650 }, { shown: 1000 }, { shown: 720 }]))
    expect(summary['cold.shown']).toEqual({ values: [900, 700, 650, 1000, 720], first: 900, median: 720, max: 1000, spread: 350 })
  })

  it('passes a run like its baseline and checks nothing while pending', () => {
    const summary = summarize(five([{}, {}, {}, {}, {}]))
    expect(check(set(), summary)).toEqual([])
    expect(check({ status: 'pending' }, summarize(five([{ shown: Number.NaN }])))).toEqual([])
  })

  it('fails 2 slow starts of 5 that the median hides, on the slowest and on the spread', () => {
    const summary = summarize(five([{ shown: 700 }, { shown: 2200 }, { shown: 690 }, { shown: 2240 }, { shown: 710 }]))
    expect(summary['cold.shown']!.median).toBe(710)
    expect(check(set(), summary)).toEqual([
      'cold.shown: slowest 2240 ms (median 710 ms, first 700 ms), past its baseline 700 ms × 2 = 1400 ms',
      'cold.shown: spread 1550 ms, past 1 × its median 710 ms',
    ])
  })

  it('fails F6 on the editor stage when a baseline set on a busy machine lets its whole start pass at factor 2', () => {
    const busy = set({ measures: { ...measures, 'cold.shown': 1200, 'cold.ready': 1100 } })
    const f6 = summarize(five([1, 2, 3, 4, 5].map(step => ({ ready: 595, shown: 2230 + step, editor: 1648 + step }))))
    expect(check(busy, f6)).toEqual(['cold.editor: slowest 1653 ms (median 1651 ms, first 1649 ms), past its baseline 147 ms × 2 = 294 ms'])
  })

  it('fails 1000 ms of added work at the quit, which is timed without the draft grace', () => {
    const slow = summarize(five([1, 2, 3, 4, 5].map(() => ({ quit: 1280 }))))
    expect(check(set(), slow)).toEqual(['cold.quit: slowest 1280 ms (median 1280 ms, first 1280 ms), past its baseline 280 ms × 2 = 560 ms'])
  })

  it('fails a value that is no time above 0, naming the sample', () => {
    const summary = summarize(five([{ editor: 0 }, { editor: Number.NaN }, {}, {}, {}]))
    expect(check(set(), summary)).toEqual(['cold.editor: sample 1 is 0 ms, sample 2 is NaN ms, not times above 0'])
  })

  it('fails a baseline with a value of 0 or NaN, a missing measure or a key no measure has, before any run is checked', () => {
    const broken = set({ measures: { 'cold.ready': 0, 'cold.shown': Number.NaN, 'cold.firstNote': 11, 'cold.quit': 280, 'cold.redy': 575 } })
    expect(check(broken, summarize(five([{}, {}, {}, {}, {}])))).toEqual([
      'baseline cold.ready: 0 is not a time above 0',
      'baseline cold.shown: NaN is not a time above 0',
      'baseline cold.redy: no measure has that name',
      'cold.editor: 147 ms with no baseline',
    ])
    expect(check(set({ factor: 0 }), summarize(five([{}])))).toEqual(['baseline factor: 0 is not a factor above 1'])
  })
})
