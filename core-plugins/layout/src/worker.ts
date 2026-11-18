import { definePlugin, type LayoutState, type LayoutView, type PluginContext } from '@hetu/sdk'
import { type Arrangement, type Column, columnViews, emptyArrangement, keyOf, place, rank, skeleton } from './arrange.ts'
import { fit, fitItems, ITEM_MIN, type Side, sideMin } from './fit.ts'

// hetu's own layout, the first-party plugin holding ui.layout. It hears the window's state from the drawer, places
// every view, folds what doesn't fit and draws the skeleton. The drawer runs drags and resizes and tells it only the
// result, which it keeps in its own storage as the human's arrangement

const KEY = 'arrangement'
const COLUMNS: readonly Column[] = ['left', 'main', 'right']

function isColumn(value: string): value is Column {
  return (COLUMNS as readonly string[]).includes(value)
}

// What storage holds, taken only in the shape this layout writes
function arrangementOf(value: unknown): Arrangement {
  const empty = emptyArrangement()
  if (typeof value !== 'object' || value === null) return empty
  const held = value as Partial<Arrangement>
  const places: Arrangement['places'] = {}
  for (const [key, at] of Object.entries(held.places ?? {})) {
    if (typeof at === 'object' && at !== null && isColumn(String(at.column)) && typeof at.order === 'number') {
      places[key] = { column: at.column, order: at.order, byHand: at.byHand === true }
    }
  }
  const width = (side: Side) => (typeof held.widths?.[side] === 'number' ? held.widths[side] : empty.widths[side])
  const recent: Record<string, number> = {}
  for (const [key, when] of Object.entries(held.recent ?? {})) if (typeof when === 'number') recent[key] = when
  // A column shows the view it showed. A note's instance in main is the last page's, so main starts on the current note
  const view = (value: unknown) => (typeof value === 'string' && value.includes('/') ? value : null)
  return {
    places,
    widths: { left: width('left'), right: width('right') },
    active: { left: view(held.active?.left), right: view(held.active?.right), main: view(held.active?.main) },
    hidden: Array.isArray(held.hidden) ? held.hidden.filter((key): key is string => typeof key === 'string') : [],
    recent,
  }
}

export default definePlugin({
  async start(ctx: PluginContext) {
    const saved = await ctx.try(ctx.storage.get({ key: KEY }))
    let arrangement = arrangementOf(saved.ok ? saved.value : null)
    let state: LayoutState | null = null
    let folded = new Set<Side>()
    let moreOpen = false
    // A side the human opened from its rail, which folds last
    let opened: Side | null = null
    let counter = Math.max(0, ...Object.values(arrangement.recent))
    // The columns the last skeleton split, in order, for a resize's sizes
    let split: string[] = []

    // The writes not yet answered. A stop waits for them within the grace, so a quit right after a resize keeps it. A
    // write begun while it waits is waited for too
    const writing = new Set<Promise<unknown>>()
    const save = () => {
      const write = ctx.try(ctx.storage.set({ key: KEY, value: arrangement }))
      writing.add(write)
      void write.then(() => writing.delete(write))
    }
    ctx.onStop(async () => {
      while (writing.size > 0) await Promise.all(writing)
    })
    const viewOf = (instance: string): LayoutView | undefined => state?.views.find(view => view.instance === instance)
    const shown = (key: string) => {
      arrangement.recent[key] = ++counter
    }

    const draw = () => {
      if (state === null) return
      const now = state
      arrangement = place(arrangement, now.views)
      const ranked = rank(now.views, arrangement)
      const order = new Map(ranked.map((view, at) => [view.instance, at]))
      const sides = (['left', 'right'] as const).flatMap(side => {
        const views = columnViews(arrangement, now.views, side)
        if (views.length === 0) return []
        const rankOf = side === opened ? -1 : Math.min(...views.map(view => order.get(view.instance) ?? Number.MAX_SAFE_INTEGER))
        return [{ side, min: sideMin(views, now.width), rank: rankOf }]
      })
      folded = fit({ width: now.width, sides, folded })
      const items = ranked.filter(view => view.kind === 'item' && !arrangement.hidden.includes(keyOf(view)))
      const foldedItems = new Set(fitItems(items.map(view => ({ key: view.instance, min: view.size.min ?? ITEM_MIN })), now.width - 16).folded)
      const tree = skeleton(arrangement, now, folded, foldedItems, moreOpen)
      split = ((tree as { children?: { kind: string, children?: { id: string }[] }[] }).children?.[0]?.kind === 'split')
        ? ((tree as { children: { children: { id: string }[] }[] }).children[0]?.children ?? []).map(child => child.id)
        : []
      void ctx.try(ctx.ui.layout.draw(tree))
    }

    ctx.ui.on('layout.state', event => {
      const before = state?.current
      state = event.state
      // A note the human opened shows in main
      if (before !== undefined && before !== state.current) arrangement.active.main = null
      draw()
    })

    ctx.ui.on('layout.drop', event => {
      const view = viewOf(event.instance)
      if (view === undefined || view.kind !== 'view' || !isColumn(event.zone) || state === null) return
      const key = keyOf(view)
      const others = columnViews(arrangement, state.views, event.zone).filter(each => keyOf(each) !== key)
      const at = Math.round(event.x * others.length)
      const keys = [...others.slice(0, at).map(keyOf), key, ...others.slice(at).map(keyOf)]
      const places = { ...arrangement.places }
      keys.forEach((each, order) => {
        places[each] = { column: event.zone as Column, order, byHand: each === key ? true : places[each]?.byHand ?? false }
      })
      arrangement = { ...arrangement, places, active: { ...arrangement.active, [event.zone]: key } }
      shown(key)
      save()
      draw()
    })

    ctx.ui.on('layout.resized', event => {
      if (event.node !== 'columns') return
      split.forEach((id, at) => {
        const size = event.sizes[at]
        if (size === undefined) return
        if (id === 'col-left') arrangement.widths.left = Math.round(size)
        if (id === 'col-right') arrangement.widths.right = Math.round(size)
      })
      save()
      draw()
    })

    ctx.ui.on('layout.event', event => {
      if (event.node === 'more' && event.type === 'click') {
        moreOpen = !moreOpen
        draw()
        return
      }
      const match = /^(t|rt)-([vn][0-9]+)$/.exec(event.node)
      if (match === null || event.type !== 'click') return
      const instance = match[2] as string
      if (instance.startsWith('n')) {
        arrangement.active.main = instance
        draw()
        return
      }
      const view = viewOf(instance)
      const column = view === undefined ? undefined : arrangement.places[keyOf(view)]?.column
      if (view === undefined || column === undefined) return
      arrangement.active[column] = keyOf(view)
      if (match[1] === 'rt' && column !== 'main') opened = column
      shown(keyOf(view))
      save()
      draw()
    })

    ctx.ui.on('layout.open', event => {
      const view = viewOf(event.instance)
      if (view === undefined) return
      const key = keyOf(view)
      arrangement.hidden = arrangement.hidden.filter(each => each !== key)
      arrangement = place(arrangement, state?.views ?? [])
      const column = arrangement.places[key]?.column
      if (column !== undefined) {
        arrangement.active[column] = key
        if (column !== 'main' && folded.has(column)) opened = column
      }
      shown(key)
      save()
      draw()
    })

    ctx.ui.on('layout.close', event => {
      const view = viewOf(event.instance)
      if (view === undefined) return
      const key = keyOf(view)
      if (!arrangement.hidden.includes(key)) arrangement.hidden = [...arrangement.hidden, key]
      save()
      draw()
    })
  },
})
