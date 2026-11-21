import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { type Format, formatKeys, toggle } from '../src/format.ts'
import { markdownSupport } from '../src/marks.ts'

// The text after the format's key at the selection from anchor to head, or null when the key changes nothing
function pressed(text: string, format: Format, anchor: number, head = anchor): string | null {
  const state = EditorState.create({ doc: text, extensions: [markdownSupport()] })
  const changes = toggle(state, format, { anchor, head })
  return changes === null ? null : changes.apply(state.doc).toString()
}

describe('a format key on a selection', () => {
  it("wraps it in the format's markers, spaces at its ends left outside", () => {
    expect(pressed('a word here', 'bold', 2, 6)).toBe('a **word** here')
    expect(pressed('a word here', 'bold', 7, 1)).toBe('a **word** here')
  })

  it('unwraps a run it holds whole, with its markers or without them', () => {
    expect(pressed('a **word** here', 'bold', 4, 8)).toBe('a word here')
    expect(pressed('a **word** here', 'bold', 2, 10)).toBe('a word here')
  })

  it('turns off only the part of a run it holds, splitting the run', () => {
    expect(pressed('**abcdef**', 'bold', 4, 6)).toBe('**ab**cd**ef**')
    expect(pressed('**abcdef**', 'bold', 2, 4)).toBe('ab**cdef**')
    expect(pressed('**abcdef**', 'bold', 6, 8)).toBe('**abcd**ef')
  })

  it('joins the runs it crosses and the text between them into one run', () => {
    expect(pressed('**ab** x **cd**', 'bold', 3, 12)).toBe('**ab x cd**')
    expect(pressed('**ab** cd', 'bold', 3, 9)).toBe('**ab cd**')
  })

  it('does nothing across lines', () => {
    expect(pressed('ab\ncd', 'bold', 1, 4)).toBe(null)
  })

  it("puts each format's own markers and takes them off again, a run's own markers kept", () => {
    const markers: [Format, string][] = [['bold', '**x**'], ['italic', '*x*'], ['strike', '~~x~~'], ['code', '`x`'], ['highlight', '==x==']]
    for (const [format, made] of markers) {
      expect(pressed('x', format, 0, 1)).toBe(made)
      expect(pressed(made, format, 0, made.length)).toBe('x')
    }
    expect(pressed('_ab_', 'italic', 1, 3)).toBe('ab')
    expect(pressed('_abc_', 'italic', 1, 2)).toBe('a_bc_')
  })
})

describe('a format key at the cursor', () => {
  it('turns off the run the cursor is inside, at its ends too', () => {
    expect(pressed('a **word** here', 'bold', 5)).toBe('a word here')
    expect(pressed('a **word** here', 'bold', 8)).toBe('a word here')
    expect(pressed('a **word** here', 'bold', 4)).toBe('a word here')
  })

  it('wraps the word the cursor is inside', () => {
    expect(pressed('a word here', 'bold', 4)).toBe('a **word** here')
  })

  it('does nothing at the edge of a word or between words', () => {
    expect(pressed('a word here', 'bold', 6)).toBe(null)
    expect(pressed('a  b', 'bold', 2)).toBe(null)
  })

  it('takes only the run of its own format', () => {
    expect(pressed('a *word* here', 'bold', 5)).toBe('a ***word*** here')
  })
})

describe('the format keys', () => {
  it('are the keys Docs and Notion use, none the editor or the core takes', () => {
    expect(formatKeys).toEqual({ bold: 'Mod-b', italic: 'Mod-i', strike: 'Mod-Shift-s', code: 'Mod-e', highlight: 'Mod-Shift-h' })
  })
})
