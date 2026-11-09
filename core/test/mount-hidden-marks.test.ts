import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../api/editor.ts'
import { hiddenMarks, markdownSupport } from '../frontend/mount/hidden-marks.ts'

function marksOf(text: string): Mark[] {
  const state = EditorState.create({ doc: text, extensions: [markdownSupport()] })
  const marks = hiddenMarks(state, [{ from: 0, to: state.doc.length }])
  expect(state.doc.toString()).toBe(text)
  return marks
}

const sorted = (marks: Mark[]) => [...marks].sort((a, b) => a.from - b.from || a.kind.localeCompare(b.kind))

describe('hidden marks', () => {
  it('makes bold text strong and hides its markers', () => {
    expect(sorted(marksOf('**bold**'))).toEqual([
      { kind: 'hide', from: 0, to: 2 },
      { kind: 'mark', from: 0, to: 8, style: 'strong' },
      { kind: 'hide', from: 6, to: 8 },
    ])
  })

  it('styles a heading line and hides its marker with the space after it', () => {
    expect(sorted(marksOf('# Title'))).toEqual([
      { kind: 'hide', from: 0, to: 2 },
      { kind: 'line', from: 0, style: 'h1' },
    ])
  })

  it('draws a bullet in place of a list marker', () => {
    expect(marksOf('- item')).toEqual([{ kind: 'widget', from: 0, to: 1, text: '•' }])
  })

  it('draws a rule as a line style and hides its dashes', () => {
    expect(sorted(marksOf('---'))).toEqual([
      { kind: 'hide', from: 0, to: 3 },
      { kind: 'line', from: 0, style: 'rule' },
    ])
  })

  it('highlights ==text== and hides its markers', () => {
    expect(sorted(marksOf('==hi=='))).toEqual([
      { kind: 'hide', from: 0, to: 2 },
      { kind: 'mark', from: 0, to: 6, style: 'highlight' },
      { kind: 'hide', from: 4, to: 6 },
    ])
  })

  it('leaves a single = as text', () => {
    expect(marksOf('a = b')).toEqual([])
  })

  it('hides only the backslash of an escape', () => {
    expect(marksOf('\\*x')).toEqual([{ kind: 'hide', from: 0, to: 1 }])
  })

  it('hides a quote marker and styles the line', () => {
    expect(sorted(marksOf('> said'))).toEqual([
      { kind: 'hide', from: 0, to: 2 },
      { kind: 'line', from: 0, style: 'quote' },
    ])
  })

  it('styles each line of a fenced block and hides the fences', () => {
    const marks = marksOf('```\ncode\n```')
    expect(marks.filter(m => m.kind === 'line').map(m => m.from)).toEqual([0, 4, 9])
    expect(marks.filter(m => m.kind === 'hide')).toEqual([{ kind: 'hide', from: 0, to: 3 }, { kind: 'hide', from: 9, to: 12 }])
  })

  it('hides a link target and styles its text', () => {
    const marks = marksOf('[a](https://x.example)')
    expect(marks).toContainEqual({ kind: 'mark', from: 0, to: 22, style: 'link' })
    expect(marks).toContainEqual({ kind: 'hide', from: 4, to: 21 })
  })

  it('looks only inside the ranges it is given', () => {
    const state = EditorState.create({ doc: '**a**\n\n**b**', extensions: [markdownSupport()] })
    const marks = hiddenMarks(state, [{ from: 7, to: 12 }])
    expect(marks.every(m => m.from >= 7)).toBe(true)
    expect(marks).toContainEqual({ kind: 'mark', from: 7, to: 12, style: 'strong' })
  })
})
