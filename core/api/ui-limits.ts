import { plainProblem } from './measure.ts'

// The caps on what plugins draw and what a view frame sends, with no schema, so the SDK can hold to them without zod in
// its bundle

export const MAX_NODES = 10_000
export const MAX_TREE_DEPTH = 32
export const MAX_NODE_TEXT = 4000
export const MAX_OPS = 100
// Trees one plugin keeps in the drawer: its view instances and, for the layout, its skeleton
export const MAX_SURFACES = 20
export const MAX_PAYLOAD = 4096
export const MAX_CHILDREN_OF_SPLIT = 8
export const MAX_OPTIONS = 200
// A frame's message either way, as plain data
export const MAX_FRAME_MESSAGE = 64 * 1024
export const FRAME_MESSAGES_PER_SECOND = 100

// What one frame sends: JSON text of plain data within the cap, at most so many a second. Anything else is dropped.
// The drawer and the SDK's fake drawer take a frame's messages through it
export class FrameInbox {
  private readonly clock: () => number
  private second = { start: Number.NEGATIVE_INFINITY, count: 0 }

  constructor(clock: () => number) {
    this.clock = clock
  }

  take(message: unknown): { ok: true, data: unknown } | { ok: false } {
    const now = this.clock()
    if (now - this.second.start >= 1000) this.second = { start: now, count: 0 }
    if (this.second.count >= FRAME_MESSAGES_PER_SECOND) return { ok: false }
    this.second.count++
    if (typeof message !== 'string' || message.length > MAX_FRAME_MESSAGE) return { ok: false }
    let data: unknown
    try {
      data = JSON.parse(message)
    } catch {
      return { ok: false }
    }
    return plainProblem(data, MAX_FRAME_MESSAGE) === null ? { ok: true, data } : { ok: false }
  }
}
