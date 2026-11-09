import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import { IterMode } from '@lezer/common'
import type { MarkdownConfig } from '@lezer/markdown'
import type { LineStyle, Mark, MarkStyle } from '../../api/editor.ts'

// Hidden marks: markdown's markers hidden and its text styled, as marks in the bridge's shape, so the drawer draws them
// with the same code as a plugin's and #98 can move this behind the bridge. In the page from the install, switched by
// the hidden-marks install plugin. The text itself never changes and the raw view always shows the markers

// ==highlight== as a parser extension, built as GFM's strikethrough is. A single = never opens or closes, so a = b stays
// text
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

// The language every editor instance parses notes with: GFM and ==highlight==
export function markdownSupport(): Extension {
  return markdown({ base: markdownLanguage, extensions: [Highlight] })
}

const inlineStyles: Readonly<Record<string, MarkStyle>> = Object.freeze({
  Emphasis: 'em',
  StrongEmphasis: 'strong',
  Strikethrough: 'strike',
  Highlight: 'highlight',
  InlineCode: 'code',
  Link: 'link',
})

const hiddenNodes = new Set(['EmphasisMark', 'StrikethroughMark', 'HighlightMark', 'LinkMark', 'CodeInfo', 'LinkTitle', 'CodeMark'])

// How long one call may spend parsing to reach the ranges asked for, so a huge note never stalls a keystroke. Whatever
// isn't parsed yet comes on a later update
const PARSE_MS = 20

// The marks for the ranges given, the visible ones in the editor
export function hiddenMarks(state: EditorState, ranges: readonly { from: number, to: number }[]): Mark[] {
  const out: Mark[] = []
  const hide = (from: number, to: number) => {
    if (to > from) out.push({ kind: 'hide', from, to })
  }
  const line = (at: number, style: LineStyle) => out.push({ kind: 'line', from: state.doc.lineAt(at).from, style })
  const text = (from: number, to: number) => state.doc.sliceString(from, to)
  const end = ranges.reduce((most, range) => Math.max(most, range.to), 0)
  const tree = ensureSyntaxTree(state, end, PARSE_MS) ?? syntaxTree(state)

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      mode: IterMode.IgnoreMounts,
      enter(node) {
        const name = node.name
        const parent = node.node.parent?.name ?? ''
        const heading = /^(ATXHeading|SetextHeading)(\d)$/.exec(name)
        if (heading !== null) {
          line(node.from, `h${heading[2]}` as LineStyle)
          // An anchor like {#ex} at the end of a heading is a marker too
          const anchor = /\s*\{#[\w-]+\}\s*$/.exec(text(node.from, node.to))
          if (anchor !== null) hide(node.to - anchor[0].length, node.to)
        }
        const style = inlineStyles[name]
        if (style !== undefined && node.to > node.from) out.push({ kind: 'mark', from: node.from, to: node.to, style })
        if (hiddenNodes.has(name)) return void hide(node.from, node.to)
        switch (name) {
          case 'HeaderMark': {
            if (parent.startsWith('Setext')) hide(node.from, node.to)
            else if (node.from === state.doc.lineAt(node.from).from) {
              // The opening #'s and the space after them
              hide(node.from, text(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to)
            } else {
              // Closing #'s and the space before them
              hide(text(node.from - 1, node.from) === ' ' ? node.from - 1 : node.from, node.to)
            }
            break
          }
          case 'URL':
            if (parent === 'Link' || parent === 'Image') hide(node.from, node.to)
            break
          case 'Escape':
            hide(node.from, node.from + 1)
            break
          case 'QuoteMark':
            hide(node.from, text(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to)
            line(node.from, 'quote')
            break
          case 'ListMark':
            if (node.node.parent?.parent?.name === 'BulletList') out.push({ kind: 'widget', from: node.from, to: node.to, text: '•' })
            break
          case 'HorizontalRule':
            hide(node.from, node.to)
            line(node.from, 'rule')
            break
          case 'FencedCode':
            for (let at = node.from; at <= node.to;) {
              const each = state.doc.lineAt(at)
              line(each.from, 'codeblock')
              at = each.to + 1
            }
            break
        }
      },
    })
  }
  return out
}
