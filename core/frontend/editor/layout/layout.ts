import { z } from 'zod'
import { MAX_VIEW_SIZE } from '../../../api/manifest.ts'
import type { LayoutState, LayoutView, NodeEventType, UiNode } from '../../../api/ui.ts'
import { viewKey } from '../settings.ts'
import { type Arrangement, type Column, columnViews, dropView, emptyArrangement, keyOf, place, rank, skeleton, splitColumns, STRIP } from './arrange.ts'
import { BOTTOM_DEFAULT, BOTTOM_MIN, fit, fitItems, ITEM_MIN, type Side, SIDE_DEFAULT, sideMin } from './fit.ts'

// hetu's layout, a part of the drawer. It hears the window's state, places every view, folds what doesn't fit and
// draws the skeleton. The drawer runs drags and resizes and tells it only the result, which it keeps in the window's
// settings as the human's arrangement

export type LayoutOptions = {
  // The skeleton, drawn as the drawer's own tree
  draw(tree: UiNode): void
  // The human's arrangement, to keep in the window's settings
  save(arrangement: Arrangement): void
}

export type Layout = {
  // The arrangement the window's settings held. Nothing is drawn or kept before it loaded
  loaded(saved: unknown): void
  state(state: LayoutState): void
  // A view dropped onto a zone, x and y where in the zone from 0 to 1
  drop(instance: string, zone: string, x: number, y: number): void
  // The human asked from the views menu for a view to show, or to go
  open(instance: string): void
  close(instance: string): void
  // A split of the skeleton the human resized
  resized(node: string, sizes: readonly number[]): void
  // What the human did to a node of the skeleton
  event(node: string, type: NodeEventType): void
}

const COLUMNS = ['left', 'main', 'right', 'bottom'] as const satisfies readonly Column[]

function isColumn(value: string): value is Column {
  return (COLUMNS as readonly string[]).includes(value)
}

// Views each of places, recent and hidden holds at most
export const MAX_ARRANGED = 512

// Places, recent views and hidden views keyed by view as owner/view, so a key such as __proto__ or constructor names no
// view and refuses the map it is in
const keyed = <T extends z.ZodType>(value: T) =>
  z.record(viewKey, value).refine(held => Object.keys(held).length <= MAX_ARRANGED).catch(() => ({}))
// A column shows the view it showed. A note's instance in main is the last page's, so main starts on the current note
const shown = viewKey.nullable().catch(null)
const size = (fallback: number, least = 0) => z.int().min(least).max(MAX_VIEW_SIZE).catch(fallback)

// What the settings hold, parsed once as it is read. A field of another shape or past its bounds is read as it starts,
// each a new value, since the layout changes what it holds in place
const stored = z.object({
  places: keyed(z.object({ column: z.enum(COLUMNS), order: z.int().min(0).max(MAX_ARRANGED), byHand: z.boolean().catch(false) })),
  widths: z.object({ left: size(SIDE_DEFAULT), right: size(SIDE_DEFAULT) }).catch(() => ({ left: SIDE_DEFAULT, right: SIDE_DEFAULT })),
  bottom: z.object({ height: size(BOTTOM_DEFAULT, BOTTOM_MIN), open: z.boolean().catch(true) }).catch(() => ({ height: BOTTOM_DEFAULT, open: true })),
  active: z.object({ left: shown, right: shown, main: shown, bottom: shown }).catch(() => ({ left: null, right: null, main: null, bottom: null })),
  hidden: z.array(viewKey).max(MAX_ARRANGED).catch(() => []),
  recent: keyed(z.int().min(0)),
})

function arrangementOf(value: unknown): Arrangement {
  const parsed = stored.safeParse(typeof value === 'object' && value !== null ? value : {})
  return parsed.success ? parsed.data : emptyArrangement()
}

export function startLayout(options: LayoutOptions): Layout {
  let loaded = false
  let arrangement = emptyArrangement()
  let state: LayoutState | null = null
  let folded = new Set<Side>()
  let moreOpen = false
  // A side the human opened from its rail, which folds last
  let opened: Side | null = null
  let counter = 0
  // The columns the last skeleton split, in order, for a resize's sizes
  let split: string[] = []

  const save = () => options.save(arrangement)
  const viewOf = (instance: string): LayoutView | undefined => state?.views.find(view => view.instance === instance)
  const shown = (key: string) => {
    arrangement.recent[key] = ++counter
  }

  const draw = () => {
    if (state === null || !loaded) return
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
    // An empty side's drop strip takes its width before the columns get theirs
    const strips = (['left', 'right'] as const).filter(side => columnViews(arrangement, now.views, side).length === 0).length * STRIP
    folded = fit({ width: now.width - strips, sides, folded })
    const items = ranked.filter(view => view.kind === 'item' && !arrangement.hidden.includes(keyOf(view)))
    const foldedItems = new Set(fitItems(items.map(view => ({ key: view.instance, min: view.size.min ?? ITEM_MIN })), now.width - 16).folded)
    const tree = skeleton(arrangement, now, folded, foldedItems, moreOpen)
    split = splitColumns(tree)
    options.draw(tree)
  }

  return {
    loaded(saved) {
      arrangement = arrangementOf(saved)
      counter = Math.max(0, ...Object.values(arrangement.recent))
      loaded = true
      draw()
    },

    state(next) {
      const before = state?.current
      state = next
      // A note the human opened shows in main
      if (before !== undefined && before !== state.current) arrangement.active.main = null
      draw()
    },

    drop(instance, zone, x) {
      const view = viewOf(instance)
      if (!loaded || view === undefined || view.kind !== 'view' || !isColumn(zone) || state === null) return
      const key = keyOf(view)
      arrangement = dropView(arrangement, state.views, key, zone, x)
      shown(key)
      save()
      draw()
    },

    resized(node, sizes) {
      if (!loaded) return
      // The bottom panel's split: what main shows, then the panel
      if (node === 'rows') {
        const size = sizes[1]
        if (size === undefined) return
        arrangement.bottom = { ...arrangement.bottom, height: Math.max(BOTTOM_MIN, Math.round(size)) }
        save()
        draw()
        return
      }
      if (node !== 'columns') return
      split.forEach((id, at) => {
        const size = sizes[at]
        if (size === undefined) return
        if (id === 'col-left') arrangement.widths.left = Math.round(size)
        if (id === 'col-right') arrangement.widths.right = Math.round(size)
      })
      save()
      draw()
    },

    event(node, type) {
      if (!loaded) return
      if (node === 'more' && type === 'click') {
        moreOpen = !moreOpen
        draw()
        return
      }
      if (node === 'bottom-toggle' && type === 'click') {
        arrangement.bottom = { ...arrangement.bottom, open: !arrangement.bottom.open }
        save()
        draw()
        return
      }
      const match = /^(t|rt)-([vn][0-9]+)$/.exec(node)
      if (match === null || type !== 'click') return
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
      if (match[1] === 'rt' && (column === 'left' || column === 'right')) opened = column
      // A tab of the folded panel opens it
      if (column === 'bottom') arrangement.bottom = { ...arrangement.bottom, open: true }
      shown(keyOf(view))
      save()
      draw()
    },

    open(instance) {
      const view = viewOf(instance)
      if (!loaded || view === undefined) return
      const key = keyOf(view)
      arrangement.hidden = arrangement.hidden.filter(each => each !== key)
      arrangement = place(arrangement, state?.views ?? [])
      const column = arrangement.places[key]?.column
      if (column !== undefined) {
        arrangement.active[column] = key
        if ((column === 'left' || column === 'right') && folded.has(column)) opened = column
        if (column === 'bottom') arrangement.bottom = { ...arrangement.bottom, open: true }
      }
      shown(key)
      save()
      draw()
    },

    close(instance) {
      const view = viewOf(instance)
      if (!loaded || view === undefined) return
      const key = keyOf(view)
      if (!arrangement.hidden.includes(key)) arrangement.hidden = [...arrangement.hidden, key]
      save()
      draw()
    },
  }
}
