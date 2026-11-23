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

// Marks as CodeMirror decorations with the drawer's own classes: styles, links and line styles in marks, hidden ranges and
// widgets in hidden, which the drawer's rules for hidden text read. A mark reaching past the end of doc is left out,
// since the marks a plugin sends were checked for shape and not against the text
export function drawMarks(given: readonly Mark[], doc: Text): { marks: DecorationSet, hidden: DecorationSet } {
  const marks: Range<Decoration>[] = []
  const hidden: Range<Decoration>[] = []
  for (const mark of given) {
    if (mark.kind === 'line') {
      if (mark.from <= doc.length) marks.push(lineOf(mark.style).range(doc.lineAt(mark.from).from))
      continue
    }
    if (mark.to > doc.length) continue
    if (mark.kind === 'mark') marks.push(styleOf(mark.style).range(mark.from, mark.to))
    else if (mark.kind === 'link') marks.push(styleOf('link').range(mark.from, mark.to))
    else if (mark.kind === 'hide') hidden.push(hideOf(mark, doc).range(mark.from, mark.to))
    else hidden.push(Decoration.replace({ widget: new TextWidget(mark.text) }).range(mark.from, mark.to))
  }
  return { marks: Decoration.set(marks, true), hidden: Decoration.set(hidden, true) }
}
