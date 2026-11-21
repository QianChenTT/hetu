import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { type ElementKind, hiddenMarks, keepNearest, markdownSupport, type Mark } from '../src/marks.ts'

// Each element's group named by its node and where it starts, as these notes keep them apart
const byStart = (element: { name: string, from: number }) => `g${element.from}${element.name}`

function stateOf(text: string): EditorState {
  return EditorState.create({ doc: text, extensions: [markdownSupport()] })
}

function marksOf(text: string): Mark[] {
  const state = stateOf(text)
  const marks = hiddenMarks(state, [{ from: 0, to: state.doc.length }], byStart).flatMap(element => element.marks)
  expect(state.doc.toString()).toBe(text)
  return marks
}

const sorted = (marks: Mark[]) => [...marks].sort((a, b) => a.from - b.from || a.kind.localeCompare(b.kind))
const hides = (marks: Mark[]) => marks.filter(mark => mark.kind === 'hide')

describe('hidden marks', () => {
  it('makes bold text strong and hides its markers', () => {
    expect(sorted(marksOf('**bold**'))).toEqual([
      { kind: 'hide', from: 0, to: 2, group: 'g0StrongEmphasis', edge: 'open' },
      { kind: 'mark', from: 0, to: 8, style: 'strong' },
      { kind: 'hide', from: 6, to: 8, group: 'g0StrongEmphasis', edge: 'close' },
    ])
  })

  it('styles a heading line and hides its marker with the space after it', () => {
    expect(sorted(marksOf('# Title'))).toEqual([
      { kind: 'hide', from: 0, to: 2, group: 'g0ATXHeading1', edge: 'open' },
      { kind: 'line', from: 0, style: 'h1', group: 'g0ATXHeading1' },
    ])
  })

  it('draws a bullet in place of a list marker', () => {
    expect(marksOf('- item')).toEqual([{ kind: 'widget', from: 0, to: 1, text: '•', group: 'g0ListItem' }])
  })

  it('draws a rule as a line style and hides its dashes', () => {
    expect(sorted(marksOf('---'))).toEqual([
      { kind: 'hide', from: 0, to: 3, group: 'g0HorizontalRule' },
      { kind: 'line', from: 0, style: 'rule', group: 'g0HorizontalRule' },
    ])
  })

  it('highlights ==text== and hides its markers', () => {
    expect(sorted(marksOf('==hi=='))).toEqual([
      { kind: 'hide', from: 0, to: 2, group: 'g0Highlight', edge: 'open' },
      { kind: 'mark', from: 0, to: 6, style: 'highlight' },
      { kind: 'hide', from: 4, to: 6, group: 'g0Highlight', edge: 'close' },
    ])
  })

  it('leaves a single = as text', () => {
    expect(marksOf('a = b')).toEqual([])
  })

  it('hides only the backslash of an escape', () => {
    expect(marksOf('\\*x')).toEqual([{ kind: 'hide', from: 0, to: 1, group: 'g0Escape', edge: 'open' }])
  })

  it('hides a quote marker and styles the line', () => {
    expect(sorted(marksOf('> said'))).toEqual([
      { kind: 'hide', from: 0, to: 2, group: 'g0Blockquote', edge: 'open' },
      { kind: 'line', from: 0, style: 'quote', group: 'g0Blockquote' },
    ])
  })

  it('styles each line of a fenced block and hides the fences', () => {
    const marks = marksOf('```\ncode\n```')
    expect(marks.filter(m => m.kind === 'line').map(m => m.from)).toEqual([0, 4, 9])
    expect(hides(marks)).toEqual([
      { kind: 'hide', from: 0, to: 3, group: 'g0FencedCode', edge: 'open' },
      { kind: 'hide', from: 9, to: 12, group: 'g0FencedCode', edge: 'close' },
    ])
  })

  it('hides a link target and styles its text', () => {
    const marks = marksOf('[a](https://x.example)')
    expect(marks).toContainEqual({ kind: 'mark', from: 0, to: 22, style: 'link' })
    expect(marks).toContainEqual({ kind: 'hide', from: 4, to: 21, group: 'g0Link', edge: 'close' })
  })

  it('looks only inside the ranges it is given', () => {
    const state = stateOf('**a**\n\n**b**')
    const marks = hiddenMarks(state, [{ from: 7, to: 12 }], byStart).flatMap(element => element.marks)
    expect(marks.every(m => m.from >= 7)).toBe(true)
    expect(marks).toContainEqual({ kind: 'mark', from: 7, to: 12, style: 'strong' })
  })
})

describe("an element's markers", () => {
  it('share one group per element, each run apart from the next', () => {
    const groups = hides(marksOf('**a** and *b*')).map(mark => mark.kind === 'hide' && mark.group)
    expect(groups).toEqual(['g0StrongEmphasis', 'g0StrongEmphasis', 'g10Emphasis', 'g10Emphasis'])
  })

  it("open with a link's bracket and close with the rest of it, its URL included", () => {
    expect(hides(marksOf('[a](u)'))).toEqual([
      { kind: 'hide', from: 0, to: 1, group: 'g0Link', edge: 'open' },
      { kind: 'hide', from: 2, to: 3, group: 'g0Link', edge: 'close' },
      { kind: 'hide', from: 3, to: 4, group: 'g0Link', edge: 'close' },
      { kind: 'hide', from: 4, to: 5, group: 'g0Link', edge: 'close' },
      { kind: 'hide', from: 5, to: 6, group: 'g0Link', edge: 'close' },
    ])
  })

  it("open a heading with its #'s and close it with the #'s that end it", () => {
    expect(hides(marksOf('## T ##'))).toEqual([
      { kind: 'hide', from: 0, to: 3, group: 'g0ATXHeading2', edge: 'open' },
      { kind: 'hide', from: 4, to: 7, group: 'g0ATXHeading2', edge: 'close' },
    ])
  })

  it("open a fenced block with its fence and its language's name", () => {
    expect(hides(marksOf('```js\ncode\n```'))).toEqual([
      { kind: 'hide', from: 0, to: 3, group: 'g0FencedCode', edge: 'open' },
      { kind: 'hide', from: 3, to: 5, group: 'g0FencedCode', edge: 'open' },
      { kind: 'hide', from: 11, to: 14, group: 'g0FencedCode', edge: 'close' },
    ])
  })

  it("open each line of a quote in the quote's one group, a quote inside it in its own", () => {
    expect(hides(marksOf('> a\n> b\n> > c'))).toEqual([
      { kind: 'hide', from: 0, to: 2, group: 'g0Blockquote', edge: 'open' },
      { kind: 'hide', from: 4, to: 6, group: 'g0Blockquote', edge: 'open' },
      { kind: 'hide', from: 8, to: 10, group: 'g0Blockquote', edge: 'open' },
      { kind: 'hide', from: 10, to: 12, group: 'g10Blockquote', edge: 'open' },
    ])
  })

  it("share their group with the element's line styles, so an Alt+click on a heading's or a block's text shows them", () => {
    const groups = (text: string) => new Set(marksOf(text).map(mark => mark.group))
    expect(groups('## T ##')).toEqual(new Set(['g0ATXHeading2']))
    expect(groups('T\n=')).toEqual(new Set(['g0SetextHeading1']))
    expect(groups('```\ncode\n```')).toEqual(new Set(['g0FencedCode']))
  })

  it('are named once per element, with the node it is and where it starts', () => {
    const seen: { name: string, from: number }[] = []
    hiddenMarks(stateOf('**a** [b](c)'), [{ from: 0, to: 12 }], element => {
      seen.push({ name: element.name, from: element.from })
      return byStart(element)
    })
    expect(seen).toEqual([{ name: 'StrongEmphasis', from: 0 }, { name: 'Link', from: 6 }])
  })
})

describe('a fenced block reaching past the ranges', () => {
  it('styles only its lines inside them', () => {
    const text = `\`\`\`\n${Array.from({ length: 100 }, (_, n) => `line ${n}`).join('\n')}\n\`\`\``
    const state = stateOf(text)
    const at = state.doc.line(50)
    const marks = hiddenMarks(state, [{ from: at.from, to: at.to }], byStart).flatMap(element => element.marks)
    expect(marks.filter(m => m.kind === 'line').map(m => m.from)).toEqual([at.from])
  })
})

describe('the marks kept under a cap', () => {
  // A line of bold for each of count lines: three marks a line
  const bold = (count: number) => stateOf(Array.from({ length: count }, () => '**b**').join('\n'))

  it('keeps every mark under the cap', () => {
    const state = bold(10)
    const elements = hiddenMarks(state, [{ from: 0, to: state.doc.length }], byStart)
    expect(keepNearest(elements, { from: 0, to: 5 }, 100)).toHaveLength(30)
  })

  it('drops the elements farthest from the viewport whole and keeps those nearest it', () => {
    const state = bold(1000)
    const middle = state.doc.line(500)
    const elements = hiddenMarks(state, [{ from: 0, to: state.doc.length }], byStart)
    const kept = keepNearest(elements, { from: middle.from, to: middle.to }, 100)
    expect(kept.length).toBeLessThanOrEqual(100)
    expect(kept.length).toBeGreaterThan(90)
    expect(kept).toContainEqual({ kind: 'mark', from: middle.from, to: middle.to, style: 'strong' })
    const lines = kept.map(mark => state.doc.lineAt(mark.from).number)
    expect(Math.max(...lines) - Math.min(...lines)).toBeLessThan(40)
    // Each line's bold whole: its style and both its markers
    const perLine = new Map<number, number>()
    for (const line of lines) perLine.set(line, (perLine.get(line) ?? 0) + 1)
    expect([...perLine.values()].every(count => count === 3)).toBe(true)
  })

  it('passes over an element too big for the cap and keeps the smaller ones past it', () => {
    // A quote whose markers and line styles pass the cap alone, a bold on each of its lines
    const state = stateOf(Array.from({ length: 60 }, () => '> **b**').join('\n'))
    const middle = state.doc.line(30)
    const elements = hiddenMarks(state, [{ from: 0, to: state.doc.length }], byStart)
    const kept = keepNearest(elements, { from: middle.from, to: middle.to }, 100)
    expect(kept.length).toBeGreaterThan(90)
    expect(kept).toContainEqual({ kind: 'mark', from: middle.from + 2, to: middle.to, style: 'strong' })
    expect(kept.some(mark => mark.kind === 'line')).toBe(false)
  })
})

describe('an element the human chose to show', () => {
  function shownOf(text: string, kind: ElementKind): Mark[] {
    const state = stateOf(text)
    return hiddenMarks(state, [{ from: 0, to: state.doc.length }], byStart, new Set([kind])).flatMap(element => element.marks)
  }

  it('keeps its style and hides none of its markdown, other elements hidden as before', () => {
    expect(sorted(shownOf('**a** *b*', 'bold'))).toEqual([
      { kind: 'mark', from: 0, to: 5, style: 'strong' },
      { kind: 'hide', from: 6, to: 7, group: 'g6Emphasis', edge: 'open' },
      { kind: 'mark', from: 6, to: 9, style: 'em' },
      { kind: 'hide', from: 8, to: 9, group: 'g6Emphasis', edge: 'close' },
    ])
    expect(shownOf('# T', 'heading')).toEqual([{ kind: 'line', from: 0, style: 'h1', group: 'g0ATXHeading1' }])
    expect(shownOf('- item', 'bullet')).toEqual([])
    expect(hides(shownOf('[a](u) ![b](v)', 'link'))).toEqual([])
    expect(hides(shownOf('```\ncode\n```', 'fence'))).toEqual([])
  })
})
