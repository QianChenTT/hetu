import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
import {
  Annotation, type ChangeSet, EditorState, type Extension, Prec, StateEffect, StateField, type Text, Transaction, type TransactionSpec,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, type KeyBinding, keymap } from '@codemirror/view'
import type { Mark } from '../../api/editor.ts'
import type { Instance } from './bridge.ts'
import { hiddenRules, hiddenText, placeCaret } from './hidden-rules.ts'
import type { Rect } from './drag.ts'
import { lay } from './layers.ts'
import { markdownSupport } from './markdown.ts'
import { drawMarks } from './marks.ts'
import type { Editors } from './notes.ts'
import { mapThrough, Versions } from './versions.ts'

// The drawer's editor slots: a CodeMirror view per open note, each laid over the box of the editor slot the layout
// placed for it, in the lifted layer, and hidden while no slot holds it. The current one is the note the human works in.
// CodeMirror is core mechanism here and decides nothing. Plugins' marks, hidden marks' among them, come only through
// the bridge, drawn with the drawer's own classes. Nothing here reaches the core: the notes and the drawer do

export type ViewHooks = {
  created(instance: Instance): void
  // remote marks a change from outside, kept out of undo. hid names the plugins whose hidden text the human's change
  // removed, which the save then names too
  changed(instance: Instance, changes: ChangeSet, remote: boolean, hid: string[]): void
  // A key CodeMirror's own keymaps left, for the plugins' bindings. True when one took it
  key(instance: string, event: KeyboardEvent): boolean
  // The human moved into another open note
  focused?(instance: string): void
  // The range of the text the editor draws moved, told once as it is made and again each time it moves. CodeMirror's
  // viewport: the lines on screen with a margin past them and any hidden stretch inside it whole
  viewport(instance: Instance, from: number, to: number): void
}

// Which plugin made a change
const fromPlugin = Annotation.define<string>()

type Drawn = { marks: DecorationSet, hidden: DecorationSet }
const none: Drawn = { marks: Decoration.none, hidden: Decoration.none }

// The plugins' marks by owner and then by set, mapped through each change
type Owned = ReadonlyMap<string, ReadonlyMap<string, readonly Mark[]>>
export const setMarks = StateEffect.define<{ owner: string, set: string, marks: Mark[] }>()
const clearMarks = StateEffect.define<string>()

// An element shown on an Alt+click: one plugin's group, so no plugin's name reaches another's hidden text
type Shown = { owner: string, group: string }
const reveal = StateEffect.define<Shown[]>()

// The span of each of a plugin's groups, from its first mark to its last, a line style taking its whole line
function hullsOf(sets: ReadonlyMap<string, readonly Mark[]> | undefined, doc: Text): Map<string, { from: number, to: number }> {
  const hulls = new Map<string, { from: number, to: number }>()
  for (const marks of sets?.values() ?? []) {
    for (const mark of marks) {
      if (mark.group === undefined || mark.from > doc.length) continue
      const span = mark.kind === 'line' ? doc.lineAt(mark.from) : mark
      const hull = hulls.get(mark.group)
      hulls.set(mark.group, hull === undefined ? { from: span.from, to: span.to } : { from: Math.min(hull.from, span.from), to: Math.max(hull.to, span.to) })
    }
  }
  return hulls
}

// What an Alt+click at pos shows: each plugin's innermost group whose span holds pos and the cursor put there. Null when
// pos is in no group, so the click goes on as a plain one
export function revealClick(state: EditorState, pos: number): TransactionSpec | null {
  const shown: Shown[] = []
  for (const [owner, sets] of state.field(pluginMarks).owned) {
    let best: { group: string, size: number } | null = null
    for (const [group, hull] of hullsOf(sets, state.doc)) {
      if (pos < hull.from || pos > hull.to) continue
      if (best === null || hull.to - hull.from < best.size) best = { group, size: hull.to - hull.from }
    }
    if (best !== null) shown.push({ owner, group: best.group })
  }
  return shown.length === 0 ? null : { effects: reveal.of(shown), selection: { anchor: pos } }
}

export const pluginMarks = StateField.define<{ owned: Owned, shown: readonly Shown[], drawn: Drawn }>({
  create: () => ({ owned: new Map(), shown: [], drawn: none }),
  update(value, tr) {
    let owned = value.owned
    let shown = value.shown
    let moved = false
    if (tr.docChanged) {
      owned = new Map([...owned].map(([owner, sets]) => [owner, new Map([...sets].map(([set, marks]) => [set, mapThrough(marks, tr.changes)]))]))
      moved = true
    }
    for (const effect of tr.effects) {
      if (effect.is(setMarks)) {
        const next = new Map(owned)
        const sets = new Map(next.get(effect.value.owner) ?? [])
        sets.set(effect.value.set, effect.value.marks)
        next.set(effect.value.owner, sets)
        owned = next
        moved = true
      } else if (effect.is(clearMarks) && owned.has(effect.value)) {
        const next = new Map(owned)
        next.delete(effect.value)
        owned = next
        moved = true
      } else if (effect.is(reveal)) {
        shown = [...shown, ...effect.value.filter(one => !shown.some(had => had.owner === one.owner && had.group === one.group))]
        moved = true
      }
    }
    // An element is hidden again once no cursor is inside it, its edges included
    if (shown.length > 0 && (moved || tr.selection !== undefined)) {
      const heads = tr.newSelection.ranges.map(range => range.head)
      const kept = shown.filter(one => {
        const hull = hullsOf(owned.get(one.owner), tr.state.doc).get(one.group)
        return hull !== undefined && heads.some(head => head >= hull.from && head <= hull.to)
      })
      if (kept.length !== shown.length) moved = true
      shown = kept
    }
    if (!moved) return value
    const all = [...owned].flatMap(([owner, sets]) => [...sets.values()].flat()
      .filter(mark => (mark.kind !== 'hide' && mark.kind !== 'widget') || !shown.some(one => one.owner === owner && one.group === mark.group)))
    return { owned, shown, drawn: all.length === 0 ? none : drawMarks(all, tr.state.doc) }
  },
  // The drawer's rules for hidden text read the hidden ranges, so no plugin's are atomic
  provide: field => [
    hiddenText.of(view => view.state.field(field).drawn.hidden),
    EditorView.decorations.from(field, value => value.drawn.marks),
    EditorView.decorations.from(field, value => value.drawn.hidden),
  ],
})

// The plugins whose hidden ranges or widgets a change removes text from, in the text before it
function hiddenBy(owned: Owned, changes: ChangeSet): string[] {
  const owners: string[] = []
  for (const [owner, sets] of owned) {
    let hit = false
    changes.iterChangedRanges((fromA, toA) => {
      if (hit || toA === fromA) return
      for (const marks of sets.values()) {
        if (marks.some(mark => (mark.kind === 'hide' || mark.kind === 'widget') && mark.from < toA && mark.to > fromA)) hit = true
      }
    })
    if (hit) owners.push(owner)
  }
  return owners
}

// CodeMirror's own keys, less Mod-i, which selects the syntax node around the cursor and would keep italic's key from
// reaching a plugin's binding
export const editorKeys: readonly KeyBinding[] = [...defaultKeymap.filter(binding => binding.key !== 'Mod-i'), ...historyKeymap]

type Open = { view: EditorView, element: HTMLElement, instance: Instance }

export class EditorViews implements Editors {
  private readonly host: HTMLElement
  private readonly hooks: ViewHooks
  private readonly open = new Map<string, Open>()
  private shownId: string | null = null
  private readonly nonce: string

  // nonce is the one the page's policy names for its style elements, so CodeMirror's own style sheet applies
  constructor(host: HTMLElement, hooks: ViewHooks, nonce: string) {
    this.host = host
    this.hooks = hooks
    this.nonce = nonce
  }

  create(id: string, text: string, path = ''): void {
    const element = document.createElement('div')
    element.className = 'editor'
    element.hidden = true
    this.host.append(element)
    // A note saved with CRLF keeps it: CodeMirror counts a line break as one place whichever it is
    const separator: Extension = text.includes('\r\n') ? EditorState.lineSeparator.of('\r\n') : []
    let instance: Instance | null = null
    const view = new EditorView({
      parent: element,
      state: EditorState.create({
        doc: text,
        extensions: [
          separator,
          EditorView.cspNonce.of(this.nonce),
          history(),
          markdownSupport(),
          hiddenRules,
          EditorView.lineWrapping,
          keymap.of(editorKeys),
          Prec.lowest(EditorView.domEventHandlers({ keydown: event => this.hooks.key(id, event) })),
          // A click into a note another slot shows makes it the current one
          EditorView.domEventHandlers({
            focus: () => {
              if (this.shownId === id) return
              this.shownId = id
              this.hooks.focused?.(id)
            },
            // Alt+click shows the element under the pointer. The click is taken whole, so the cursor stays at the place
            // pointed at, not where the shown markers push the text to
            mousedown: (event, view) => {
              if (!event.altKey || event.button !== 0) return false
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
              const spec = pos === null ? null : revealClick(view.state, pos)
              if (spec === null) return false
              event.preventDefault()
              view.dispatch(spec)
              view.focus()
              return true
            },
          }),
          pluginMarks,
          EditorView.updateListener.of(update => {
            if (instance === null) return
            for (const tr of update.transactions) {
              if (!tr.docChanged) continue
              instance.versions.push(tr.changes)
              const remote = tr.annotation(Transaction.remote) === true
              const human = !remote && tr.annotation(fromPlugin) === undefined
              const hid = human ? hiddenBy(tr.startState.field(pluginMarks).owned, tr.changes) : []
              this.hooks.changed(instance, tr.changes, remote, hid)
            }
            // After the changes reached versions, so the range counts in the version it was drawn at
            if (update.viewportChanged) this.hooks.viewport(instance, update.view.viewport.from, update.view.viewport.to)
          }),
        ],
      }),
    })
    const versions = new Versions(view.state.doc.length)
    instance = {
      id,
      path,
      versions,
      // Line breaks as one character, as positions count them
      text: () => view.state.doc.toString(),
      selection: () => view.state.selection.ranges.map(range => ({ anchor: range.anchor, head: range.head })),
      apply: (changes, plugin, selection) => view.dispatch({
        changes,
        annotations: [fromPlugin.of(plugin), isolateHistory.of('full')],
        userEvent: 'input.plugin',
        ...selection === undefined ? {} : { selection, effects: placeCaret.of(selection.head) },
      }),
      setMarks: (owner, set, marks) => view.dispatch({ effects: setMarks.of({ owner, set, marks }) }),
      clearMarks: owner => view.dispatch({ effects: clearMarks.of(owner) }),
    }
    this.open.set(id, { view, element, instance })
    this.hooks.created(instance)
    this.hooks.viewport(instance, view.viewport.from, view.viewport.to)
  }

  // The note's text as it saves, its own line breaks kept
  text(id: string): string {
    return this.open.get(id)?.view.state.sliceDoc() ?? ''
  }

  // One change over the span that differs, so lines outside it keep their place and the cursor stays. A change from
  // outside stays out of undo
  replace(id: string, text: string, remote: boolean): void {
    const open = this.open.get(id)
    if (open === undefined) return
    const { state } = open.view
    const separator = state.lineBreak
    const prev = state.doc.toString()
    const next = separator === '\n' ? text : text.split(separator).join('\n')
    if (prev === next) return
    let start = 0
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++
    let endPrev = prev.length
    let endNext = next.length
    while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
      endPrev--
      endNext--
    }
    const insert = state.toText(next.slice(start, endNext).split('\n').join(separator))
    open.view.dispatch({
      changes: { from: start, to: endPrev, insert },
      annotations: remote ? [Transaction.addToHistory.of(false), Transaction.remote.of(true)] : [],
      userEvent: remote ? 'input.remote' : 'input.restore',
    })
  }

  destroy(id: string): void {
    const open = this.open.get(id)
    if (open === undefined) return
    open.view.destroy()
    open.element.remove()
    this.open.delete(id)
    if (this.shownId === id) this.shownId = null
  }

  // Makes the note current, has it laid out and focuses it unless told not to
  show(id: string, focus = true): void {
    this.shownId = this.open.has(id) ? id : null
    this.onCurrent?.()
    if (focus) this.open.get(id)?.view.focus()
  }

  // Told when the current note changes, so the layers place it before it takes focus
  onCurrent: (() => void) | null = null

  ids(): string[] {
    return [...this.open.keys()]
  }

  // The editor laid over the box of its slot, or hidden
  place(id: string, box: Rect | null): void {
    const open = this.open.get(id)
    if (open === undefined) return
    const wasHidden = open.element.hidden
    lay(open.element, box)
    if (wasHidden && box !== null) open.view.requestMeasure()
  }

  shown(): string | null {
    return this.shownId
  }

  focus(): void {
    if (this.shownId !== null) this.open.get(this.shownId)?.view.focus()
  }

  // The instance whose editor holds the page's focus, else none. The window itself needn't have the OS's focus
  focused(): string | null {
    const active = document.activeElement
    for (const [id, open] of this.open) if (active !== null && open.view.contentDOM.contains(active)) return id
    return null
  }

  instance(id: string): Instance | undefined {
    return this.open.get(id)?.instance
  }

  instances(): Instance[] {
    return [...this.open.values()].map(open => open.instance)
  }
}
