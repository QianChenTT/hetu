import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../api/editor.ts'
import { pluginMarks, revealClick, setMarks } from '../frontend/editor/editor.ts'

// **bold** at 0-8, its markers at 0-2 and 6-8, ==mark== at 13-21, its markers at 13-15 and 19-21
const text = '**bold** and ==mark== end'

const pair = (group: string, from: number, to: number, width = 2): Mark[] => [
  { kind: 'hide', from, to: from + width, group, edge: 'open' },
  { kind: 'hide', from: to - width, to, group, edge: 'close' },
]

function note(...owners: [string, Mark[]][]): EditorState {
  const state = EditorState.create({ doc: text, extensions: [pluginMarks] })
  return state.update({ effects: owners.map(([owner, marks]) => setMarks.of({ owner, set: 's', marks })) }).state
}

function hidden(state: EditorState): [number, number][] {
  const out: [number, number][] = []
  state.field(pluginMarks).drawn.hidden.between(0, state.doc.length, (from, to) => {
    out.push([from, to])
  })
  return out
}

// An Alt+click at a place in the text, as the drawer applies it, or the state unchanged when the click reveals nothing
function altClick(state: EditorState, pos: number): EditorState {
  const spec = revealClick(state, pos)
  return spec === null ? state : state.update(spec).state
}

const moveTo = (state: EditorState, pos: number) => state.update({ selection: { anchor: pos } }).state

describe('an Alt+click on hidden text', () => {
  it('shows every hidden range of the element under the pointer and puts the cursor there', () => {
    const state = altClick(note(['marks', [...pair('bold', 0, 8), ...pair('high', 13, 21)]]), 4)
    expect(hidden(state)).toEqual([[13, 15], [19, 21]])
    expect(state.selection.main.head).toBe(4)
  })

  it('takes the element from its first hidden range to its last, its edges included', () => {
    expect(hidden(altClick(note(['marks', pair('bold', 0, 8)]), 0))).toEqual([])
    expect(hidden(altClick(note(['marks', pair('bold', 0, 8)]), 8))).toEqual([])
  })

  it('reveals nothing and leaves the click alone outside any element or on a range with no group', () => {
    const state = note(['marks', [...pair('bold', 0, 8), { kind: 'hide', from: 13, to: 15 }]])
    expect(revealClick(state, 10)).toBe(null)
    expect(revealClick(state, 14)).toBe(null)
  })

  it('shows the innermost element when one holds another', () => {
    const state = altClick(note(['marks', [...pair('outer', 0, 21), ...pair('inner', 13, 21, 1)]]), 16)
    expect(hidden(state)).toEqual([[0, 2], [19, 21]])
  })

  it("shows only the clicked plugin's group, never another plugin's group of the same name", () => {
    const state = altClick(note(['alpha', pair('g', 0, 8)], ['beta', pair('g', 13, 21)]), 4)
    expect(hidden(state)).toEqual([[13, 15], [19, 21]])
  })

  it("shows each plugin's own element at a place two plugins hide text in", () => {
    const state = altClick(note(['alpha', pair('a', 0, 8)], ['beta', pair('b', 0, 8, 1)]), 4)
    expect(hidden(state)).toEqual([])
  })
})

describe('a shown element', () => {
  it('stays shown while the cursor moves and types inside it', () => {
    let state = altClick(note(['marks', pair('bold', 0, 8)]), 4)
    state = moveTo(state, 2)
    state = state.update({ changes: { from: 6, insert: 'er' } }).state
    expect(hidden(state)).toEqual([])
  })

  it('is hidden again once the cursor leaves it', () => {
    let state = altClick(note(['marks', [...pair('bold', 0, 8), ...pair('high', 13, 21)]]), 4)
    state = moveTo(state, 10)
    expect(hidden(state)).toEqual([[0, 2], [6, 8], [13, 15], [19, 21]])
    // And stays hidden when the cursor comes back without a click
    expect(hidden(moveTo(state, 4))).toEqual([[0, 2], [6, 8], [13, 15], [19, 21]])
  })

  it('stays shown when its plugin sends the element again and goes once the plugin stops sending it', () => {
    let state = altClick(note(['marks', pair('bold', 0, 8)]), 4)
    state = state.update({ effects: setMarks.of({ owner: 'marks', set: 's', marks: pair('bold', 0, 8) }) }).state
    expect(hidden(state)).toEqual([])
    state = state.update({ effects: setMarks.of({ owner: 'marks', set: 's', marks: [] }) }).state
    state = state.update({ effects: setMarks.of({ owner: 'marks', set: 's', marks: pair('bold', 0, 8) }) }).state
    expect(hidden(state)).toEqual([[0, 2], [6, 8]])
  })
})
