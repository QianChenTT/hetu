import type { LayoutState, LayoutView, UiNode } from '@hetu/sdk'
import { ITEM_MIN, MAIN_MIN, RAIL, type Side, SIDE_DEFAULT, sideMin } from './fit.ts'

// hetu's own layout: three columns, left, main and right, over a status row. A side shows one view at a time with the
// others as tabs, main shows the current note or a view the human picked with every note and main view as tabs, and
// the status row holds items in rank order. The human's arrangement is kept by view as owner/view, since instance ids
// change with each editor page. Titles are the drawer's: the layout places them and never learns a note's path or a
// title set while running

export type Column = Side | 'main'
export type Place = { column: Column, order: number, byHand: boolean }
export type Arrangement = {
  places: Record<string, Place>
  widths: Record<Side, number>
  // The view each column shows. main holds a view's key or an editor instance, null for the current note
  active: { left: string | null, right: string | null, main: string | null }
  hidden: string[]
  // When each view was last shown by the human, as a counter
  recent: Record<string, number>
}

export function emptyArrangement(): Arrangement {
  return { places: {}, widths: { left: SIDE_DEFAULT, right: SIDE_DEFAULT }, active: { left: null, right: null, main: null }, hidden: [], recent: {} }
}

export function keyOf(view: Pick<LayoutView, 'owner' | 'view'>): string {
  return `${view.owner}/${view.view}`
}

// Favorites in their order, then views placed by hand, then the most recently shown, then the plugin's hint, then name.
// A hint orders only views the human never touched, since by then recent use ranks them first
export function rank(views: readonly LayoutView[], arrangement: Arrangement): LayoutView[] {
  const score = (view: LayoutView) => {
    const key = keyOf(view)
    return [
      view.favorite ?? Number.MAX_SAFE_INTEGER,
      arrangement.places[key]?.byHand === true ? 0 : 1,
      -(arrangement.recent[key] ?? 0),
      -(view.priority ?? 0),
    ]
  }
  return [...views].sort((a, b) => {
    const [x, y] = [score(a), score(b)]
    for (let at = 0; at < x.length; at++) if (x[at] !== y[at]) return (x[at] as number) - (y[at] as number)
    return keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0
  })
}

// Each new view goes to the side holding fewer, left on a tie. A view the human placed never moves. Items stay in the
// status row
export function place(arrangement: Arrangement, views: readonly LayoutView[]): Arrangement {
  const places = { ...arrangement.places }
  const keys = new Set(views.filter(view => view.kind === 'view').map(keyOf))
  const count = (column: Column) => Object.entries(places).filter(([key, at]) => keys.has(key) && at.column === column).length
  for (const key of keys) {
    if (places[key] !== undefined) continue
    const column: Side = count('left') <= count('right') ? 'left' : 'right'
    places[key] = { column, order: count(column), byHand: false }
  }
  return { ...arrangement, places }
}

// The views of a column in their order, hidden ones left out, one instance per entry
export function columnViews(arrangement: Arrangement, views: readonly LayoutView[], column: Column): LayoutView[] {
  return views
    .filter(view => view.kind === 'view' && arrangement.places[keyOf(view)]?.column === column && !arrangement.hidden.includes(keyOf(view)))
    .sort((a, b) => (arrangement.places[keyOf(a)]?.order ?? 0) - (arrangement.places[keyOf(b)]?.order ?? 0) || (a.instance < b.instance ? -1 : 1))
}

const border = '1px solid var(--hetu-color-border)'
const tabStrip = {
  display: 'flex', 'flex-direction': 'row', height: '28px', 'min-height': '28px', overflow: 'hidden',
  'background-color': 'var(--hetu-color-surface)', 'border-bottom': border,
}
const tabStyle = (active: boolean) => ({
  display: 'flex', 'min-width': '0', width: '160px', 'max-width': '200px',
  'border-right': border, opacity: active ? '1' : '0.7',
})

function tab(id: string, of: string, active: boolean): UiNode {
  return { kind: 'box', id: `tab-${id}`, style: tabStyle(active), children: [{ kind: 'title', id: `t-${id}`, of, style: { flex: '1', 'min-width': '0' } }] }
}

function sideColumn(side: Side, views: readonly LayoutView[], active: string | null): UiNode {
  const shown = views.find(view => keyOf(view) === active) ?? views[0]
  return {
    kind: 'box',
    id: `col-${side}`,
    zone: side,
    style: { display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%' },
    children: [
      { kind: 'box', id: `tabs-${side}`, style: tabStrip, children: views.map(view => tab(view.instance, view.instance, view === shown)) },
      ...(shown === undefined ? [] : [{ kind: 'slot', id: `s-${shown.instance}`, instance: shown.instance, style: { flex: '1', 'min-height': '0' } } as UiNode]),
    ],
  }
}

function rail(side: Side, views: readonly LayoutView[]): UiNode {
  return {
    kind: 'box',
    id: `rail-${side}`,
    zone: side,
    style: { display: 'flex', 'flex-direction': 'column', width: `${RAIL}px`, height: '100%', 'background-color': 'var(--hetu-color-surface)' },
    children: views.map(view => ({ kind: 'title', id: `rt-${view.instance}`, of: view.instance, style: { height: '28px', 'border-bottom': border } }) as UiNode),
  }
}

// The window's skeleton. folded holds the sides drawn as rails and the items behind the +n button, moreOpen whether
// its popover shows
export function skeleton(arrangement: Arrangement, state: LayoutState, folded: ReadonlySet<Side>, foldedItems: ReadonlySet<string>, moreOpen = false): UiNode {
  const live = state.views
  const main = columnViews(arrangement, live, 'main')
  const mainView = main.find(view => keyOf(view) === arrangement.active.main)
  const mainEditor = arrangement.active.main !== null && state.editors.includes(arrangement.active.main) ? arrangement.active.main : null
  const mainTabs: UiNode[] = [
    ...state.editors.map(id => tab(id, id, mainView === undefined && (mainEditor ?? state.current) === id)),
    ...main.map(view => tab(view.instance, view.instance, view === mainView)),
  ]
  const mainColumn: UiNode = {
    kind: 'box',
    id: 'col-main',
    zone: 'main',
    style: { display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%' },
    children: [
      { kind: 'box', id: 'tabs-main', style: tabStrip, children: mainTabs },
      mainView !== undefined
        ? { kind: 'slot', id: `s-${mainView.instance}`, instance: mainView.instance, style: { flex: '1', 'min-height': '0' } }
        : { kind: 'editor', id: 'editor', instance: mainEditor ?? 'current', style: { flex: '1', 'min-height': '0' } },
    ],
  }

  // Main takes what the sides leave, which a split's size of 0 says
  const sideOf = (side: Side) => {
    const views = columnViews(arrangement, live, side)
    if (views.length === 0) return []
    return [folded.has(side)
      ? { node: rail(side, views), size: RAIL, min: RAIL }
      : { node: sideColumn(side, views, arrangement.active[side]), size: arrangement.widths[side], min: sideMin(views, state.width) }]
  }
  const columns = [...sideOf('left'), { node: mainColumn, size: 0, min: MAIN_MIN }, ...sideOf('right')]
  const body: UiNode = columns.length === 1
    ? { ...mainColumn, style: { ...mainColumn.style, flex: '1', 'min-height': '0' } }
    : {
      kind: 'split',
      id: 'columns',
      direction: 'row',
      resizable: true,
      style: { flex: '1', 'min-height': '0' },
      children: columns.map(column => column.node),
      sizes: columns.map(column => column.size),
      min: columns.map(column => column.min),
    }

  const items = live.filter(view => view.kind === 'item' && !arrangement.hidden.includes(keyOf(view)))
  const slotOf = (view: LayoutView): UiNode => ({
    kind: 'slot', id: `s-${view.instance}`, instance: view.instance, style: { 'min-width': `${view.size.min ?? ITEM_MIN}px`, height: '100%' },
  })
  const shownItems = items.filter(view => !foldedItems.has(view.instance))
  const hiddenItems = items.filter(view => foldedItems.has(view.instance))
  const status: UiNode = {
    kind: 'box',
    id: 'status',
    style: { display: 'flex', 'flex-direction': 'row', 'align-items': 'center', gap: '8px', height: '24px', 'border-top': border, padding: '0 8px' },
    children: [
      ...shownItems.map(slotOf),
      ...(hiddenItems.length === 0 ? [] : [
        { kind: 'button', id: 'more', text: `+${hiddenItems.length}`, tip: 'More items' } as UiNode,
        ...(moreOpen ? [{ kind: 'popover', id: 'more-items', anchor: 'more', side: 'above', children: hiddenItems.map(slotOf) } as UiNode] : []),
      ]),
    ],
  }
  return {
    kind: 'box',
    id: 'root',
    style: { display: 'flex', 'flex-direction': 'column', height: '100%' },
    children: items.length === 0 ? [body] : [body, status],
  }
}
