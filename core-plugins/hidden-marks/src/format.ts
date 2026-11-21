import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { ChangeSet, type EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

// The format keys as changes to the markdown: a key wraps the selection in its format's markers or takes them off and
// a run the human empties loses its markers. The drawer rebases each change over what the human typed since its
// version and refuses one touching that text as stale, so neither ever undoes the human's typing

export type Format = 'bold' | 'italic' | 'strike' | 'code' | 'highlight'

// The keys Docs and Notion use for each, none of them the core's or the editor's
export const formatKeys: Readonly<Record<Format, string>> = Object.freeze({
  bold: 'Mod-b', italic: 'Mod-i', strike: 'Mod-Shift-s', code: 'Mod-e', highlight: 'Mod-Shift-h',
})

const formats: Readonly<Record<Format, { node: string, marker: string }>> = Object.freeze({
  bold: { node: 'StrongEmphasis', marker: '**' },
  italic: { node: 'Emphasis', marker: '*' },
  strike: { node: 'Strikethrough', marker: '~~' },
  code: { node: 'InlineCode', marker: '`' },
  highlight: { node: 'Highlight', marker: '==' },
})
const runNodes = new Set(Object.values(formats).map(format => format.node))

const PARSE_MS = 50

type Span = { from: number, to: number }
type Run = { from: number, to: number, open: Span, close: Span }

// A formatted run with its markers, null for any other node
function runOf(node: SyntaxNode): Run | null {
  const open = node.firstChild
  const close = node.lastChild
  if (!runNodes.has(node.name) || open === null || close === null || open === close || open.from !== node.from || close.to !== node.to) return null
  return { from: node.from, to: node.to, open: { from: open.from, to: open.to }, close: { from: close.from, to: close.to } }
}

function treeOf(state: EditorState, to: number) {
  return ensureSyntaxTree(state, to, PARSE_MS) ?? syntaxTree(state)
}

// The format's runs on the line from..to lies in that overlap it or touch it
function runsAt(state: EditorState, name: string, from: number, to: number): Run[] {
  const line = state.doc.lineAt(from)
  const runs: Run[] = []
  treeOf(state, line.to).iterate({
    from: line.from,
    to: line.to,
    enter: ref => {
      const run = ref.name === name ? runOf(ref.node) : null
      if (run !== null && run.from <= to && run.to >= from) runs.push(run)
    },
  })
  return runs
}

// The changes a format key makes at a selection on one line: the run around it taken off, or the part of the run it
// holds, else the selection wrapped with the runs it crosses joined into one. A cursor takes its run or the word it is
// inside. Null when the key changes nothing
export function toggle(state: EditorState, format: Format, range: { anchor: number, head: number }): ChangeSet | null {
  const { node, marker } = formats[format]
  let from = Math.min(range.anchor, range.head)
  let to = Math.max(range.anchor, range.head)
  if (state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return null
  const text = (at: number) => state.sliceDoc(at, at + 1)
  while (from < to && /\s/.test(text(from))) from++
  while (to > from && /\s/.test(text(to - 1))) to--
  if (from === to && range.anchor !== range.head) return null
  const runs = runsAt(state, node, from, to)
  const off = (run: Run, at: number, end: number) => ChangeSet.of([
    at <= run.open.to ? run.open : { from: at, insert: state.sliceDoc(run.close.from, run.close.to) },
    end >= run.close.from ? run.close : { from: end, insert: state.sliceDoc(run.open.from, run.open.to) },
  ], state.doc.length)
  const around = runs.find(run => run.from <= from && to <= run.to)
  if (around !== undefined) {
    const [at, end] = [Math.max(from, around.open.to), Math.min(to, around.close.from)]
    return at < end ? off(around, at, end) : off(around, around.open.to, around.close.from)
  }
  if (from === to) {
    const word = state.wordAt(from)
    if (word === null || word.from === from || word.to === from) return null
    ;[from, to] = [word.from, word.to]
  }
  const start = Math.min(from, ...runs.map(run => run.from))
  const end = Math.max(to, ...runs.map(run => run.to))
  return ChangeSet.of([{ from: start, insert: marker }, ...runs.flatMap(run => [run.open, run.close]), { from: end, insert: marker }], state.doc.length)
}

// The markers of each run a change left with nothing between them, a run inside another taken with it, as changes to
// the text after it. A run that was empty before the change is the human's own and stays
export function emptied(before: EditorState, changes: ChangeSet): ChangeSet | null {
  const runs: Run[] = []
  changes.iterChangedRanges((fromA, toA) => {
    treeOf(before, toA).iterate({
      from: fromA,
      to: toA,
      enter: ref => {
        const run = runOf(ref.node)
        if (run !== null && run.open.to < run.close.from) runs.push(run)
      },
    })
  })
  const gone: Span[] = []
  const mapped = (span: Span) => ({ from: changes.mapPos(span.from, 1), to: changes.mapPos(span.to, -1) })
  for (const run of runs.sort((a, b) => (a.to - a.from) - (b.to - b.from))) {
    const open = mapped(run.open)
    const close = mapped(run.close)
    if (open.to - open.from !== run.open.to - run.open.from || close.to - close.from !== run.close.to - run.close.from) continue
    // Nothing left between them but runs already gone
    let at = open.to
    for (let inner = gone.find(span => span.from === at); inner !== undefined; inner = gone.find(span => span.from === at)) at = inner.to
    if (at === close.from) gone.push(open, close)
  }
  return gone.length === 0 ? null : ChangeSet.of(gone, changes.newLength)
}
