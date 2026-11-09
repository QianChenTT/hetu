import { describe, expect, it } from 'vitest'
import type { LayoutState, LayoutView, UiNode } from '@hetu/sdk'
import { type Arrangement, emptyArrangement, keyOf, place, rank, skeleton } from '../src/arrange.ts'

const view = (instance: string, view: string, extra: Partial<LayoutView> = {}): LayoutView => ({
  instance, owner: 'p', view, kind: 'view', title: view, size: {}, priority: null, favorite: null, down: false, ...extra,
})

describe('ranking views', () => {
  it('puts favorites first, then views placed by hand, then the most recently shown, then hints, then names', () => {
    const views = [
      view('v1', 'hinted', { priority: 90 }),
      view('v2', 'recent'),
      view('v3', 'placed'),
      view('v4', 'liked', { favorite: 0 }),
      view('v5', 'plain'),
      view('v6', 'liked-more', { favorite: 1 }),
    ]
    const arrangement: Arrangement = {
      ...emptyArrangement(),
      places: { 'p/placed': { column: 'left', order: 0, byHand: true } },
      recent: { 'p/recent': 3 },
    }
    expect(rank(views, arrangement).map(each => each.view)).toEqual(['liked', 'liked-more', 'placed', 'recent', 'hinted', 'plain'])
  })

  it('never lets a hint rank above a view the human touched', () => {
    const views = [view('v1', 'loud', { priority: 100 }), view('v2', 'used')]
    const arrangement: Arrangement = { ...emptyArrangement(), recent: { 'p/used': 1 } }
    expect(rank(views, arrangement).map(each => each.view)).toEqual(['used', 'loud'])
  })
})

describe('placing new views', () => {
  it('puts a new view in the side holding fewer and never moves one the human placed', () => {
    let arrangement: Arrangement = { ...emptyArrangement(), places: { 'p/a': { column: 'left', order: 0, byHand: true } } }
    arrangement = place(arrangement, [view('v1', 'a'), view('v2', 'b'), view('v3', 'c')])
    expect(arrangement.places['p/a']).toEqual({ column: 'left', order: 0, byHand: true })
    expect(arrangement.places['p/b']).toMatchObject({ column: 'right', byHand: false })
    expect(arrangement.places['p/c']?.column).toBe('left')
  })

  it('leaves items to the status row', () => {
    const arrangement = place(emptyArrangement(), [view('v1', 'count', { kind: 'item' })])
    expect(arrangement.places).toEqual({})
  })
})

function nodes(tree: UiNode): UiNode[] {
  const kids = [...((tree as { children?: UiNode[] }).children ?? [])]
  return [tree, ...kids.flatMap(nodes)]
}

describe('the skeleton', () => {
  const state: LayoutState = {
    width: 1200, height: 800, editors: ['n1', 'n2'], current: 'n2', slots: {},
    views: [view('v1', 'tree'), view('v2', 'board'), view('v3', 'count', { kind: 'item' })],
  }
  const arrangement = place(emptyArrangement(), state.views)

  it('places the current editor, a title for every editor instance and the views in their columns', () => {
    const tree = skeleton(arrangement, state, new Set(), new Set())
    const all = nodes(tree)
    expect(all.filter(node => node.kind === 'editor')).toEqual([expect.objectContaining({ instance: 'current' })])
    expect(all.filter(node => node.kind === 'title').map(node => (node as { of: string }).of).sort()).toEqual(['n1', 'n2', 'v1', 'v2'])
    expect(all.filter(node => node.kind === 'slot').map(node => (node as { instance: string }).instance).sort()).toEqual(['v1', 'v2', 'v3'])
  })

  it('marks each column a zone for views and the columns a resizable split', () => {
    const all = nodes(skeleton(arrangement, state, new Set(), new Set()))
    expect(all.flatMap(node => (node.zone === undefined ? [] : [node.zone])).sort()).toEqual(['left', 'main', 'right'])
    const split = all.find(node => node.kind === 'split') as Extract<UiNode, { kind: 'split' }>
    expect(split.resizable).toBe(true)
    expect(split.sizes).toEqual([240, 0, 240])
  })

  it('draws a folded side as a rail of titles with no slot', () => {
    const all = nodes(skeleton(arrangement, state, new Set(['right']), new Set()))
    const right = keyOf(state.views[1]!)
    expect(arrangement.places[right]?.column).toBe('right')
    expect(all.some(node => node.id === 'rail-right')).toBe(true)
    expect(all.filter(node => node.kind === 'slot').map(node => (node as { instance: string }).instance)).not.toContain('v2')
  })

  it('folds items into a +n button with a popover holding their slots', () => {
    const all = nodes(skeleton(arrangement, state, new Set(), new Set(['v3']), true))
    expect(all.find(node => node.id === 'more')).toMatchObject({ kind: 'button', text: '+1' })
    expect(all.find(node => node.kind === 'popover')).toMatchObject({ anchor: 'more' })
  })

  it('shows the view the human picked in main in place of the editor', () => {
    const picked: Arrangement = { ...arrangement, places: { ...arrangement.places, 'p/board': { column: 'main', order: 0, byHand: true } }, active: { ...arrangement.active, main: 'p/board' } }
    const all = nodes(skeleton(picked, state, new Set(), new Set()))
    expect(all.filter(node => node.kind === 'editor')).toEqual([])
    expect(all.filter(node => node.kind === 'slot').map(node => (node as { instance: string }).instance)).toContain('v2')
  })
})
