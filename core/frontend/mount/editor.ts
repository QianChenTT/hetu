import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { Annotation, type ChangeSet, Compartment, EditorState, type Extension, Prec, StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { Mark } from '../../api/editor.ts'
import type { Instance } from './bridge.ts'
import { hiddenMarks, markdownSupport } from './hidden-marks.ts'
import type { Rect } from './drag.ts'
import { lay } from './layers.ts'
import { drawMarks } from './marks.ts'
import type { Editors } from './notes.ts'
import { mapThrough, Versions } from './versions.ts'

// The drawer's editor slots: a CodeMirror view per open note, each laid over the box of the editor slot the layout
// placed for it, in the lifted layer, and hidden while no slot holds it. The current one is the note the human works in.
// CodeMirror is core mechanism here and decides nothing. Hidden marks is applied only while its install plugin is ready. Plugins' marks come only through
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
}

// Which plugin made a change
const fromPlugin = Annotation.define<string>()

type Drawn = { marks: DecorationSet, hidden: DecorationSet }
const none: Drawn = { marks: Decoration.none, hidden: Decoration.none }

// The plugins' marks by owner and then by set, mapped through each change
type Owned = ReadonlyMap<string, ReadonlyMap<string, readonly Mark[]>>
const setMarks = StateEffect.define<{ owner: string, set: string, marks: Mark[] }>()
const clearMarks = StateEffect.define<string>()

const pluginMarks = StateField.define<{ owned: Owned, drawn: Drawn }>({
  create: () => ({ owned: new Map(), drawn: none }),
  update(value, tr) {
    let owned = value.owned
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
      }
    }
    if (!moved) return value
    const all = [...owned.values()].flatMap(sets => [...sets.values()].flat())
    return { owned, drawn: all.length === 0 ? none : drawMarks(all, tr.state.doc) }
  },
  // A plugin's hidden ranges are not atomic: a delete beside one takes one character, not the whole range the plugin
  // chose. Hidden marks' own, from the install, are
  provide: field => [
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

// Hidden marks over the visible ranges, built again when the text, the viewport or the parse moves
const hiddenMarksView = ViewPlugin.fromClass(class {
  drawn: Drawn

  constructor(view: EditorView) {
    this.drawn = drawMarks(hiddenMarks(view.state, view.visibleRanges), view.state.doc)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.drawn = drawMarks(hiddenMarks(update.state, update.view.visibleRanges), update.state.doc)
    }
  }
}, {
  provide: plugin => [
    EditorView.decorations.of(view => view.plugin(plugin)?.drawn.marks ?? Decoration.none),
    EditorView.decorations.of(view => view.plugin(plugin)?.drawn.hidden ?? Decoration.none),
    EditorView.atomicRanges.of(view => view.plugin(plugin)?.drawn.hidden ?? Decoration.none),
  ],
})

type Open = { view: EditorView, element: HTMLElement, instance: Instance }

export class EditorViews implements Editors {
  private readonly host: HTMLElement
  private readonly hooks: ViewHooks
  private readonly open = new Map<string, Open>()
  private readonly marksSwitch = new Compartment()
  private marksOn = false
  private shownId: string | null = null

  constructor(host: HTMLElement, hooks: ViewHooks) {
    this.host = host
    this.hooks = hooks
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
          history(),
          markdownSupport(),
          EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          Prec.lowest(EditorView.domEventHandlers({ keydown: event => this.hooks.key(id, event) })),
          // A click into a note another slot shows makes it the current one
          EditorView.domEventHandlers({
            focus: () => {
              if (this.shownId === id) return
              this.shownId = id
              this.hooks.focused?.(id)
            },
          }),
          this.marksSwitch.of(this.marksOn ? hiddenMarksView : []),
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
      apply: (changes, plugin) => view.dispatch({
        changes, annotations: [fromPlugin.of(plugin), isolateHistory.of('full')], userEvent: 'input.plugin',
      }),
      setMarks: (owner, set, marks) => view.dispatch({ effects: setMarks.of({ owner, set, marks }) }),
      clearMarks: owner => view.dispatch({ effects: clearMarks.of(owner) }),
    }
    this.open.set(id, { view, element, instance })
    this.hooks.created(instance)
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

  hiddenMarks(on: boolean): void {
    if (on === this.marksOn) return
    this.marksOn = on
    for (const open of this.open.values()) open.view.dispatch({ effects: this.marksSwitch.reconfigure(on ? hiddenMarksView : []) })
  }
}
