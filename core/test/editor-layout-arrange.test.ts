import { describe, expect, it } from 'vitest'
import type { LayoutState, LayoutView, UiNode } from '../api/ui.ts'
import { type Arrangement, DROP_BAND, dropView, emptyArrangement, keyOf, place, rank, skeleton, STRIP } from '../frontend/editor/layout/arrange.ts'

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
    // The bottom holds no view here, so it is a drop strip
    expect(all.flatMap(node => (node.zone === undefined ? [] : [node.zone])).sort()).toEqual(['bottom', 'left', 'main', 'right'])
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

describe('the bottom panel', () => {
  const under = (instance: string, owner: string): LayoutView => ({ ...view(instance, owner), owner })
  const state: LayoutState = {
    width: 1200, height: 800, editors: ['n1'], current: 'n1', slots: {},
    views: [view('v1', 'tree'), under('v2', 'footnotes'), under('v3', 'links'), under('v4', 'images')],
  }

  it('takes footnotes, images and links at first and never moves a view the human placed', () => {
    const placed = place(emptyArrangement(), state.views)
    expect(placed.places['footnotes/footnotes']?.column).toBe('bottom')
    expect(placed.places['images/images']?.column).toBe('bottom')
    expect(placed.places['links/links']?.column).toBe('bottom')
    expect(placed.places['p/tree']?.column).toBe('left')
    const byHand = place({ ...emptyArrangement(), places: { 'links/links': { column: 'right', order: 0, byHand: true } } }, state.views)
    expect(byHand.places['links/links']?.column).toBe('right')
  })

  it('splits what main shows from the panel under it, inside main, the editor taking what the panel leaves', () => {
    const all = nodes(skeleton(place(emptyArrangement(), state.views), state, new Set(), new Set()))
    const rows = all.find(node => node.id === 'rows') as Extract<UiNode, { kind: 'split' }>
    expect(rows).toMatchObject({ kind: 'split', direction: 'column', resizable: true, sizes: [0, 200], min: [120, 80] })
    expect(rows.children?.[0]?.kind).toBe('editor')
    expect(nodes(all.find(node => node.id === 'col-main')!)).toContain(rows)
    const panel = all.find(node => node.id === 'col-bottom')!
    expect(panel.zone).toBe('bottom')
    expect(nodes(panel).filter(node => node.kind === 'slot').map(node => (node as { instance: string }).instance)).toEqual(['v2'])
    expect(nodes(panel).filter(node => node.kind === 'title').map(node => (node as { of: string }).of)).toEqual(['v2', 'v3', 'v4'])
  })

  it('shows the view the human picked there', () => {
    const arrangement = { ...place(emptyArrangement(), state.views), active: { left: null, right: null, main: null, bottom: 'links/links' } }
    const panel = nodes(skeleton(arrangement, state, new Set(), new Set())).find(node => node.id === 'col-bottom')!
    expect(nodes(panel).filter(node => node.kind === 'slot').map(node => (node as { instance: string }).instance)).toEqual(['v3'])
  })

  it('folds to its tab strip with no slot and no split', () => {
    const arrangement = { ...place(emptyArrangement(), state.views), bottom: { height: 200, open: false } }
    const all = nodes(skeleton(arrangement, state, new Set(), new Set()))
    expect(all.some(node => node.id === 'rows')).toBe(false)
    const panel = all.find(node => node.id === 'col-bottom')!
    expect(nodes(panel).some(node => node.kind === 'slot')).toBe(false)
    expect(all.find(node => node.id === 'bottom-toggle')).toMatchObject({ kind: 'button', text: '▴' })
    expect(all.some(node => node.kind === 'editor')).toBe(true)
  })

  it('is drawn only while a view is placed there, else as a drop strip', () => {
    const plain: LayoutState = { ...state, views: [view('v1', 'tree')] }
    const all = nodes(skeleton(place(emptyArrangement(), plain.views), plain, new Set(), new Set()))
    expect(all.some(node => node.id === 'col-bottom' || node.id === 'rows')).toBe(false)
    expect(all.find(node => node.id === 'band-bottom')).toMatchObject({ kind: 'box', zone: 'bottom' })
  })
})

// A column with no view in it kept no zone, so a view dragged out of it could never go back
describe('empty columns', () => {
  const state: LayoutState = { width: 1200, height: 800, editors: ['n1'], current: 'n1', slots: {}, views: [view('v1', 'tree')] }

  it('draw each empty side and the empty bottom as a drop strip with a band holding its zone', () => {
    const all = nodes(skeleton(emptyArrangement(), { ...state, views: [] }, new Set(), new Set()))
    expect(all.flatMap(node => (node.zone === undefined ? [] : [node.zone])).sort()).toEqual(['bottom', 'left', 'main', 'right'])
    for (const zone of ['left', 'right', 'bottom']) expect(all.find(node => node.id === `band-${zone}`)).toMatchObject({ kind: 'box', zone })
    expect(all.some(node => node.kind === 'slot')).toBe(false)
  })

  // The core takes the last zone drawn that holds the pointer, so a band drawn after main wins over main where they meet
  it('take a drop anywhere in a band DROP_BAND wide along an empty edge, over main and drawn after it', () => {
    const all = nodes(skeleton(emptyArrangement(), { ...state, views: [] }, new Set(), new Set()))
    const zones = all.flatMap(node => (node.zone === undefined ? [] : [node.zone]))
    for (const zone of ['left', 'right', 'bottom']) expect(zones.indexOf(zone)).toBeGreaterThan(zones.indexOf('main'))
    const style = (id: string) => (all.find(node => node.id === id) as UiNode).style
    const band = { position: 'absolute', 'pointer-events': 'none' }
    expect(style('band-left')).toEqual({ ...band, top: '0', bottom: '0', left: '0', width: `${DROP_BAND}px` })
    expect(style('band-right')).toEqual({ ...band, top: '0', bottom: '0', right: '0', width: `${DROP_BAND}px` })
    expect(style('band-bottom')).toEqual({ ...band, left: '0', right: '0', bottom: '0', height: `${DROP_BAND}px` })
    expect(style('body')).toMatchObject({ position: 'relative' })
    expect(style('under')).toMatchObject({ position: 'relative' })
    // The strip stays as thin as drawn and holds no zone of its own
    for (const zone of ['left', 'right', 'bottom']) {
      const strip = all.find(node => node.id === `drop-${zone}`) as UiNode
      expect(strip.zone).toBeUndefined()
      expect(strip.style).toMatchObject(zone === 'bottom' ? { height: `${STRIP}px` } : { width: `${STRIP}px` })
    }
    expect(DROP_BAND).toBeGreaterThan(STRIP)
  })

  it('draw a side holding views as its column and no strip', () => {
    const all = nodes(skeleton(place(emptyArrangement(), state.views), state, new Set(), new Set()))
    expect(all.some(node => node.id === 'col-left')).toBe(true)
    expect(all.some(node => node.id === 'drop-left' || node.id === 'band-left')).toBe(false)
    expect(all.some(node => node.id === 'drop-right')).toBe(true)
    expect(all.some(node => node.id === 'band-right')).toBe(true)
  })

  // Every view went to main by hand, as on a first day of dragging
  it('take a view dragged back out of main', () => {
    const views = [view('v1', 'files'), view('v2', 'images')]
    let arrangement: Arrangement = {
      ...emptyArrangement(),
      places: { 'p/files': { column: 'main', order: 1, byHand: true }, 'p/images': { column: 'main', order: 0, byHand: true } },
      active: { left: 'p/files', right: null, main: 'p/files', bottom: 'p/images' },
    }
    const before = nodes(skeleton(arrangement, { ...state, views }, new Set(), new Set()))
    expect(before.some(node => node.id === 'drop-left')).toBe(true)
    arrangement = dropView(arrangement, views, 'p/files', 'left', 0)
    expect(arrangement.places['p/files']).toEqual({ column: 'left', order: 0, byHand: true })
    expect(arrangement.active.left).toBe('p/files')
    // It left main, which shows the note again
    expect(arrangement.active.main).toBeNull()
  })
})

describe('dropping a view', () => {
  const views = [view('v1', 'a'), view('v2', 'b'), view('v3', 'c')]
  const arrangement: Arrangement = {
    ...emptyArrangement(),
    places: { 'p/a': { column: 'left', order: 0, byHand: false }, 'p/b': { column: 'left', order: 1, byHand: false }, 'p/c': { column: 'right', order: 0, byHand: false } },
    active: { left: 'p/b', right: 'p/c', main: null, bottom: null },
  }

  it('puts it where in the column it was dropped and marks only it placed by hand', () => {
    const dropped = dropView(arrangement, views, 'p/c', 'left', 0.5)
    expect(dropped.places).toEqual({
      'p/a': { column: 'left', order: 0, byHand: false },
      'p/c': { column: 'left', order: 1, byHand: true },
      'p/b': { column: 'left', order: 2, byHand: false },
    })
    expect(dropped.active.left).toBe('p/c')
  })

  // A2: a column kept naming as shown a view that had left it
  it('clears what the column it left showed, when that was the view', () => {
    expect(dropView(arrangement, views, 'p/c', 'left', 0).active.right).toBeNull()
    expect(dropView(arrangement, views, 'p/a', 'right', 0).active.left).toBe('p/b')
  })
})
