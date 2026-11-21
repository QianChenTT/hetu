import { deleteGroupBackward, deleteGroupForward } from '@codemirror/commands'
import {
  EditorSelection, type EditorState, type Extension, Facet, findClusterBreak, Prec, StateEffect, StateField, type TransactionSpec,
} from '@codemirror/state'
import { type DecorationSet, type EditorView, type KeyBinding, keymap, ViewPlugin } from '@codemirror/view'

// The drawer's rules for text a plugin hid, the same for every plugin: the caret never rests inside it, arrows step over
// it to the next character the human sees, the keys that delete take only characters the human sees, Enter never splits
// an element from its markers and a selection takes hidden text at its edges only with the whole element it belongs to.
// A widget is one character the human sees. Nothing here runs during an IME composition

// The hidden ranges and widgets of each source, as the drawer draws them
export const hiddenText = Facet.define<(view: EditorView) => DecorationSet>()

type Sets = readonly DecorationSet[]
type Piece = { from: number, to: number, widget: boolean, group: string | undefined, edge: string | undefined }

function near(sets: Sets, from: number, to: number): Piece[] {
  const out: Piece[] = []
  for (const set of sets) {
    set.between(from, to, (start, end, value) => {
      out.push({ from: start, to: end, widget: value.spec.widget !== undefined, group: value.spec.group as string | undefined, edge: value.spec.edge as string | undefined })
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
// the spots the selection reaches to. A hidden range with no group belongs to its whole line
function trim(state: EditorState, sets: Sets, from: number, to: number): { from: number, to: number } {
  const start = spotAt(sets, from)
  const end = spotAt(sets, to)
  const held = (piece: Piece) => {
    if (piece.widget) return false
    const hull = piece.group === undefined ? { from: state.doc.lineAt(piece.from).from, to: state.doc.lineAt(piece.to).to } : hullOf(state, sets, piece.group)
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

// Where a plugin's edit placed the caret in answer to the human's key, kept until the human types or moves
export const placeCaret = StateEffect.define<number>()
const placed = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(placeCaret)) return effect.value
    return tr.docChanged || tr.selection !== undefined ? null : value
  },
})

// The selection the rules allow in place of the one there, or null when it already holds. A caret placed just after a
// closing marker stays, so typing there goes past the run
export function settle(state: EditorState, sets: Sets): EditorSelection | null {
  const range = state.selection.main
  const kept = state.field(placed, false)
  if (range.empty && kept === range.head && near(sets, kept, kept).some(piece => piece.to === kept && piece.edge === 'close')) return null
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
    const line = state.doc.lineAt(spot.from)
    if (line.length > 0 && spot.from === line.from && spot.to === line.to) {
      // A line hidden whole, such as a rule, goes whole with one line break
      const after = forward ? line.to < state.doc.length : line.from === 0
      span = after ? { from: line.from, to: Math.min(line.to + 1, state.doc.length) } : { from: line.from - 1, to: line.to }
    } else {
      const at = forward ? spot.to : spot.from
      const other = charFrom(state, sets, at, forward)
      span = { from: Math.min(at, other), to: Math.max(at, other) }
    }
  }
  if (span.from >= span.to) return null
  return { changes: span, selection: { anchor: span.from }, scrollIntoView: true, userEvent: forward ? 'delete.forward' : 'delete.backward' }
}

// Enter: the caret moved to where the line breaks without splitting an element from its hidden markers, after those
// that close and before those that open, before them all when they start the line. A marker with no edge opens when it
// follows a space. CodeMirror's own Enter then breaks the line there
export function beforeBreak(state: EditorState, sets: Sets): TransactionSpec | null {
  const range = state.selection.main
  const spot = spotAt(sets, range.head)
  if (!range.empty || spot.from === spot.to) return null
  const line = state.doc.lineAt(spot.from)
  let at = spot.from
  if (line.from !== at) {
    const opens = (piece: Piece) => piece.edge === 'open' || (piece.edge === undefined && piece.from === spot.from && /\s/.test(state.sliceDoc(at - 1, at)))
    for (;;) {
      const piece = near(sets, at, at).find(one => !one.widget && one.from === at && one.to > at)
      if (piece === undefined || opens(piece)) break
      at = piece.to
    }
  }
  return at === range.head ? null : { selection: { anchor: at } }
}

// A word or the rest of the line: CodeMirror's word or the line's start or end from the spot's edge, the line break
// when the spot is at it, less any hidden text inside
export function removeTo(state: EditorState, sets: Sets, forward: boolean, reach: 'word' | 'line'): TransactionSpec | null {
  if (!state.selection.main.empty) return remove(state, sets, forward)
  const spot = spotAt(sets, state.selection.main.head)
  const at = forward ? spot.to : spot.from
  const spans: { from: number, to: number }[] = []
  if (reach === 'word') {
    ;(forward ? deleteGroupForward : deleteGroupBackward)({
      state: state.update({ selection: { anchor: at } }).state,
      dispatch: tr => tr.changes.iterChangedRanges((from, to) => {
        spans.push({ from, to })
      }),
    })
  } else {
    const line = state.doc.lineAt(at)
    const other = forward ? (at === line.to ? Math.min(at + 1, state.doc.length) : line.to) : (at === line.from ? Math.max(at - 1, 0) : line.from)
    spans.push({ from: Math.min(at, other), to: Math.max(at, other) })
  }
  const changes: { from: number, to: number }[] = []
  for (const { from, to } of spans) {
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

const setsOf = (view: EditorView): Sets => view.state.facet(hiddenText).map(read => read(view))

// A rule on a key, never during an IME composition. The key is taken even when the rule changes nothing, so no command
// of CodeMirror's takes hidden text in its place
function bound(rule: (state: EditorState, sets: Sets) => TransactionSpec | null): (view: EditorView) => boolean {
  return view => {
    if (view.composing) return false
    const spec = rule(view.state, setsOf(view))
    if (spec !== null) view.dispatch(spec)
    return true
  }
}

// The caret and the selection settled after each update, once it is done, so a click, a vertical move or a plugin's new
// marks never leave the caret inside hidden text
const settler = ViewPlugin.define(view => {
  let queued = false
  let gone = false
  return {
    update() {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (gone || view.composing) return
        const selection = settle(view.state, setsOf(view))
        if (selection !== null) view.dispatch({ selection, userEvent: 'select' })
      })
    },
    destroy() {
      gone = true
    },
  }
})

// Enter moves the caret and lets the next binding, markdown's or CodeMirror's, break the line where it now is
function breakHere(view: EditorView): boolean {
  if (view.composing) return false
  const spec = beforeBreak(view.state, setsOf(view))
  if (spec !== null) view.dispatch(spec)
  return false
}

// The Mac's Ctrl+T swaps the characters either side of the caret, so the key is taken, doing nothing, when one is hidden
function swapHere(view: EditorView): boolean {
  const head = view.state.selection.main.head
  return !view.composing && near(setsOf(view), Math.max(head - 1, 0), head + 1).some(piece => piece.from < head + 1 && piece.to > head - 1)
}

const char = (forward: boolean) => bound((state, sets) => remove(state, sets, forward))
const word = (forward: boolean) => bound((state, sets) => removeTo(state, sets, forward, 'word'))
const line = (forward: boolean) => bound((state, sets) => removeTo(state, sets, forward, 'line'))

// Every key CodeMirror moves by a character or deletes with, on the PC and on the Mac
export const hiddenKeys: readonly KeyBinding[] = [
  { key: 'ArrowLeft', run: bound((state, sets) => move(state, sets, false, false)), shift: bound((state, sets) => move(state, sets, false, true)) },
  { key: 'ArrowRight', run: bound((state, sets) => move(state, sets, true, false)), shift: bound((state, sets) => move(state, sets, true, true)) },
  { key: 'Backspace', run: char(false), shift: char(false) },
  { key: 'Delete', run: char(true) },
  { key: 'Mod-Backspace', mac: 'Alt-Backspace', run: word(false) },
  { key: 'Mod-Delete', mac: 'Alt-Delete', run: word(true) },
  { mac: 'Mod-Backspace', run: line(false) },
  { mac: 'Mod-Delete', run: line(true) },
  { mac: 'Ctrl-h', run: char(false) },
  { mac: 'Ctrl-d', run: char(true) },
  { mac: 'Ctrl-k', run: line(true) },
  { mac: 'Ctrl-Alt-h', run: word(false) },
  { mac: 'Ctrl-t', run: swapHere },
]

export const hiddenRules: Extension = [
  placed,
  Prec.highest(keymap.of([{ key: 'Enter', run: breakHere, shift: breakHere }, { mac: 'Ctrl-o', run: breakHere }])),
  Prec.high(keymap.of(hiddenKeys)),
  settler,
]
