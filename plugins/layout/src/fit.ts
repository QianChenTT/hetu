import type { LayoutView } from '@hetu/sdk'

// Folding in hetu's own layout. Sizes are CSS, so Chromium resolves them as the window changes. When the minimums don't
// fit, the lowest-ranked side column folds to a rail first, greedily, so the human can predict what goes: an optimal
// packing could fold a view the human uses a lot to fit two small ones. A folded side unfolds only a margin past the
// width it needs, so a window near the edge doesn't flicker

export type Side = 'left' | 'right'

export const MAIN_MIN = 320
export const SIDE_MIN = 160
export const SIDE_DEFAULT = 240
export const RAIL = 36
export const UNFOLD_MARGIN = 48
// A plugin's declared minimum counts at most this share of the window, or every plugin would claim a large one
export const HINT_SHARE = 0.4
export const ITEM_MIN = 80
export const MORE_BUTTON = 40

// What a side needs open: its views' largest minimum, each held to the share of the window
export function sideMin(views: readonly LayoutView[], width: number): number {
  let need = 0
  for (const view of views) need = Math.max(need, Math.min(view.size.min ?? SIDE_MIN, HINT_SHARE * width))
  return Math.round(need)
}

// The sides that fold. rank is the side's best view's place in the ranking, lower first
export function fit(input: { width: number, sides: readonly { side: Side, min: number, rank: number }[], folded: ReadonlySet<Side> }): Set<Side> {
  const { width, sides } = input
  const need = (open: readonly { side: Side, min: number }[]) =>
    MAIN_MIN + open.reduce((sum, each) => sum + each.min, 0) + RAIL * (sides.length - open.length)
  const byRank = [...sides].sort((a, b) => a.rank - b.rank)
  const open = byRank.filter(each => !input.folded.has(each.side))
  for (const each of byRank.filter(side => input.folded.has(side.side))) {
    if (need([...open, each]) + UNFOLD_MARGIN <= width) open.push(each)
  }
  open.sort((a, b) => a.rank - b.rank)
  while (open.length > 0 && need(open) > width) open.pop()
  return new Set(sides.filter(each => !open.includes(each)).map(each => each.side))
}

// The items the status row shows in rank order, the rest folded behind a +n button it keeps room for
export function fitItems(items: readonly { key: string, min: number }[], width: number): { shown: string[], folded: string[] } {
  const total = items.reduce((sum, item) => sum + item.min, 0)
  if (total <= width) return { shown: items.map(item => item.key), folded: [] }
  const shown: string[] = []
  let used = 0
  for (const item of items) {
    if (used + item.min > width - MORE_BUTTON) break
    used += item.min
    shown.push(item.key)
  }
  return { shown, folded: items.slice(shown.length).map(item => item.key) }
}
