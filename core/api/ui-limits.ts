import { plainProblem } from './measure.ts'
import { MAX_SCOPE_LENGTH } from './paths.ts'

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

// At most so many of something a second, counted from the first in each second
class PerSecond {
  private readonly most: number
  private readonly clock: () => number
  private second = { start: Number.NEGATIVE_INFINITY, count: 0 }

  constructor(most: number, clock: () => number) {
    this.most = most
    this.clock = clock
  }

  // true while this one is within the second's count
  take(): boolean {
    const now = this.clock()
    if (now - this.second.start >= 1000) this.second = { start: now, count: 0 }
    if (this.second.count >= this.most) return false
    this.second.count++
    return true
  }
}

// What one frame sends: JSON text of plain data within the cap, at most so many a second. Anything else is dropped.
// The drawer and the SDK's fake drawer take a frame's messages through it
export class FrameInbox {
  private readonly rate: PerSecond

  constructor(clock: () => number) {
    this.rate = new PerSecond(FRAME_MESSAGES_PER_SECOND, clock)
  }

  take(message: unknown): { ok: true, data: unknown } | { ok: false } {
    if (!this.rate.take()) return { ok: false }
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

// What a frame asks of hetu itself rather than of its worker: to open a note as the human's, or a token for dragging a
// note out of it, ask numbering the answer. It comes as an object on the frame's port, so no message to the worker
// reads as one
export type FrameAsk = { kind: 'open', path: string } | { kind: 'drag-token', ask: number, path: string }
export const FRAME_ASKS_PER_SECOND = 200

// What one frame asks, ok false past so many a second. Anything that is no ask is null
export type FrameAsks = (message: unknown) => { ask: FrameAsk, ok: boolean } | null

export function frameAsks(clock: () => number): FrameAsks {
  const rate = new PerSecond(FRAME_ASKS_PER_SECOND, clock)
  return message => {
    const ask = askOf(message)
    return ask === null ? null : { ask, ok: rate.take() }
  }
}

function askOf(message: unknown): FrameAsk | null {
  if (typeof message !== 'object' || message === null) return null
  const { v, kind, path, ask } = message as Record<string, unknown>
  if (v !== 1 || typeof path !== 'string' || path === '' || path.length > MAX_SCOPE_LENGTH) return null
  if (kind === 'open') return { kind, path }
  if (kind === 'drag-token' && typeof ask === 'number' && Number.isSafeInteger(ask) && ask >= 0) return { kind, ask, path }
  return null
}

// How long after the human pressed in a plugin's frame, or let go of that press, an open from its frames is the human's
export const OPEN_GRACE_MS = 500

// Which plugin's frames may open one note as the human's: the plugin whose frame the human last pressed in, or pressed
// Enter or Space in, for one open within OPEN_GRACE_MS. A press anywhere else ends it. Letting go of a press not yet
// used counts again from then, so a long press opens once
export class OpenCredit {
  private readonly clock: () => number
  private credit: { owner: string, at: number, used: boolean } | null = null

  constructor(clock: () => number) {
    this.clock = clock
  }

  // A press in a frame of owner's, or anywhere else with null
  pressed(owner: string | null): void {
    this.credit = owner === null ? null : { owner, at: this.clock(), used: false }
  }

  released(owner: string | null): void {
    if (this.credit !== null && this.credit.owner === owner && !this.credit.used) this.credit.at = this.clock()
  }

  keyed(owner: string): void {
    this.pressed(owner)
  }

  // An open from owner's frames: true once when it is the human's
  use(owner: string): boolean {
    const credit = this.credit
    if (credit === null || credit.owner !== owner || credit.used || this.clock() - credit.at > OPEN_GRACE_MS) return false
    credit.used = true
    return true
  }
}

// How long a token for dragging a note out of a frame waits for its drop
export const DRAG_TOKEN_MS = 30 * 60 * 1000
// What a frame puts as text/plain in a drag of a note, the token after it
export const DRAG_PREFIX = 'hetu-drag:'

// The token in a drag's text, null for any other text
export function dragTokenOf(text: string): string | null {
  const token = text.startsWith(DRAG_PREFIX) ? text.slice(DRAG_PREFIX.length) : ''
  return /^[0-9a-f]{32}$/.test(token) ? token : null
}
