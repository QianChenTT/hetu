import { EditorState, Text } from '@codemirror/state'
import type { Decoration, DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../api/editor.ts'
import { pluginMarks, setMarks } from '../frontend/editor/editor.ts'
import { drawMarks } from '../frontend/editor/marks.ts'

const doc = Text.of(['first line', 'second line'])

function ranges(set: DecorationSet): { from: number, to: number, spec: Decoration['spec'] }[] {
  const out: { from: number, to: number, spec: Decoration['spec'] }[] = []
  set.between(0, doc.length, (from, to, value) => {
    out.push({ from, to, spec: value.spec })
  })
  return out
}

describe('drawing marks', () => {
  it("draws a style with the drawer's own class and nothing a plugin wrote", () => {
    const { marks } = drawMarks([{ kind: 'mark', from: 0, to: 5, style: 'strong' }], doc)
    expect(ranges(marks)).toEqual([{ from: 0, to: 5, spec: { class: 'cm-hetu-strong' } }])
  })

  it('puts a line style at the start of the line it names', () => {
    const { marks } = drawMarks([{ kind: 'line', from: 15, style: 'h2' }], doc)
    expect(ranges(marks)).toEqual([{ from: 11, to: 11, spec: { class: 'cm-hetu-line-h2' } }])
  })

  it('puts hidden ranges and widgets in the set the cursor jumps over, in order', () => {
    const given: Mark[] = [
      { kind: 'widget', from: 11, to: 12, text: '•' },
      { kind: 'hide', from: 0, to: 2 },
      { kind: 'mark', from: 3, to: 5, style: 'em' },
    ]
    const { marks, hidden } = drawMarks(given, doc)
    const drawn = ranges(hidden)
    expect(drawn.map(r => [r.from, r.to])).toEqual([[0, 2], [11, 12]])
    expect((drawn[1].spec.widget as { text: string }).text).toBe('•')
    expect(ranges(marks).map(r => [r.from, r.to])).toEqual([[3, 5]])
  })

  it("carries a hidden range's group and edge to its decoration and nothing for a range without them", () => {
    const { hidden } = drawMarks([
      { kind: 'hide', from: 0, to: 2, group: 'bold0', edge: 'open' },
      { kind: 'hide', from: 5, to: 7, group: 'bold0', edge: 'close' },
      { kind: 'hide', from: 8, to: 9 },
    ], doc)
    expect(ranges(hidden).map(r => r.spec)).toEqual([
      { class: 'cm-hetu-hidden', group: 'bold0', edge: 'open' },
      { class: 'cm-hetu-hidden', group: 'bold0', edge: 'close' },
      { class: 'cm-hetu-hidden' },
    ])
  })

  // Text hidden with a style stays in the page, so an IME composing beside it reads the text right. A style can't take
  // a line break away, so a range over one is replaced
  it('hides a range within a line with a style and replaces one over a line break', () => {
    const { hidden } = drawMarks([{ kind: 'hide', from: 0, to: 10 }, { kind: 'hide', from: 8, to: 13, group: 'fence0' }], doc)
    const [inline, across] = ranges(hidden)
    expect(inline.spec).toEqual({ class: 'cm-hetu-hidden' })
    expect(across.spec).toEqual({ group: 'fence0' })
    // A replaced range is a point to CodeMirror, a styled one is not
    const points: boolean[] = []
    hidden.between(0, doc.length, (_from, _to, value) => {
      points.push(value.point)
    })
    expect(points).toEqual([false, true])
  })

  it('leaves out what reaches past the end of the text', () => {
    const { marks, hidden } = drawMarks([
      { kind: 'hide', from: 20, to: 40 },
      { kind: 'mark', from: 0, to: 99, style: 'em' },
      { kind: 'line', from: 99, style: 'h1' },
    ], doc)
    expect(ranges(hidden)).toEqual([])
    expect(ranges(marks)).toEqual([])
  })

  // A widget at a callout's line start once threw out the plugin's whole set: CodeMirror refuses a replacement over an
  // empty range
  it("draws a widget at a point at the note's start, a line's start, mid-line and the note's end with the rest of the set", () => {
    const given: Mark[] = [
      { kind: 'widget', from: 0, to: 0, text: 'a' },
      { kind: 'widget', from: 11, to: 11, text: 'b' },
      { kind: 'widget', from: 3, to: 3, text: 'c' },
      { kind: 'widget', from: doc.length, to: doc.length, text: 'd' },
      { kind: 'hide', from: 11, to: 13 },
      { kind: 'mark', from: 3, to: 5, style: 'em' },
      { kind: 'line', from: 11, style: 'quote' },
    ]
    const state = EditorState.create({ doc: doc.toString(), extensions: [pluginMarks] })
    const { drawn } = state.update({ effects: setMarks.of({ owner: 'marks', set: 's', marks: given }) }).state.field(pluginMarks)
    const hidden = ranges(drawn.hidden)
    expect(hidden.map(r => [r.from, r.to, (r.spec.widget as { text: string } | undefined)?.text])).toEqual([
      [0, 0, 'a'], [3, 3, 'c'], [11, 11, 'b'], [11, 13, undefined], [doc.length, doc.length, 'd'],
    ])
    expect(ranges(drawn.marks).map(r => [r.from, r.to])).toEqual([[3, 5], [11, 11]])
  })

  // Typed text lands after a widget at its place, as the versions map it, so the caret there is drawn after it too
  it('draws a widget at a point before a caret at its place and one over a range in place of it', () => {
    const { hidden } = drawMarks([{ kind: 'widget', from: 3, to: 3, text: '•' }, { kind: 'widget', from: 5, to: 7, text: '—' }], doc)
    // A side below 0 draws a point before a caret at the same place
    const drawn: [number, number, boolean][] = []
    hidden.between(0, doc.length, (from, to, value) => {
      drawn.push([from, to, value.startSide < 0])
    })
    expect(drawn).toEqual([[3, 3, true], [5, 7, false]])
  })

  it('leaves out a mark CodeMirror refuses alone and draws the rest', () => {
    const given = [
      { kind: 'mark', from: 4, to: 4, style: 'em' },
      { kind: 'mark', from: 0, to: 5, style: 'strong' },
      { kind: 'hide', from: 7, to: 6 },
      { kind: 'widget', from: 11, to: 12, text: '•' },
    ] as Mark[]
    const { marks, hidden } = drawMarks(given, doc)
    expect(ranges(marks).map(r => [r.from, r.to])).toEqual([[0, 5]])
    expect(ranges(hidden).map(r => [r.from, r.to])).toEqual([[11, 12]])
  })
})
