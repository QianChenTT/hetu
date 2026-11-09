import { describe, expect, it } from 'vitest'
import { fit, fitItems, HINT_SHARE, MAIN_MIN, RAIL, sideMin, UNFOLD_MARGIN } from '../src/fit.ts'
import type { LayoutView } from '@hetu/sdk'

const view = (instance: string, min?: number): LayoutView => ({
  instance, owner: 'p', view: instance, kind: 'view', title: instance, size: min === undefined ? {} : { min }, priority: null, favorite: null, down: false,
})

describe('folding side columns when the window is too narrow', () => {
  const sides = [{ side: 'left' as const, min: 240, rank: 0 }, { side: 'right' as const, min: 240, rank: 1 }]

  it('folds nothing when every minimum fits', () => {
    expect(fit({ width: MAIN_MIN + 480, sides, folded: new Set() })).toEqual(new Set())
  })

  it('folds the lowest-ranked side first, greedily, then the next', () => {
    expect(fit({ width: MAIN_MIN + 400, sides, folded: new Set() })).toEqual(new Set(['right']))
    expect(fit({ width: MAIN_MIN + 100, sides, folded: new Set() })).toEqual(new Set(['left', 'right']))
    const flipped = [{ ...sides[0]!, rank: 1 }, { ...sides[1]!, rank: 0 }]
    expect(fit({ width: MAIN_MIN + 400, sides: flipped, folded: new Set() })).toEqual(new Set(['left']))
  })

  it(`unfolds a folded side only ${UNFOLD_MARGIN} px past the width it needs, so it never flickers`, () => {
    const needed = MAIN_MIN + 480
    expect(fit({ width: needed, sides, folded: new Set(['right']) })).toEqual(new Set(['right']))
    expect(fit({ width: needed + UNFOLD_MARGIN - 1, sides, folded: new Set(['right']) })).toEqual(new Set(['right']))
    expect(fit({ width: needed + UNFOLD_MARGIN, sides, folded: new Set(['right']) })).toEqual(new Set())
  })

  it('opens a side the human now ranks first though it was folded, and folds the other', () => {
    const ranked = [{ side: 'left' as const, min: 160, rank: 1 }, { side: 'right' as const, min: 160, rank: 0 }]
    expect(fit({ width: 600, sides: ranked, folded: new Set(['right']) })).toEqual(new Set(['left']))
  })

  it('counts a folded side as its rail', () => {
    expect(fit({ width: MAIN_MIN + 240 + RAIL, sides, folded: new Set() })).toEqual(new Set(['right']))
    expect(fit({ width: MAIN_MIN + 240 + RAIL - 1, sides, folded: new Set() })).toEqual(new Set(['left', 'right']))
  })
})

describe('a side\'s minimum', () => {
  it(`counts a declared minimum at most ${HINT_SHARE * 100}% of the window`, () => {
    expect(sideMin([view('a', 200)], 1000)).toBe(200)
    expect(sideMin([view('a', 900)], 1000)).toBe(400)
    expect(sideMin([view('a', 100), view('b', 300)], 1000)).toBe(300)
    expect(sideMin([view('a')], 1000)).toBe(160)
  })
})

describe('items in the status row', () => {
  it('shows items in rank order while they fit and folds the rest into a +n button', () => {
    const items = [{ key: 'a', min: 100 }, { key: 'b', min: 100 }, { key: 'c', min: 100 }]
    expect(fitItems(items, 400)).toEqual({ shown: ['a', 'b', 'c'], folded: [] })
    // Folding keeps room for the button
    expect(fitItems(items, 250)).toEqual({ shown: ['a', 'b'], folded: ['c'] })
    expect(fitItems(items, 180)).toEqual({ shown: ['a'], folded: ['b', 'c'] })
  })
})
