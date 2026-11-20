import { deleteGroupBackward, deleteGroupForward } from '@codemirror/commands'
import { EditorSelection, type EditorState, findClusterBreak, type TransactionSpec } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'

// The drawer's rules for text a plugin hid, the same for every plugin: the caret never rests inside it, arrows step over
// it to the next character the human sees, Backspace and Delete take only characters the human sees and a selection
// takes hidden text at its edges only with the whole element it belongs to. A widget is one character the human sees.
// Nothing here runs during an IME composition

type Sets = readonly DecorationSet[]
type Piece = { from: number, to: number, widget: boolean, group: string | undefined }

function near(sets: Sets, from: number, to: number): Piece[] {
  const out: Piece[] = []
  for (const set of sets) {
    set.between(from, to, (start, end, value) => {
      out.push({ from: start, to: end, widget: value.spec.widget !== undefined, group: value.spec.group as string | undefined })
    })
  }
  return out
}

// The stretch of hidden text pos touches, or pos alone. Every place in it draws at one spot on screen
function spotAt(sets: Sets, pos: number): { from: number, to: number } {
  let from = pos
  let to = pos
  for (let moved = true; moved;) {
    moved = false
    for (const piece of near(sets, from, to)) {
      if (piece.widget) continue
      if (piece.from < from) [from, moved] = [piece.from, true]
      if (piece.to > to) [to, moved] = [piece.to, true]
    }
  }
  return { from, to }
}

// Where the caret rests in a spot: before the hidden text, so typing joins the visible text to its left, or after it
// and a widget opening the line when the spot starts its line, so typing at a heading's or an item's start stays in it.
// Chromium puts typed text there too
function restAt(state: EditorState, sets: Sets, pos: number): number {
  const spot = spotAt(sets, pos)
  if (state.doc.lineAt(spot.from).from !== spot.from) return spot.from
  const widget = near(sets, spot.to, spot.to).find(piece => piece.widget && piece.from === spot.to && piece.to > piece.from)
  return widget === undefined ? spot.to : widget.to
}

// The place one character on from pos, a line break or a widget counting as one
function charFrom(state: EditorState, sets: Sets, pos: number, forward: boolean): number {
  const widget = near(sets, pos, pos).find(piece => piece.widget && (forward ? piece.from === pos : piece.to === pos) && piece.to > piece.from)
  if (widget !== undefined) return forward ? widget.to : widget.from
  const line = state.doc.lineAt(pos)
  if (pos === (forward ? line.to : line.from)) return Math.min(Math.max(pos + (forward ? 1 : -1), 0), state.doc.length)
  return findClusterBreak(line.text, pos - line.from, forward) + line.from
}

// The span of a group's hidden ranges, over every source
function hullOf(state: EditorState, sets: Sets, group: string): { from: number, to: number } {
  let hull = { from: Infinity, to: -Infinity }
  for (const piece of near(sets, 0, state.doc.length)) {
    if (piece.group === group) hull = { from: Math.min(hull.from, piece.from), to: Math.max(hull.to, piece.to) }
  }
  return hull
}

// A selection's ends moved in past the hidden text at its edges, but for hidden ranges whose whole element lies within
// the spots the selection reaches to
function trim(state: EditorState, sets: Sets, from: number, to: number): { from: number, to: number } {
  const start = spotAt(sets, from)
  const end = spotAt(sets, to)
  const held = (piece: Piece) => {
    if (piece.widget || piece.group === undefined) return false
    const hull = hullOf(state, sets, piece.group)
    return hull.from >= start.from && hull.to <= end.to
  }
  let inFrom = start.to
  for (;;) {
    const piece = near(sets, inFrom, inFrom).find(one => one.to === inFrom && one.from >= start.from && held(one))
    if (piece === undefined) break
    inFrom = piece.from
  }
  let inTo = end.from
  for (;;) {
    const piece = near(sets, inTo, inTo).find(one => one.from === inTo && one.to <= end.to && held(one))
    if (piece === undefined) break
    inTo = piece.to
  }
  return { from: inFrom, to: inTo }
}

// The selection the rules allow in place of the one there, or null when it already holds
export function settle(state: EditorState, sets: Sets): EditorSelection | null {
  const range = state.selection.main
  let next = EditorSelection.cursor(restAt(state, sets, range.head))
  if (!range.empty) {
    const { from, to } = trim(state, sets, range.from, range.to)
    if (from < to) next = range.head > range.anchor ? EditorSelection.range(from, to) : EditorSelection.range(to, from)
    else next = EditorSelection.cursor(restAt(state, sets, range.from))
  }
  return next.anchor === range.anchor && next.head === range.head ? null : EditorSelection.create([next])
}

// An arrow: on to the next character the human sees, or the selection's end when one is collapsed
export function move(state: EditorState, sets: Sets, forward: boolean, extend: boolean): TransactionSpec {
  const range = state.selection.main
  let head = range.head
  if (!extend && !range.empty) head = restAt(state, sets, forward ? range.to : range.from)
  else {
    // On until the caret's spot on screen changes, past a place it can't rest at
    const was = restAt(state, sets, range.head)
    let at = range.head
    do {
      const spot = spotAt(sets, at)
      const next = charFrom(state, sets, forward ? spot.to : spot.from, forward)
      if (next === at) break
      at = next
      head = restAt(state, sets, at)
    } while (head === was)
  }
  return { selection: extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head), scrollIntoView: true, userEvent: 'select' }
}

// Backspace or Delete: the character the human sees next to the caret, a widget whole, or the selection as trim allows
export function remove(state: EditorState, sets: Sets, forward: boolean): TransactionSpec | null {
  const range = state.selection.main
  let span = range.empty ? null : trim(state, sets, range.from, range.to)
  if (span === null) {
    const spot = spotAt(sets, range.head)
    const at = forward ? spot.to : spot.from
    const other = charFrom(state, sets, at, forward)
    span = { from: Math.min(at, other), to: Math.max(at, other) }
  }
  if (span.from >= span.to) return null
  return { changes: span, selection: { anchor: span.from }, scrollIntoView: true, userEvent: forward ? 'delete.forward' : 'delete.backward' }
}

// Ctrl+Backspace or Ctrl+Delete: CodeMirror's word from the spot's edge, less any hidden text inside it
export function removeGroup(state: EditorState, sets: Sets, forward: boolean): TransactionSpec | null {
  if (!state.selection.main.empty) return remove(state, sets, forward)
  const spot = spotAt(sets, state.selection.main.head)
  const words: { from: number, to: number }[] = []
  ;(forward ? deleteGroupForward : deleteGroupBackward)({
    state: state.update({ selection: { anchor: forward ? spot.to : spot.from } }).state,
    dispatch: tr => tr.changes.iterChangedRanges((from, to) => {
      words.push({ from, to })
    }),
  })
  const changes: { from: number, to: number }[] = []
  for (const { from, to } of words) {
    let at = from
    for (const piece of near(sets, from, to).filter(one => !one.widget).sort((a, b) => a.from - b.from)) {
      if (piece.from > at) changes.push({ from: at, to: Math.min(piece.from, to) })
      at = Math.max(at, piece.to)
    }
    if (at < to) changes.push({ from: at, to })
  }
  if (changes.length === 0) return null
  return { changes, scrollIntoView: true, userEvent: forward ? 'delete.forward' : 'delete.backward' }
}
