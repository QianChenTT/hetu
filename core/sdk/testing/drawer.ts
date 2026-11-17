import { ChangeSet, Text } from '@codemirror/state'
import type { Capability } from '../../api/capabilities.ts'
import type { BridgeEvent, Mark } from '../../api/editor.ts'
import type { ViewSpec } from '../../api/manifest.ts'
import { applyOps, parseDrawerCall, type UiEvent, type UiNode } from '../../api/ui.ts'
import { Editor } from '../editor.ts'
import type { Transport } from '../transport.ts'
import { holds } from './gate.ts'

// An editor page's drawer in memory, for a plugin's tests: the plugin's views and skeleton applied as the drawer would,
// notes the test opens served through the editor bridge, and events the test sends. It holds the plugin to its
// manifest's ui items and scopes. Edits are taken only at the note's current version, with no rebase, and marks are
// kept as sent. Where the human is goes as hetu's drawer sends it: the range a note's editor draws only after the
// plugin asked with editor.viewports and only of a note it reads, each range once. A command goes only when the plugin
// bound a key to it, with the note, its version and the selection only when it reads the note

type Body = UiEvent extends infer E ? E extends UiEvent ? Omit<E, 'v' | 'kind'> : never : never
type EditorBody = BridgeEvent extends infer E ? E extends BridgeEvent ? Omit<E, 'v' | 'kind'> : never : never
type Selection = { anchor: number, head: number }[]
// The range the note's editor draws, in the version it was drawn at, stamped in the order the test moved it
type Drawn = { version: number, from: number, to: number, stamp: number }
type Note = { path: string, text: Text, version: number, drawn: Drawn }

class Refusal {
  readonly code: string

  constructor(code: string) {
    this.code = code
  }
}

export class FakeDrawer {
  // The client the plugin's ctx.editor and ctx.ui use, which the fake core hands to each run of the plugin anew, so a
  // stopped run's handlers hear nothing
  editor = new Editor()
  // Notes the plugin opened with editor.open
  readonly opened: string[] = []
  readonly marks = new Map<string, Mark[]>()
  private granted: readonly Capability[] = []
  private views: Record<string, ViewSpec> = {}
  private readonly trees = new Map<string, UiNode>()
  private readonly instancesOf = new Map<string, string>()
  private readonly notes = new Map<string, Note>()
  private toPlugin: ((message: unknown) => void) | null = null
  private n = 0
  // What the plugin's port asked for: ranges, with the stamp of the last range sent by instance. The commands it bound
  // a key to. A new port starts with none, as each run's does in hetu
  private asked = false
  private readonly sent = new Map<string, number>()
  private commands = new Set<string>()
  private stamped = 0

  // A client for the next run of the plugin
  fresh(): Editor {
    this.editor = new Editor()
    this.trees.clear()
    this.instancesOf.clear()
    return this.editor
  }

  // The fake core connects it once the plugin runs, with what its manifest declares
  connect(granted: readonly Capability[], views: Record<string, ViewSpec>): void {
    this.granted = granted
    this.views = views
    this.asked = false
    this.sent.clear()
    this.commands = new Set()
    const transport: Transport = {
      post: message => void this.serve(message),
      listen: next => {
        this.toPlugin = next
      },
    }
    this.editor.connect(transport)
    if (!this.has('ui.view')) return
    for (const view of Object.keys(views)) {
      const instance = `v${++this.n}`
      this.instancesOf.set(instance, view)
      this.emit({ topic: 'view.opened', instance, view })
    }
  }

  // An event from the drawer to the plugin
  emit(body: Body): void {
    const message = { v: 1, kind: 'event', ...body }
    queueMicrotask(() => this.toPlugin?.(message))
  }

  tree(surface: string): UiNode | null {
    return this.trees.get(surface) ?? null
  }

  instances(): { instance: string, view: string }[] {
    return [...this.instancesOf].map(([instance, view]) => ({ instance, view }))
  }

  // A note open in the editor, which the plugin hears of when it reads the path, then the range its editor draws when
  // the plugin asked for ranges: drawn, or the whole text as the editor draws a short note
  openNote(path: string, text: string, drawn?: { from: number, to: number }): string {
    const instance = `n${++this.n}`
    const doc = Text.of(text.split('\n'))
    const note: Note = { path, text: doc, version: 0, drawn: { version: 0, from: drawn?.from ?? 0, to: drawn?.to ?? doc.length, stamp: ++this.stamped } }
    this.notes.set(instance, note)
    if (!this.reads(path)) return instance
    this.tell({ topic: 'editor.opened', instance })
    this.sendRange(instance, note)
    return instance
  }

  // The note's editor draws another range of its text, counted in the note's version now
  viewport(instance: string, from: number, to: number): void {
    const note = this.notes.get(instance)
    if (note === undefined) throw new Error(`no note ${instance} is open`)
    note.drawn = { version: note.version, from, to, stamp: ++this.stamped }
    this.sendRange(instance, note)
  }

  // The human pressed the key the plugin bound to the command, in the note when one is named. False when the plugin
  // bound no key to it, so nothing is sent
  command(command: string, instance?: string, selection: Selection = [{ anchor: 0, head: 0 }]): boolean {
    if (!this.commands.has(command)) return false
    const note = instance === undefined ? undefined : this.notes.get(instance)
    if (instance !== undefined && note !== undefined && this.reads(note.path)) {
      this.tell({ topic: 'editor.command', command, instance, version: note.version, selection: selection.map(range => ({ ...range })) })
    } else {
      this.tell({ topic: 'editor.command', command, instance: null })
    }
    return true
  }

  text(instance: string): string | null {
    return this.notes.get(instance)?.text.toString() ?? null
  }

  private has(item: string): boolean {
    return this.granted.some(granted => granted.type === item)
  }

  private tell(body: EditorBody): void {
    const message = { v: 1, kind: 'event', ...body }
    queueMicrotask(() => this.toPlugin?.(message))
  }

  // The note's range, to a plugin that asked for ranges and reads the note, unless it was sent that range already
  private sendRange(instance: string, note: Note): void {
    if (!this.asked || !this.reads(note.path) || note.drawn.stamp <= (this.sent.get(instance) ?? 0)) return
    this.sent.set(instance, note.drawn.stamp)
    const { version, from, to } = note.drawn
    this.tell({ topic: 'editor.viewport', instance, version, from, to })
  }

  // Every note the test opens is the human's, so ui.read reaches it as hetu's drawer would
  private reads(path: string): boolean {
    return holds(this.granted, { capability: 'luoshu.read', scope: { paths: [path] } })
      || holds(this.granted, { capability: 'ui.read', scope: { paths: [path] } })
  }

  private async serve(message: unknown): Promise<void> {
    const call = parseDrawerCall(JSON.stringify(message))
    const id = (message as { id?: number } | null)?.id ?? 0
    let reply: unknown
    try {
      if (call === null) throw new Refusal('invalid')
      reply = { v: 1, kind: 'reply', id, ok: true, result: this.answer(call) }
    } catch (err) {
      reply = { v: 1, kind: 'reply', id, ok: false, refusal: { code: err instanceof Refusal ? err.code : 'failed' } }
    }
    queueMicrotask(() => this.toPlugin?.(reply))
  }

  private answer(call: NonNullable<ReturnType<typeof parseDrawerCall>>): unknown {
    const need = (item: string) => {
      if (!this.has(item)) throw new Refusal('not-granted')
    }
    const own = (instance: string) => {
      if (!this.instancesOf.has(instance)) throw new Refusal('not-found')
    }
    const note = (instance: string) => {
      const found = this.notes.get(instance)
      if (found === undefined) throw new Refusal('not-found')
      if (!this.reads(found.path)) throw new Refusal('not-granted')
      return found
    }
    switch (call.verb) {
      case 'view.open': {
        need('ui.view')
        if (!Object.hasOwn(this.views, call.args.view)) throw new Refusal('not-found')
        const instance = `v${++this.n}`
        this.instancesOf.set(instance, call.args.view)
        return { instance }
      }
      case 'view.close':
        need('ui.view')
        own(call.args.instance)
        this.instancesOf.delete(call.args.instance)
        this.trees.delete(call.args.instance)
        return null
      case 'view.title':
      case 'view.post':
        need('ui.view')
        own(call.args.instance)
        return null
      case 'view.bind':
        need('ui.view')
        return null
      case 'view.draw':
        need('ui.view')
        own(call.args.instance)
        return this.draw(call.args.instance, call.args.ops, false)
      case 'layout.draw':
        need('ui.layout')
        return this.draw('layout', call.args.ops, true)
      case 'editor.open': {
        need('ui.view')
        const { path } = call.args
        // A real read only, as hetu's drawer asks
        if (!holds(this.granted, { capability: 'luoshu.read', scope: { paths: [path] } })) throw new Refusal('not-granted')
        this.opened.push(path)
        return null
      }
      case 'editor.instances':
        return { instances: [...this.notes].filter(([, held]) => this.reads(held.path)).map(([instance, held]) => ({ instance, path: held.path, version: held.version })) }
      case 'editor.read': {
        const held = note(call.args.instance)
        return { text: held.text.toString(), version: held.version, selection: [{ anchor: 0, head: 0 }] }
      }
      case 'editor.edit': {
        const held = note(call.args.instance)
        if (!holds(this.granted, { capability: 'ui.edit', scope: { paths: [held.path] } })) throw new Refusal('not-granted')
        if (call.args.version !== held.version) throw new Refusal('stale')
        let changes: ChangeSet
        try {
          changes = ChangeSet.fromJSON(call.args.changes)
          held.text = changes.apply(held.text)
        } catch {
          throw new Refusal('invalid')
        }
        held.version++
        return { version: held.version }
      }
      case 'editor.decorate': {
        need('ui.decoration')
        const held = note(call.args.instance)
        this.marks.set(`${call.args.instance} ${call.args.set}`, call.args.marks)
        return { version: held.version }
      }
      case 'editor.bind':
        need('ui.command')
        this.commands = new Set(call.args.bindings.map(binding => binding.command))
        return null
      case 'editor.keys':
        need('ui.keys')
        return null
      // An ask sends the range of each note the plugin reads, one sent already excepted. A stop forgets what was sent
      case 'editor.viewports':
        this.asked = call.args.on
        if (!call.args.on) this.sent.clear()
        for (const [instance, note] of this.notes) this.sendRange(instance, note)
        return null
    }
  }

  private draw(surface: string, ops: Parameters<typeof applyOps>[1], layout: boolean): null {
    const applied = applyOps(this.trees.get(surface) ?? null, ops, { layout })
    if ('problem' in applied) throw new Refusal('invalid')
    this.trees.set(surface, applied.tree)
    return null
  }
}
