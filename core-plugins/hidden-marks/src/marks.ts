import { defineLanguageFacet, ensureSyntaxTree, Language, LanguageSupport, syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import { IterMode, type SyntaxNode } from '@lezer/common'
import { Emoji, GFM, type MarkdownConfig, parser, Subscript, Superscript } from '@lezer/markdown'
import type { EditorClient } from '@hetu/sdk'

// Markdown's markers hidden and its text styled, as marks the drawer draws. Each element's hidden markers, line styles
// and bullet share one group, so an Alt+click on any of it shows the markers together. Each marker says whether it opens
// or closes the element. The text itself never
// changes and the raw view always shows the markers

export type Mark = Parameters<EditorClient['decorate']>[3][number]
type LineStyle = Extract<Mark, { kind: 'line' }>['style']
type MarkStyle = Extract<Mark, { kind: 'mark' }>['style']

// ==highlight== as a parser extension, built as GFM's strikethrough is. A single = never opens or closes, so a = b stays
// text. The page's language has its own, since a plugin's code never runs in the page
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }
const Highlight: MarkdownConfig = {
  defineNodes: [{ name: 'Highlight' }, { name: 'HighlightMark' }],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1
        const spaceBefore = /\s|^$/.test(cx.slice(pos - 1, pos))
        const spaceAfter = /\s|^$/.test(cx.slice(pos + 2, pos + 3))
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !spaceAfter, !spaceBefore)
      },
      after: 'Emphasis',
    },
  ],
}

// The markdown the editor parses notes with, GFM and its extensions and ==highlight==, as a bare parser: the editor's
// keys, completions and the HTML it reads inside a note are the page's and never reach a mark
export function markdownSupport(): Extension {
  return new LanguageSupport(new Language(defineLanguageFacet(), parser.configure([GFM, Subscript, Superscript, Emoji, Highlight]), [], 'markdown'))
}

const inlineStyles: Readonly<Record<string, MarkStyle>> = Object.freeze({
  Emphasis: 'em',
  StrongEmphasis: 'strong',
  Strikethrough: 'strike',
  Highlight: 'highlight',
  InlineCode: 'code',
  Link: 'link',
})

// Markers hidden whole, each one of the element its parent is
const hiddenNodes = new Set(['EmphasisMark', 'StrikethroughMark', 'HighlightMark', 'LinkMark', 'CodeInfo', 'LinkTitle', 'CodeMark'])

// How long one call may parse to reach the ranges asked for. Whatever isn't parsed yet comes on a later call
const PARSE_MS = 50

// An element's span and the marks drawn for it, which are kept or dropped together
export type Element = { from: number, to: number, marks: Mark[] }
// What names an element's group: the node it is and its span
export type Named = { name: string, from: number, to: number }

// The quote a quote marker belongs to, which on a line after the first is its paragraph's parent
function quoteOf(node: SyntaxNode): SyntaxNode {
  for (let at = node.parent; at !== null; at = at.parent) if (at.name === 'Blockquote') return at
  return node
}

// The elements in the ranges given, each element's hidden markers in the group groupOf names
export function hiddenMarks(state: EditorState, ranges: readonly { from: number, to: number }[], groupOf: (element: Named) => string): Element[] {
  const elements = new Map<string, Element>()
  const groups = new Map<string, string>()
  const elementOf = (node: SyntaxNode) => {
    const key = `${node.name} ${node.from}`
    let element = elements.get(key)
    if (element === undefined) elements.set(key, element = { from: node.from, to: node.to, marks: [] })
    return element
  }
  const groupFor = (owner: SyntaxNode) => {
    const key = `${owner.name} ${owner.from}`
    let group = groups.get(key)
    if (group === undefined) groups.set(key, group = groupOf({ name: owner.name, from: owner.from, to: owner.to }))
    return group
  }
  const hide = (owner: SyntaxNode, from: number, to: number, edge?: 'open' | 'close') => {
    if (to <= from) return
    const group = groupFor(owner)
    elementOf(owner).marks.push(edge === undefined ? { kind: 'hide', from, to, group } : { kind: 'hide', from, to, group, edge })
  }
  // A marker at its element's start opens it and any other closes it
  const edgeAt = (owner: SyntaxNode, from: number) => (from === owner.from ? 'open' : 'close')
  // A line style shares its element's group, so the element's text is the element on an Alt+click too
  const line = (owner: SyntaxNode, at: number, style: LineStyle) => {
    elementOf(owner).marks.push({ kind: 'line', from: state.doc.lineAt(at).from, style, group: groupFor(owner) })
  }
  const text = (from: number, to: number) => state.doc.sliceString(from, to)
  const end = ranges.reduce((most, range) => Math.max(most, range.to), 0)
  const tree = ensureSyntaxTree(state, end, PARSE_MS) ?? syntaxTree(state)

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      mode: IterMode.IgnoreMounts,
      enter(ref) {
        const node = ref.node
        const name = node.name
        const parent = node.parent ?? node
        const heading = /^(ATXHeading|SetextHeading)(\d)$/.exec(name)
        if (heading !== null) {
          line(node, node.from, `h${heading[2]}` as LineStyle)
          // An anchor like {#ex} at the end of a heading is a marker too
          const anchor = /\s*\{#[\w-]+\}\s*$/.exec(text(node.from, node.to))
          if (anchor !== null) hide(node, node.to - anchor[0].length, node.to, 'close')
        }
        const style = inlineStyles[name]
        if (style !== undefined && node.to > node.from) elementOf(node).marks.push({ kind: 'mark', from: node.from, to: node.to, style })
        if (hiddenNodes.has(name)) return void hide(parent, node.from, node.to, name === 'CodeInfo' ? 'open' : edgeAt(parent, node.from))
        switch (name) {
          case 'HeaderMark': {
            if (parent.name.startsWith('Setext')) hide(parent, node.from, node.to, 'close')
            else if (node.from === state.doc.lineAt(node.from).from) {
              // The opening #'s and the space after them
              hide(parent, node.from, text(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to, 'open')
            } else {
              // Closing #'s and the space before them
              hide(parent, text(node.from - 1, node.from) === ' ' ? node.from - 1 : node.from, node.to, 'close')
            }
            break
          }
          case 'URL':
            if (parent.name === 'Link' || parent.name === 'Image') hide(parent, node.from, node.to, 'close')
            break
          case 'Escape':
            hide(node, node.from, node.from + 1, 'open')
            break
          case 'QuoteMark':
            hide(quoteOf(node), node.from, text(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to, 'open')
            line(quoteOf(node), node.from, 'quote')
            break
          case 'ListMark':
            if (parent.parent?.name === 'BulletList') elementOf(node).marks.push({ kind: 'widget', from: node.from, to: node.to, text: '•', group: groupFor(parent) })
            break
          case 'HorizontalRule':
            hide(node, node.from, node.to)
            line(node, node.from, 'rule')
            break
          case 'FencedCode':
            // Only its lines inside the range, as a block may be longer than any viewport
            for (let at = Math.max(node.from, from); at <= Math.min(node.to, to);) {
              const each = state.doc.lineAt(at)
              line(node, each.from, 'codeblock')
              at = each.to + 1
            }
            break
        }
      },
    })
  }
  return [...elements.values()]
}

// The marks of the elements nearest around, each element whole, up to max. Those farthest from it are dropped first and
// one too big for what is left is passed over for smaller ones past it
export function keepNearest(elements: readonly Element[], around: { from: number, to: number }, max: number): Mark[] {
  const distance = (element: Element) => Math.max(0, around.from - element.to, element.from - around.to)
  const kept: Mark[] = []
  for (const element of [...elements].sort((a, b) => distance(a) - distance(b))) {
    if (kept.length + element.marks.length > max) continue
    kept.push(...element.marks)
  }
  return kept
}
