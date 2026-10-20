import { useEffect, useRef } from 'react'
import { Compartment, EditorSelection, EditorState, StateField, Transaction, type Range, type Extension } from '@codemirror/state'
import { IterMode, type SyntaxNode } from '@lezer/common'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { MarkdownConfig } from '@lezer/markdown'
import { artifacts, notePath } from './artifacts'
import { blockAllowed, buildBlock, buildVoid, inlineAllowed, inlineElement, parseTag, type ParsedTag } from './html'

// ==highlight== as a small parser extension, built the same way as GFM strikethrough.
// A single = never opens or closes, so `a = b` stays plain text
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }
const Highlight: MarkdownConfig = {
  defineNodes: [{ name: 'Highlight' }, { name: 'HighlightMark' }],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next != 61 || cx.char(pos + 1) != 61 || cx.char(pos + 2) == 61) return -1
        const spaceBefore = /\s|^$/.test(cx.slice(pos - 1, pos))
        const spaceAfter = /\s|^$/.test(cx.slice(pos + 2, pos + 3))
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !spaceAfter, !spaceBefore)
      },
      after: 'Emphasis',
    },
  ],
}

class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-bullet'
    span.textContent = '•'
    return span
  }
}

class RuleWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('hr')
    hr.className = 'cm-rule'
    return hr
  }
}

const hide = Decoration.replace({})
const bullet = Decoration.replace({ widget: new BulletWidget() })
const rule = Decoration.replace({ widget: new RuleWidget() })
const markClass = (cls: string) => Decoration.mark({ class: cls })
const lineClass = (cls: string) => Decoration.line({ class: cls })

const inlineStyles: Record<string, string> = {
  Emphasis: 'cm-em',
  StrongEmphasis: 'cm-strong',
  Strikethrough: 'cm-strike',
  Highlight: 'cm-hl',
  InlineCode: 'cm-icode',
  Link: 'cm-link',
}

// Inline HTML: tags inside a line of text come as separate nodes, so pair each open tag with its
// close tag (a stack per container). Paired and allowed tags are hidden and their content gets the
// real element around it. Anything unpaired or not allowed stays as text
const INLINE_CONTAINERS = /^(Paragraph|ATXHeading\d|SetextHeading\d|TableCell)$/

class VoidWidget extends WidgetType {
  constructor(readonly src: string, readonly tag: ParsedTag) {
    super()
  }
  eq(other: VoidWidget) {
    return other.src === this.src
  }
  toDOM() {
    return buildVoid(this.tag)
  }
}

function inlineHtml(state: EditorState, container: SyntaxNode, styles: Range<Decoration>[], hidden: Range<Decoration>[]) {
  const stack: { tag: ParsedTag; from: number; to: number }[] = []
  syntaxTree(state).iterate({
    from: container.from,
    to: container.to,
    mode: IterMode.IgnoreMounts,
    enter(n) {
      if (n.name !== 'HTMLTag') return
      const { from, to } = n
      const src = state.doc.sliceString(from, to)
      const tag = parseTag(src)
      if (!tag || !inlineAllowed(tag)) return
      if (tag.kind === 'self') {
        hidden.push(Decoration.replace({ widget: new VoidWidget(src, tag) }).range(from, to))
      } else if (tag.kind === 'open') {
        stack.push({ tag, from, to })
      } else {
        const i = stack.map((o) => o.tag.tag).lastIndexOf(tag.tag)
        if (i < 0) return
        const open = stack[i]
        stack.length = i
        hidden.push(hide.range(open.from, open.to), hide.range(from, to))
        if (from > open.to) styles.push(Decoration.mark(inlineElement(open.tag)).range(open.to, from))
      }
    },
  })
}

// Walk the syntax tree for the visible part of the note. Markers get hidden (and become atomic so the
// cursor jumps over them), content gets styled. The text itself is never touched
function buildDecorations(view: EditorView) {
  const styles: Range<Decoration>[] = []
  const hidden: Range<Decoration>[] = []
  const { state } = view
  const text = (from: number, to: number) => state.doc.sliceString(from, to)

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      mode: IterMode.IgnoreMounts,
      enter(node) {
        const parent = node.node.parent?.name ?? ''
        const name = node.name

        const heading = /^(ATXHeading|SetextHeading)(\d)$/.exec(name)
        if (heading) {
          styles.push(lineClass(`cm-h${heading[2]}`).range(state.doc.lineAt(node.from).from))
          // An explicit anchor like {#ex} at the end of a heading is a marker too
          const anchor = /\s*\{#[\w-]+\}\s*$/.exec(text(node.from, node.to))
          if (anchor) hidden.push(hide.range(node.to - anchor[0].length, node.to))
        }
        if (INLINE_CONTAINERS.test(name)) inlineHtml(state, node.node, styles, hidden)

        if (inlineStyles[name] && node.to > node.from) styles.push(markClass(inlineStyles[name]).range(node.from, node.to))

        switch (name) {
          case 'HeaderMark': {
            if (parent.startsWith('Setext')) {
              hidden.push(hide.range(node.from, node.to))
            } else if (node.from === state.doc.lineAt(node.from).from) {
              // Opening #'s plus the space after them
              const end = text(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
              hidden.push(hide.range(node.from, end))
            } else {
              // Closing #'s plus the space before them
              const start = text(node.from - 1, node.from) === ' ' ? node.from - 1 : node.from
              hidden.push(hide.range(start, node.to))
            }
            break
          }
          case 'EmphasisMark':
          case 'StrikethroughMark':
          case 'HighlightMark':
          case 'LinkMark':
          case 'CodeInfo':
          case 'LinkTitle':
            hidden.push(hide.range(node.from, node.to))
            break
          case 'URL':
            if (parent === 'Link' || parent === 'Image') hidden.push(hide.range(node.from, node.to))
            break
          case 'CodeMark':
            hidden.push(hide.range(node.from, node.to))
            break
          case 'Escape':
            hidden.push(hide.range(node.from, node.from + 1))
            break
          case 'QuoteMark': {
            const end = text(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            hidden.push(hide.range(node.from, end))
            styles.push(lineClass('cm-quote').range(state.doc.lineAt(node.from).from))
            break
          }
          case 'ListMark':
            if (node.node.parent?.parent?.name === 'BulletList') hidden.push(bullet.range(node.from, node.to))
            break
          case 'HorizontalRule':
            hidden.push(rule.range(node.from, node.to))
            break
          case 'FencedCode': {
            for (let pos = node.from; pos <= node.to; ) {
              const line = state.doc.lineAt(pos)
              styles.push(lineClass('cm-codeblock').range(line.from))
              pos = line.to + 1
            }
            break
          }
        }
      },
    })
  }
  return { styles: Decoration.set(styles, true), hidden: Decoration.set(hidden, true) }
}

const hiddenMarkers = ViewPlugin.fromClass(
  class {
    styles: DecorationSet
    hidden: DecorationSet
    constructor(view: EditorView) {
      ;({ styles: this.styles, hidden: this.hidden } = buildDecorations(view))
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        ;({ styles: this.styles, hidden: this.hidden } = buildDecorations(u.view))
      }
    }
  },
  {
    provide: (plugin) => [
      EditorView.decorations.of((v) => v.plugin(plugin)?.styles ?? Decoration.none),
      EditorView.decorations.of((v) => v.plugin(plugin)?.hidden ?? Decoration.none),
      EditorView.atomicRanges.of((v) => v.plugin(plugin)?.hidden ?? Decoration.none),
    ],
  },
)

// --- HTML blocks: a run of lines of HTML, drawn as one block when the cursor is elsewhere ---

class HtmlBlockWidget extends WidgetType {
  constructor(readonly from: number, readonly html: string) {
    super()
  }
  eq(other: HtmlBlockWidget) {
    return other.from === this.from && other.html === this.html
  }
  toDOM(view: EditorView) {
    const dom = buildBlock(this.html)
    // Clicking the block puts the cursor in it, which shows its source for editing
    dom.onmousedown = (e) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.from } })
      view.focus()
    }
    return dom
  }
  ignoreEvent() {
    return true
  }
}

function htmlBlockDecorations(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state)
  const sel = state.selection.main
  tree.iterate({
    mode: IterMode.IgnoreMounts,
    enter(n) {
      if (n.name !== 'HTMLBlock') return
      const from = n.from
      const to = state.doc.lineAt(n.to).to
      const html = state.doc.sliceString(from, to)
      if (sel.from <= to && sel.to >= from) {
        // Cursor inside: show the source, styled as code
        for (let pos = from; pos <= to; ) {
          const line = state.doc.lineAt(pos)
          out.push(lineClass('cm-html-src').range(line.from))
          pos = line.to + 1
        }
      } else if (blockAllowed(html)) {
        out.push(Decoration.replace({ widget: new HtmlBlockWidget(from, html), block: true }).range(from, to))
      }
      return false
    },
  })
  return Decoration.set(out, true)
}

// Block widgets must come from a state field, not a view plugin
const htmlBlocks = StateField.define<DecorationSet>({
  create: htmlBlockDecorations,
  update: (value, tr) =>
    tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? htmlBlockDecorations(tr.state) : value,
  provide: (f) => [
    EditorView.decorations.from(f),
    // Only the drawn blocks are atomic, not the line styling on a block being edited
    EditorView.atomicRanges.of((v) => v.state.field(f).update({ filter: (from, to) => to > from })),
  ],
})

// --- Formatting shortcuts ---

// Find the nearest enclosing node of a given type that covers the whole selection
function enclosing(state: EditorState, from: number, to: number, nodeName: string): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, side); n; n = n.parent) {
      if (n.name === nodeName && n.from <= from && n.to >= to) return n
    }
  }
  return null
}

// Toggle a marker pair like ** around the selection. Inside an existing one it unwraps,
// with no selection it wraps the word under the cursor
function toggleMark(mark: string, nodeName: string) {
  const len = mark.length
  return (view: EditorView) => {
    const { state } = view
    view.dispatch(
      state.update(
        state.changeByRange((range) => {
          const node = enclosing(state, range.from, range.to, nodeName)
          if (node) {
            const clamp = (p: number) => Math.min(Math.max(p - len, node.from), node.to - 2 * len)
            return {
              changes: [
                { from: node.from, to: node.from + len },
                { from: node.to - len, to: node.to },
              ],
              range: EditorSelection.range(clamp(range.anchor), clamp(range.head)),
            }
          }
          let { from, to } = range
          if (from === to) {
            const word = state.wordAt(from)
            if (word) ({ from, to } = word)
          }
          if (from === to) {
            return { changes: { from, insert: mark + mark }, range: EditorSelection.cursor(from + len) }
          }
          return {
            changes: [
              { from, insert: mark },
              { from: to, insert: mark },
            ],
            range: EditorSelection.range(range.anchor + len, range.head + len),
          }
        }),
        { scrollIntoView: true, userEvent: 'input.format' },
      ),
    )
    return true
  }
}

// Notion's shortcuts where markdown has an equivalent (no underline in markdown)
const formatKeymap = [
  { key: 'Mod-b', run: toggleMark('**', 'StrongEmphasis') },
  { key: 'Mod-i', run: toggleMark('*', 'Emphasis') },
  { key: 'Mod-Shift-s', run: toggleMark('~~', 'Strikethrough') },
  { key: 'Mod-Shift-h', run: toggleMark('==', 'Highlight') },
  { key: 'Mod-e', run: toggleMark('`', 'InlineCode') },
]

// --- Editor component ---

const rendering = new Compartment()
const rendered: Extension = [hiddenMarkers, htmlBlocks, artifacts]
const lock = new Compartment()
const locked: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

// Apply text that changed on disk as one change over the span that differs. Lines outside it keep their DOM, so
// artifact frames don't reload and the scroll position stays. Kept out of undo history, so Ctrl+Z can't undo an agent
export function applyRemote(view: EditorView, next: string) {
  const prev = view.state.doc.toString()
  if (prev === next) return
  let start = 0
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++
  let endPrev = prev.length
  let endNext = next.length
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--
    endNext--
  }
  view.dispatch({
    changes: { from: start, to: endPrev, insert: next.slice(start, endNext) },
    annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  })
}

export function CmEditor({ text, path, readOnly, onReady }: { text: string; path: string; readOnly: boolean; onReady: (view: EditorView) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    let raw = false
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          keymap.of([
            {
              // Ctrl+/ flips between the clean view and the raw text
              key: 'Mod-/',
              run: (v) => {
                raw = !raw
                v.dispatch({ effects: rendering.reconfigure(raw ? [] : rendered) })
                return true
              },
            },
            ...formatKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown({ base: markdownLanguage, extensions: [Highlight] }),
          EditorView.lineWrapping,
          rendering.of(rendered),
          notePath.of(path),
          lock.of(readOnly ? locked : []),
        ],
      }),
    })
    viewRef.current = view
    onReady(view)
    return () => view.destroy()
    // The parent remounts this component per note via `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: lock.reconfigure(readOnly ? locked : []) })
  }, [readOnly])

  return <div ref={host} className="cm-host" />
}
