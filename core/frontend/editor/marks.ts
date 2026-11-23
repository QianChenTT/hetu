import type { Range, Text } from '@codemirror/state'
import { Decoration, type DecorationSet, WidgetType } from '@codemirror/view'
import type { Mark } from '../../api/editor.ts'

// Plain text in place of a range or at a point, drawn as text and never markup
class TextWidget extends WidgetType {
  readonly text: string

  constructor(text: string) {
    super()
    this.text = text
  }

  eq(other: TextWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-hetu-widget'
    span.textContent = this.text
    return span
  }
}

const hiddenStyle = Decoration.mark({ class: 'cm-hetu-hidden' })
const replaced = Decoration.replace({})
const styled = new Map<string, Decoration>()
const lined = new Map<string, Decoration>()

function styleOf(style: string): Decoration {
  let made = styled.get(style)
  if (made === undefined) styled.set(style, made = Decoration.mark({ class: `cm-hetu-${style}` }))
  return made
}

// Text within a line is hidden with a style, so it stays in the page and an IME composing beside it reads the text
// right. A range over a line break is replaced, since a style can't take the break away. The element and the edge ride
// on the decoration, for the rules on hidden text to read
function hideOf(mark: Extract<Mark, { kind: 'hide' }>, doc: Text): Decoration {
  const across = doc.lineAt(mark.from).to < mark.to
  if (mark.group === undefined && mark.edge === undefined) return across ? replaced : hiddenStyle
  const spec = { ...mark.group === undefined ? {} : { group: mark.group }, ...mark.edge === undefined ? {} : { edge: mark.edge } }
  return across ? Decoration.replace(spec) : Decoration.mark({ class: 'cm-hetu-hidden', ...spec })
}

function lineOf(style: string): Decoration {
  let made = lined.get(style)
  if (made === undefined) lined.set(style, made = Decoration.line({ class: `cm-hetu-line-${style}` }))
  return made
}

// A widget over a range replaces it. One at a point is drawn before a caret at its place, since typed text lands after
// it: the versions keep it before text typed there and the hidden rules rest the caret after a widget opening its line.
// CodeMirror refuses an empty range to a replacement
function widgetOf(mark: Extract<Mark, { kind: 'widget' }>): Decoration {
  const widget = new TextWidget(mark.text)
  return mark.from === mark.to ? Decoration.widget({ widget, side: -1 }) : Decoration.replace({ widget })
}

// The decoration a mark draws as, its range and whether it goes with the hidden ranges, or null for a mark reaching past
// the end of doc. A line style's line start is never past doc, since its mark is held to doc first
function decorationOf(mark: Mark, doc: Text): { decoration: Decoration, from: number, to: number, hidden: boolean } | null {
  if (mark.kind === 'line') {
    if (mark.from > doc.length) return null
    const at = doc.lineAt(mark.from).from
    return { decoration: lineOf(mark.style), from: at, to: at, hidden: false }
  }
  if (mark.to > doc.length) return null
  const { from, to } = mark
  if (mark.kind === 'mark') return { decoration: styleOf(mark.style), from, to, hidden: false }
  if (mark.kind === 'link') return { decoration: styleOf('link'), from, to, hidden: false }
  if (mark.kind === 'hide') return { decoration: hideOf(mark, doc), from, to, hidden: true }
  return { decoration: widgetOf(mark), from, to, hidden: true }
}

// A plugin's widgets at a point strictly inside its own hidden ranges, which hidden text takes off the screen and where
// no rule rests the caret. One at a hidden range's edge is drawn
export function buried(marks: readonly Mark[]): Set<Mark> {
  const out = new Set<Mark>()
  const points = marks.filter(mark => mark.kind === 'widget' && mark.from === mark.to)
  if (points.length === 0) return out
  // The hidden ranges sorted, overlapping ones joined. Ranges that only touch stay apart, so a point between them shows
  const spans: { from: number, to: number }[] = []
  for (const hide of marks.filter(mark => mark.kind === 'hide').sort((a, b) => a.from - b.from)) {
    const last = spans.at(-1)
    if (last !== undefined && hide.from < last.to) last.to = Math.max(last.to, hide.to)
    else spans.push({ from: hide.from, to: hide.to })
  }
  for (const point of points) {
    // The last span starting before the point, the only one that can hold it
    let low = 0
    let high = spans.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (spans[middle].from < point.from) low = middle + 1
      else high = middle
    }
    if (low > 0 && point.from < spans[low - 1].to) out.add(point)
  }
  return out
}

// Marks as CodeMirror decorations with the drawer's own classes: styles, links and line styles in marks, hidden ranges and
// widgets in hidden, which the drawer's rules for hidden text read. A mark reaching past the end of doc is left out,
// since the marks a plugin sends were checked for shape and not against the text. So is one whose range CodeMirror
// still refuses, alone, so the rest of every plugin's marks draw
export function drawMarks(given: readonly Mark[], doc: Text): { marks: DecorationSet, hidden: DecorationSet } {
  const marks: Range<Decoration>[] = []
  const hidden: Range<Decoration>[] = []
  for (const mark of given) {
    const drawn = decorationOf(mark, doc)
    if (drawn === null) continue
    let range: Range<Decoration>
    try {
      range = drawn.decoration.range(drawn.from, drawn.to)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      // CodeMirror's RangeError for a range its decoration can't take, such as an empty mark. Safe to swallow since it is
      // thrown before the range is made, so nothing of this mark reaches the set and the rest of every plugin's marks draw
      continue
    }
    (drawn.hidden ? hidden : marks).push(range)
  }
  return { marks: Decoration.set(marks, true), hidden: Decoration.set(hidden, true) }
}
