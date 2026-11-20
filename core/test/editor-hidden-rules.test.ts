import { EditorState, type TransactionSpec } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../api/editor.ts'
import { pluginMarks, setMarks } from '../frontend/editor/editor.ts'
import { move, remove, removeGroup, settle } from '../frontend/editor/hidden-rules.ts'

// x **bold** y, then ## Title: the bold markers at 2-4 and 8-10, the heading's marker at 13-16
const bold = 'x **bold** y\n## Title'
const boldMarks: Mark[] = [
  { kind: 'hide', from: 2, to: 4, group: 'b', edge: 'open' },
  { kind: 'mark', from: 4, to: 8, style: 'strong' },
  { kind: 'hide', from: 8, to: 10, group: 'b', edge: 'close' },
  { kind: 'line', from: 13, style: 'h2' },
  { kind: 'hide', from: 13, to: 16 },
]
// **a** b, then a bullet drawn as a widget over "- " at 8-10 before **c**
const list = '**a** b\n- **c**'
const listMarks: Mark[] = [
  { kind: 'hide', from: 0, to: 2, group: 'a', edge: 'open' },
  { kind: 'hide', from: 3, to: 5, group: 'a', edge: 'close' },
  { kind: 'widget', from: 8, to: 10, text: '•' },
  { kind: 'hide', from: 10, to: 12, group: 'c', edge: 'open' },
  { kind: 'hide', from: 13, to: 15, group: 'c', edge: 'close' },
]

function note(text: string, marks: Mark[], anchor = 0, head = anchor): EditorState {
  const state = EditorState.create({ doc: text, extensions: [pluginMarks] })
  return state.update({ effects: setMarks.of({ owner: 'marks', set: 's', marks }), selection: { anchor, head } }).state
}

const sets = (state: EditorState): DecorationSet[] => [state.field(pluginMarks).drawn.hidden]

// The state once the drawer's settling ran, as it does after every update
function settled(state: EditorState): EditorState {
  const selection = settle(state, sets(state))
  return selection === null ? state : state.update({ selection }).state
}

type Command = (state: EditorState, sets: DecorationSet[]) => TransactionSpec | null
function press(state: EditorState, command: Command): EditorState {
  const spec = command(state, sets(state))
  return settled(spec === null ? state : state.update(spec).state)
}

const right: Command = (state, given) => move(state, given, true, false)
const left: Command = (state, given) => move(state, given, false, false)
const shiftRight: Command = (state, given) => move(state, given, true, true)
const backspace: Command = (state, given) => remove(state, given, false)
const del: Command = (state, given) => remove(state, given, true)

const head = (state: EditorState) => state.selection.main.head
const selected = (state: EditorState) => state.sliceDoc(state.selection.main.from, state.selection.main.to)

describe("the caret's rest beside hidden text", () => {
  it('rests before hidden text with visible text to its left, so typing after a bold word stays bold', () => {
    for (const [at, rest] of [[10, 8], [9, 8], [8, 8], [4, 2], [3, 2]]) expect(head(settled(note(bold, boldMarks, at)))).toBe(rest)
  })

  it('rests after hidden text that starts its line, so typing at a heading or a bold first word joins it', () => {
    for (const [at, rest] of [[13, 16], [14, 16]]) expect(head(settled(note(bold, boldMarks, at)))).toBe(rest)
    expect(head(settled(note(list, listMarks, 0)))).toBe(2)
  })

  it("counts a widget as visible text, resting after a bullet and before the item's hidden marker", () => {
    expect(head(settled(note(list, listMarks, 12)))).toBe(10)
    expect(head(settled(note(list, listMarks, 8)))).toBe(10)
  })

  it('leaves a caret in visible text where it is and settles each place once', () => {
    expect(settle(note(bold, boldMarks, 6), sets(note(bold, boldMarks)))).toBe(null)
    for (let at = 0; at <= bold.length; at++) {
      const once = settled(note(bold, boldMarks, at))
      expect(settle(once, sets(once))).toBe(null)
    }
  })

  it('treats a shown element as visible text', () => {
    const state = note(bold, boldMarks.filter(mark => mark.kind !== 'hide' || mark.group !== 'b'), 10)
    expect(settle(state, sets(state))).toBe(null)
  })
})

describe('a selection over hidden text', () => {
  it('takes the markers of an element it holds whole, so a copy gives the markdown', () => {
    expect(selected(settled(note(bold, boldMarks, 0, 10)))).toBe('x **bold**')
    expect(selected(settled(note(bold, boldMarks, 0, 8)))).toBe('x **bold**')
    expect(selected(settled(note(bold, boldMarks, 4, 8)))).toBe('**bold**')
  })

  it("leaves hidden text at its edges that belongs to an element it doesn't hold whole, so a cut takes only what it showed", () => {
    expect(selected(settled(note(bold, boldMarks, 6, 10)))).toBe('ld')
    expect(selected(settled(note(bold, boldMarks, 10, 0)))).toBe('x **bold**')
    expect(selected(settled(note(bold, boldMarks, 21, 13)))).toBe('Title')
  })

  it('keeps hidden text between the visible text it holds', () => {
    expect(selected(settled(note(bold, boldMarks, 1, 21)))).toBe(' **bold** y\n## Title')
  })
})

describe('the arrows', () => {
  it('step over hidden text to the next character the human sees, never staying at one spot', () => {
    let state = note(bold, boldMarks, 0)
    const heads: number[] = []
    for (let i = 0; i < 15; i++) heads.push(head(state = press(state, right)))
    expect(heads).toEqual([1, 2, 5, 6, 7, 8, 11, 12, 16, 17, 18, 19, 20, 21, 21])
    const back: number[] = []
    for (let i = 0; i < 15; i++) back.push(head(state = press(state, left)))
    expect(back).toEqual([20, 19, 18, 17, 16, 12, 11, 8, 7, 6, 5, 2, 1, 0, 0])
  })

  it('step over a widget as one character', () => {
    let state = note(list, listMarks, 7)
    state = press(state, right)
    expect(head(state)).toBe(10)
    expect(head(press(state, right))).toBe(13)
    expect(head(press(state, left))).toBe(7)
  })

  it('extend a selection by what the human sees and collapse one to its end', () => {
    let state = note(bold, boldMarks, 6)
    for (let i = 0; i < 3; i++) state = press(state, shiftRight)
    expect([state.selection.main.anchor, head(state)]).toEqual([6, 11])
    expect(head(press(note(bold, boldMarks, 2, 10), right))).toBe(8)
  })
})

describe('Backspace and Delete', () => {
  it("take the visible character before or after a run's hidden markers, never a marker", () => {
    for (const at of [8, 9, 10]) expect(press(note(bold, boldMarks, at), backspace).doc.toString()).toBe('x **bol** y\n## Title')
    for (const at of [8, 10]) expect(press(note(bold, boldMarks, at), del).doc.toString()).toBe('x **bold**y\n## Title')
    expect(press(note(bold, boldMarks, 2), backspace).doc.toString()).toBe('x**bold** y\n## Title')
    expect(press(note(bold, boldMarks, 4), del).doc.toString()).toBe('x **old** y\n## Title')
  })

  it('take the line break before a heading, never its marker', () => {
    expect(press(note(bold, boldMarks, 16), backspace).doc.toString()).toBe('x **bold** y## Title')
  })

  it('take a widget whole', () => {
    expect(press(note(list, listMarks, 10), backspace).doc.toString()).toBe('**a** b\n**c**')
    expect(press(note(list, listMarks, 7), del).doc.toString()).toBe('**a** b- **c**')
  })

  it('take a selection as far as it holds hidden text', () => {
    expect(press(note(bold, boldMarks, 6, 10), backspace).doc.toString()).toBe('x **bo** y\n## Title')
    expect(press(note(bold, boldMarks, 0, 10), del).doc.toString()).toBe(' y\n## Title')
  })

  it('do nothing at the ends of the note', () => {
    expect(remove(note(bold, boldMarks, 0), sets(note(bold, boldMarks)), false)).toBe(null)
    expect(remove(note(bold, boldMarks, 21), sets(note(bold, boldMarks)), true)).toBe(null)
  })

  it('take a word with Ctrl less any hidden text inside it', () => {
    const word = (at: number, forward: boolean) => press(note(bold, boldMarks, at), (state, given) => removeGroup(state, given, forward)).doc.toString()
    expect(word(8, false)).toBe('x **** y\n## Title')
    expect(word(11, false)).toBe('x **bold**y\n## Title')
    expect(word(2, true)).toBe('x **** y\n## Title')
  })
})
