import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import type { Extension } from '@codemirror/state'
import type { MarkdownConfig } from '@lezer/markdown'

// The markdown every editor instance parses notes with. What hides and how text is styled is the hidden marks plugin's,
// behind the bridge

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
