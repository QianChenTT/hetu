import { MAX_PAYLOAD, type Payload, type PayloadType } from '../../api/ui.ts'

// The drawer runs every drag itself on pointer events, so no mouse move waits for a worker: a view's title onto one of
// the layout's zones, a node's payload onto a node that accepts it and a split's divider. Only what the drop or the
// release settles goes to a plugin. These are the parts with no DOM, which the page drives

export type Rect = { left: number, top: number, width: number, height: number }

// Travel past which a press becomes a drag
export const DRAG_THRESHOLD = 4

// The topmost zone holding the point. Later zones are drawn over earlier ones
export function zoneAt<Z extends { rect: Rect }>(zones: readonly Z[], x: number, y: number): Z | null {
  for (let at = zones.length - 1; at >= 0; at--) {
    const zone = zones[at] as Z
    const { left, top, width, height } = zone.rect
    if (x >= left && x < left + width && y >= top && y < top + height) return zone
  }
  return null
}

// Where in the rect the point is, from 0 to 1 each way
export function fraction(rect: Rect, x: number, y: number): { x: number, y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  return {
    x: rect.width > 0 ? clamp((x - rect.left) / rect.width) : 0,
    y: rect.height > 0 ? clamp((y - rect.top) / rect.height) : 0,
  }
}

// Whether a node that accepts these types takes the payload. A note's path or text within the cap
export function accepts(types: readonly PayloadType[] | undefined, payload: Payload): boolean {
  return (types ?? []).includes(payload.type) && payload.value.length > 0 && payload.value.length <= MAX_PAYLOAD
}

// The sizes after the divider after child index moved by delta, the two children beside it held to their minimums and
// the total kept
export function splitSizes(sizes: readonly number[], min: readonly number[] | undefined, index: number, delta: number): number[] {
  const next = [...sizes]
  const before = next[index] ?? 0
  const after = next[index + 1] ?? 0
  const low = -(before - (min?.[index] ?? 0))
  const high = after - (min?.[index + 1] ?? 0)
  const moved = Math.min(high, Math.max(low, delta))
  next[index] = before + moved
  next[index + 1] = after - moved
  return next
}

// A press that becomes a drag once it travelled past the threshold. A press released before then is a click
export class DragGesture {
  private readonly x: number
  private readonly y: number
  private dragging = false

  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }

  move(x: number, y: number): 'pending' | 'dragging' {
    if (!this.dragging && Math.hypot(x - this.x, y - this.y) > DRAG_THRESHOLD) this.dragging = true
    return this.dragging ? 'dragging' : 'pending'
  }

  end(): 'drop' | 'click' {
    return this.dragging ? 'drop' : 'click'
  }
}
