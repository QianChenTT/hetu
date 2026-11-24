import { describe, expect, it } from 'vitest'
import type { LayoutState, LayoutView, UiNode } from '../api/ui.ts'
import type { Arrangement } from '../frontend/editor/layout/arrange.ts'
import { startLayout } from '../frontend/editor/layout/layout.ts'

const view = (instance: string, name: string, extra: Partial<LayoutView> = {}): LayoutView => ({
  instance, owner: 'p', view: name, kind: 'view', title: name, size: {}, priority: null, favorite: null, down: false, ...extra,
})

const state = (over: Partial<LayoutState> = {}): LayoutState => ({
  width: 1400, height: 900, editors: ['n1'], current: 'n1', slots: {}, views: [view('v1', 'tree'), view('v2', 'board')], ...over,
})

function nodes(tree: UiNode | null): UiNode[] {
  if (tree === null) return []
  const kids = [...((tree as { children?: UiNode[] }).children ?? [])]
  return [tree, ...kids.flatMap(nodes)]
}

const columnOf = (tree: UiNode | null, instance: string) =>
  nodes(tree).find(node => node.id.startsWith('col-') && nodes(node).some(child => child.kind === 'slot' && (child as { instance?: string }).instance === instance))?.id

// The layout with what it drew last and what it kept last, loaded from saved
function started(saved: unknown = null) {
  const held = { tree: null as UiNode | null, kept: null as Arrangement | null, draws: 0 }
  const layout = startLayout({
    draw: tree => {
      held.tree = tree
      held.draws++
    },
    save: arrangement => {
      held.kept = structuredClone(arrangement)
    },
  })
  layout.loaded(saved)
  return { layout, held }
}

describe("the drawer's layout", () => {
  it('draws the skeleton once it hears the window\'s state, the editor in main and new views in the sides', () => {
    const { layout, held } = started()
    layout.state(state())
    expect(nodes(held.tree).filter(node => node.kind === 'editor')).toEqual([expect.objectContaining({ instance: 'current' })])
    expect(columnOf(held.tree, 'v1')).toBe('col-left')
    expect(columnOf(held.tree, 'v2')).toBe('col-right')
  })

  it('draws nothing and keeps nothing before the arrangement loaded, then draws from what was kept', () => {
    const held = { tree: null as UiNode | null, kept: null as Arrangement | null }
    const layout = startLayout({ draw: tree => void (held.tree = tree), save: arrangement => void (held.kept = arrangement) })
    layout.state(state())
    layout.drop('v2', 'left', 0, 0.5)
    layout.resized('columns', [300, 860, 240])
    layout.event('bottom-toggle', 'click')
    layout.open('v1')
    layout.close('v1')
    expect(held.tree).toBeNull()
    expect(held.kept).toBeNull()
    layout.loaded({ places: { 'p/board': { column: 'left', order: 0, byHand: true } } })
    expect(columnOf(held.tree, 'v2')).toBe('col-left')
  })

  it('moves a dropped view and keeps where the human put it', () => {
    const { layout, held } = started()
    layout.state(state())
    layout.drop('v2', 'left', 0, 0.5)
    expect(columnOf(held.tree, 'v2')).toBe('col-left')
    expect(held.kept?.places['p/board']).toEqual({ column: 'left', order: 0, byHand: true })
  })

  it('takes a drop only of a view it was told of onto a column', () => {
    const { layout, held } = started()
    layout.state(state({ views: [view('v1', 'tree'), view('v2', 'clock', { kind: 'item' })] }))
    layout.drop('v9', 'left', 0, 0)
    layout.drop('v2', 'left', 0, 0)
    layout.drop('v1', 'nowhere', 0, 0)
    expect(held.kept).toBeNull()
  })

  it('keeps the widths the human resized the sides to', () => {
    const { layout, held } = started()
    layout.state(state())
    layout.resized('columns', [300, 860, 240])
    expect(held.kept?.widths.left).toBe(300)
    expect((nodes(held.tree).find(node => node.id === 'columns') as { sizes?: number[] }).sizes?.[0]).toBe(300)
  })

  it('reads the arrangement back when it starts again', () => {
    const first = started()
    first.layout.state(state())
    first.layout.drop('v2', 'left', 1, 0)
    expect(first.held.kept?.places['p/board']?.column).toBe('left')
    const again = started(JSON.parse(JSON.stringify(first.held.kept)))
    again.layout.state(state({ views: [view('v7', 'tree'), view('v8', 'board')] }))
    expect(columnOf(again.held.tree, 'v8')).toBe('col-left')
  })

  it('reads a kept arrangement of another shape as an empty one, keeping only what has its shape', () => {
    for (const saved of [null, 'x', 7, { places: { 'p/board': { column: 'up', order: 0 } }, widths: { left: 'wide' }, hidden: [1] }]) {
      const { layout, held } = started(saved)
      layout.state(state())
      expect(columnOf(held.tree, 'v1'), JSON.stringify(saved)).toBe('col-left')
      expect(columnOf(held.tree, 'v2'), JSON.stringify(saved)).toBe('col-right')
    }
  })

  it('folds the lowest-ranked side to a rail in a narrow window and keeps a favorite open', () => {
    const { layout, held } = started()
    layout.state(state({ width: 560, views: [view('v1', 'tree'), view('v2', 'board', { favorite: 0 })] }))
    const ids = nodes(held.tree).map(node => node.id)
    expect(ids).toContain('rail-left')
    expect(ids).toContain('col-right')
  })

  it('opens a folded side from its rail, folding the other where both don\'t fit', () => {
    const { layout, held } = started()
    layout.state(state({ width: 620, views: [view('v1', 'tree'), view('v2', 'board', { favorite: 0 })] }))
    expect(nodes(held.tree).map(node => node.id)).toContain('rail-left')
    layout.event('rt-v1', 'click')
    const ids = nodes(held.tree).map(node => node.id)
    expect(ids).toContain('col-left')
    expect(ids).toContain('rail-right')
  })

  it('shows a note the human opened in main, after a view was picked there', () => {
    const { layout, held } = started()
    layout.state(state())
    layout.drop('v2', 'main', 1, 0)
    expect(nodes(held.tree).every(node => node.kind !== 'editor')).toBe(true)
    layout.state(state({ editors: ['n1', 'n2'], current: 'n2' }))
    expect(nodes(held.tree).some(node => node.kind === 'editor')).toBe(true)
  })

  it('shows a note whose tab the human clicked in main', () => {
    const { layout, held } = started()
    layout.state(state({ editors: ['n1', 'n2'], current: 'n1' }))
    layout.event('t-n2', 'click')
    expect(nodes(held.tree).find(node => node.kind === 'editor')).toMatchObject({ instance: 'n2' })
  })

  it('hides a view the human closed and shows it again when opened, and keeps both', () => {
    const { layout, held } = started()
    layout.state(state())
    layout.close('v2')
    expect(columnOf(held.tree, 'v2')).toBeUndefined()
    expect(held.kept?.hidden).toEqual(['p/board'])
    layout.open('v2')
    expect(columnOf(held.tree, 'v2')).toBe('col-right')
    expect(held.kept?.hidden).toEqual([])
  })

  it('shows the view picked in a column by its tab', () => {
    const { layout, held } = started()
    layout.state(state({ views: [view('v1', 'tree'), view('v2', 'board'), view('v3', 'files')] }))
    expect(columnOf(held.tree, 'v1')).toBe('col-left')
    layout.event('t-v3', 'click')
    expect(columnOf(held.tree, 'v3')).toBe('col-left')
    expect(columnOf(held.tree, 'v1')).toBeUndefined()
    expect(held.kept?.active.left).toBe('p/files')
  })

  it('opens and closes the status row\'s more items without keeping it', () => {
    const items = Array.from({ length: 30 }, (_, at) => view(`v${at + 1}`, `item${at}`, { kind: 'item' }))
    const { layout, held } = started()
    layout.state(state({ width: 800, views: items }))
    expect(nodes(held.tree).some(node => node.id === 'more')).toBe(true)
    expect(nodes(held.tree).some(node => node.id === 'more-items')).toBe(false)
    layout.event('more', 'click')
    expect(nodes(held.tree).some(node => node.id === 'more-items')).toBe(true)
    expect(held.kept).toBeNull()
  })

  it('draws again on each state and each change, and only then', () => {
    const { layout, held } = started()
    expect(held.draws).toBe(0)
    layout.state(state())
    layout.event('nothing', 'click')
    layout.resized('elsewhere', [1, 2])
    expect(held.draws).toBe(1)
  })
})

describe("the drawer's layout's bottom panel", () => {
  const under = (instance: string, owner: string): LayoutView => ({ ...view(instance, owner), owner })
  const withPanel = (over: Partial<LayoutState> = {}) => state({ views: [view('v1', 'tree'), under('v2', 'footnotes'), under('v3', 'links')], ...over })
  const find = (tree: UiNode | null, id: string) => nodes(tree).find(node => node.id === id)
  const slotted = (tree: UiNode | null) => nodes(find(tree, 'col-bottom') ?? null).filter(node => node.kind === 'slot').map(node => (node as { instance: string }).instance)

  it('places footnotes and links under the note', () => {
    const { layout, held } = started()
    layout.state(withPanel())
    expect(slotted(held.tree)).toEqual(['v2'])
    expect(find(held.tree, 'rows')).toMatchObject({ kind: 'split', direction: 'column' })
  })

  it('folds and opens with its button and keeps it so', () => {
    const { layout, held } = started()
    layout.state(withPanel())
    layout.event('bottom-toggle', 'click')
    expect(find(held.tree, 'rows')).toBeUndefined()
    expect(slotted(held.tree)).toEqual([])
    expect(held.kept?.bottom.open).toBe(false)
    layout.event('bottom-toggle', 'click')
    expect(find(held.tree, 'rows')).toBeDefined()
  })

  it('opens when one of its tabs is clicked while folded, showing that view', () => {
    const { layout, held } = started()
    layout.state(withPanel())
    layout.event('bottom-toggle', 'click')
    layout.event('t-v3', 'click')
    expect(slotted(held.tree)).toContain('v3')
  })

  it('keeps the height the human resized it to, never under its least', () => {
    const { layout, held } = started()
    layout.state(withPanel())
    layout.resized('rows', [500, 310])
    expect((find(held.tree, 'rows') as { sizes?: number[] }).sizes?.[1]).toBe(310)
    expect(held.kept?.bottom.height).toBe(310)
    layout.resized('rows', [790, 20])
    expect((find(held.tree, 'rows') as { sizes?: number[] }).sizes?.[1]).toBe(80)
  })

  it('takes a view dropped on it', () => {
    const { layout, held } = started()
    layout.state(withPanel())
    layout.drop('v1', 'bottom', 1, 0)
    expect(slotted(held.tree)).toContain('v1')
  })

  it('reads its fold back when it starts again', () => {
    const first = started()
    first.layout.state(withPanel())
    first.layout.event('bottom-toggle', 'click')
    const again = started(JSON.parse(JSON.stringify(first.held.kept)))
    again.layout.state(withPanel())
    expect(find(again.held.tree, 'col-bottom')).toBeDefined()
    expect(find(again.held.tree, 'rows')).toBeUndefined()
  })
})
