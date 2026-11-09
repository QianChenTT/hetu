import { Text } from '@codemirror/state'
import type { Decoration, DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../api/editor.ts'
import { drawMarks } from '../frontend/mount/marks.ts'

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

  it('leaves out what reaches past the end of the text', () => {
    const { marks, hidden } = drawMarks([
      { kind: 'hide', from: 20, to: 40 },
      { kind: 'mark', from: 0, to: 99, style: 'em' },
      { kind: 'line', from: 99, style: 'h1' },
    ], doc)
    expect(ranges(hidden)).toEqual([])
    expect(ranges(marks)).toEqual([])
  })
})
