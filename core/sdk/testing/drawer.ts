import { ChangeSet, type ChangeSpec, Text } from '@codemirror/state'
import type { Capability } from '../../api/capabilities.ts'
import { type BridgeEvent, linkAt, type Mark } from '../../api/editor.ts'
import type { ViewSpec } from '../../api/manifest.ts'
import { applyOps, parseDrawerCall, type UiEvent, type UiNode } from '../../api/ui.ts'
import { DRAG_TOKEN_MS, dragTokenOf, FrameInbox, frameAsks, OpenCredit } from '../../api/ui-limits.ts'
import { Editor } from '../editor.ts'
import type { Theme } from '../frame.ts'
import type { Transport } from '../transport.ts'
import { holds } from './gate.ts'

// An editor page's drawer in memory, for a plugin's tests: the plugin's views and skeleton applied as the drawer would,
// notes the test opens served through the editor bridge, and events the test sends. A note is the human's when the
// test opens it as the human or presses a node carrying it, never when a plugin opened it with editor.open, which
// opens it in the background. A plugin reading notes through ui.read alone hears only of the human's. It holds the plugin to its
// manifest's ui items and scopes. Edits are taken only at the note's current version with no rebase and told back as
// the note's next change. Marks are kept as sent. Where the human is goes as hetu's drawer sends it: the range a note's
// editor draws only after the plugin asked with editor.viewports and only of a note it reads, each range once. A
// command goes only when the plugin bound a key to it, with the note, its version and the selection only when it reads
// the note. A change the test types goes to a plugin that reads the note as CodeMirror's change list and moves its link
// marks as hetu's drawer does. A link click goes as hetu's drawer sends it, to the plugin while it reads the note and
// holds ui.decoration. A view the manifest draws in a frame takes the worker's posts once the test mounts its frame,
// which posts to the worker as the frame's script would and keeps what the worker posted. Its open is the human's only
// right after the test says the human pressed in the frame, one open each press, as hetu's drawer counts the presses
// main pushes. A note dragged out of it opens as the human's on a drop of the token it was given, once

type Body = UiEvent extends infer E ? E extends UiEvent ? Omit<E, 'v' | 'kind'> : never : never
type EditorBody = BridgeEvent extends infer E ? E extends BridgeEvent ? Omit<E, 'v' | 'kind'> : never : never
type Selection = { anchor: number, head: number }[]
// The range the note's editor draws, stamped in the order the test moved it. It goes in the note's version when sent,
// as hetu's drawer sends the range the editor still draws
type Drawn = { from: number, to: number, stamp: number }
// human: the human opened it, so ui.read reaches it
type Note = { path: string, text: Text, version: number, drawn: Drawn, human: boolean, selection?: { anchor: number, head: number } }

// A view's frame as a test plays it. post sends data as @hetu/sdk/frame does, false when hetu's drawer would drop it.
// received is what the worker posted, oldest first, as the frame reads it. theme and onTheme are the theme as the
// frame's SDK reads it, the one changeTheme last set
export type FakeFrame = {
  post(data: unknown): boolean
  readonly received: readonly unknown[]
  theme(): Theme
  onTheme(handler: (theme: Theme) => void): void
  // The human pressed in the frame, or pressed Enter in it, so one open from the plugin's frames within
  // OPEN_GRACE_MS is theirs
  pressed(): void
  // The frame's open as @hetu/sdk/frame's: the human's after pressed, else the plugin's own in the background. Answers
  // the note's instance, null when nothing opened
  open(path: string): string | null
  // A token for dragging the note out of the frame as @hetu/sdk/frame's dragToken, null when the plugin's luoshu.read
  // doesn't reach it
  dragToken(path: string): string | null
}

// The one plugin the fake drawer serves, as the press credit names it
const SELF = 'plugin'

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
  // Notes the plugin opened itself, with editor.open or from a frame with no press behind it, each in the background
  // and never as the human's
  readonly opened: string[] = []
  readonly marks = new Map<string, Mark[]>()
  // The version each set of marks was sent for, by instance and set
  readonly versions = new Map<string, number>()
  // The verb of each call the plugin made, oldest first
  readonly calls: string[] = []
  private granted: readonly Capability[] = []
  private views: Record<string, ViewSpec> = {}
  // A note's text in the fake core's luoshu, which a note the plugin or a pressed node opens is read from
  private luoshuText: (path: string) => string | undefined = () => undefined
  private readonly trees = new Map<string, UiNode>()
  private readonly instancesOf = new Map<string, string>()
  // What the worker posted to each mounted frame
  private readonly frames = new Map<string, unknown[]>()
  // The theme the frames are offered, {} until the test changes it, and each mounted frame's way to hear a change
  private frameTheme: Theme = Object.freeze({})
  private readonly themeHeard = new Set<(theme: Theme) => void>()
  // Whether the human just pressed in one of the plugin's frames, and the drag tokens its frames were given
  private credit = new OpenCredit(() => Date.now())
  private readonly dragTokens = new Map<string, { path: string, until: number }>()
  private readonly notes = new Map<string, Note>()
  private toPlugin: ((message: unknown) => void) | null = null
  private n = 0
  // What the plugin's port asked for: ranges, with the stamp of the last range sent by instance. The commands it bound
  // a key to. A new port starts with none, as each run's does in hetu
  private asked = false
  private readonly sent = new Map<string, number>()
  private commands = new Set<string>()
  // The note and version of the last command sent with its note, which one edit may place the cursor in answer to
  private answering: { instance: string, version: number } | null = null
  private stamped = 0
  // Answers held back by verb and the code the next call of a verb is refused with
  private readonly held = new Map<string, (() => void)[]>()
  private readonly refusals = new Map<string, string>()
  // Notes the plugin sent marks for, the only ones hetu's drawer tells closed
  private readonly marked = new Set<string>()

  // A client for the next run of the plugin
  fresh(): Editor {
    this.editor = new Editor()
    this.trees.clear()
    this.instancesOf.clear()
    this.frames.clear()
    this.credit = new OpenCredit(() => Date.now())
    this.dragTokens.clear()
    return this.editor
  }

  // The fake core connects it once the plugin runs, with what its manifest declares and its luoshu's notes
  connect(granted: readonly Capability[], views: Record<string, ViewSpec>, luoshuText: (path: string) => string | undefined = () => undefined): void {
    this.granted = granted
    this.views = views
    this.luoshuText = luoshuText
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

  // The frame drawing an instance of a frame view loaded and holds its port
  mountFrame(instance: string): FakeFrame {
    const view = this.instancesOf.get(instance)
    if (view === undefined || this.views[view]?.frame === undefined) throw new Error(`no frame draws ${instance}`)
    const received: unknown[] = []
    this.frames.set(instance, received)
    const inbox = new FrameInbox(Date.now)
    let onTheme: ((theme: Theme) => void) | null = null
    this.themeHeard.add(theme => {
      if (this.frames.get(instance) === received) onTheme?.(theme)
    })
    // Asked as the frame's SDK asks, and taken as hetu's drawer takes it
    const asks = frameAsks(() => Date.now())
    const asked = (ask: object) => asks({ v: 1, ...ask })?.ok === true && this.frames.get(instance) === received
    return {
      received,
      post: data => {
        // JSON text as the frame's SDK sends it, taken as hetu's drawer takes it, and only while the plugin holds ui.view
        const taken = inbox.take(JSON.stringify(data))
        if (!taken.ok || this.frames.get(instance) !== received || !this.has('ui.view')) return false
        this.emit({ topic: 'view.message', instance, data: taken.data })
        return true
      },
      theme: () => this.frameTheme,
      onTheme: handler => {
        onTheme = handler
      },
      pressed: () => this.credit.pressed(SELF),
      open: path => {
        if (!asked({ kind: 'open', path })) return null
        if (this.credit.use(SELF)) return this.humanOpen(path)
        return this.pluginOpen(path) ? [...this.notes].find(([, held]) => held.path === path)?.[0] ?? null : null
      },
      dragToken: path => {
        if (!asked({ kind: 'drag-token', ask: 0, path }) || !holds(this.granted, { capability: 'luoshu.read', scope: { paths: [path] } })) return null
        const token = globalThis.crypto.randomUUID().replaceAll('-', '')
        this.dragTokens.set(token, { path, until: Date.now() + DRAG_TOKEN_MS })
        return token
      },
    }
  }

  // The human picked another theme: every frame is told the page's variables as hetu's drawer tells them
  changeTheme(variables: Readonly<Record<string, string>>): void {
    this.frameTheme = Object.freeze({ ...variables })
    for (const heard of this.themeHeard) heard(this.frameTheme)
  }

  // The human dropped a drag carrying this text on the editor. A token one of the plugin's frames was given opens its
  // note as the human's once, within DRAG_TOKEN_MS and while the plugin still reads the note. Answers the note's
  // instance, null when nothing opened
  drop(text: string): string | null {
    const token = dragTokenOf(text)
    const held = token === null ? undefined : this.dragTokens.get(token)
    if (token === null || held === undefined) return null
    this.dragTokens.delete(token)
    if (Date.now() > held.until || !holds(this.granted, { capability: 'luoshu.read', scope: { paths: [held.path] } })) return null
    return this.humanOpen(held.path)
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

  // A note open in the editor, which the plugin hears of when it reads the note, then the range its editor draws when
  // the plugin asked for ranges: drawn, or the whole text as the editor draws a short note. by is who opened it: the
  // human, or another plugin with editor.open, in the background
  openNote(path: string, text: string, drawn?: { from: number, to: number }, by: 'human' | 'plugin' = 'human'): string {
    const instance = `n${++this.n}`
    const doc = Text.of(text.split('\n'))
    const note: Note = {
      path, text: doc, version: 0, drawn: { from: drawn?.from ?? 0, to: drawn?.to ?? doc.length, stamp: ++this.stamped }, human: by === 'human',
    }
    this.notes.set(instance, note)
    if (!this.reads(note)) return instance
    this.tell({ topic: 'editor.opened', instance })
    this.sendRange(instance, note)
    return instance
  }

  // Whether the human opened the note, so ui.read reaches it
  isHuman(instance: string): boolean {
    return this.notes.get(instance)?.human === true
  }

  // The human clicked a node of the plugin's view, or pressed Enter on it. A node carrying a note opens that note, and
  // it counts as the human's only when the plugin reads or lists it, as hetu's drawer does, so a plugin can't name a
  // note it can't reach and read it through ui.read once clicked. Answers the note's instance, null when nothing opened
  press(instance: string, node: string): string | null {
    const found = nodeIn(this.trees.get(instance) ?? null, node)
    return found?.drag?.type === 'note' ? this.humanOpen(found.drag.value) : null
  }

  // A note the plugin opens itself, in the background as hetu's drawer opens a plugin's: by editor.open, or from a frame
  // with no press behind it. A real read only, false when refused. A note the luoshu doesn't hold opens nothing
  private pluginOpen(path: string): boolean {
    if (!holds(this.granted, { capability: 'luoshu.read', scope: { paths: [path] } })) return false
    this.opened.push(path)
    const text = this.luoshuText(path)
    if (text !== undefined && ![...this.notes.values()].some(held => held.path === path)) this.openNote(path, text, undefined, 'plugin')
    return true
  }

  // A note the human opened from the plugin's view, as hetu's drawer opens it, the human's when the plugin reads or
  // lists it
  private humanOpen(path: string): string | null {
    const reaches = holds(this.granted, { capability: 'luoshu.read', scope: { paths: [path] } })
      || holds(this.granted, { capability: 'luoshu.list', scope: { paths: [path] } })
    const open = [...this.notes].find(([, held]) => held.path === path)
    if (open === undefined) {
      const text = this.luoshuText(path)
      return text === undefined ? null : this.openNote(path, text, undefined, reaches ? 'human' : 'plugin')
    }
    const [id, held] = open
    if (held.human || !reaches) return id
    // Told once, as hetu's drawer tells each plugin of a note once
    const told = this.reads(held)
    held.human = true
    if (!told && this.reads(held)) {
      this.tell({ topic: 'editor.opened', instance: id })
      this.sendRange(id, held)
    }
    return id
  }

  // The note's editor draws another range of its text
  viewport(instance: string, from: number, to: number): void {
    const note = this.notes.get(instance)
    if (note === undefined) throw new Error(`no note ${instance} is open`)
    note.drawn = { from, to, stamp: ++this.stamped }
    this.sendRange(instance, note)
  }

  // The human pressed the key the plugin bound to the command, in the note when one is named. False when the plugin
  // bound no key to it, so nothing is sent
  command(command: string, instance?: string, selection: Selection = [{ anchor: 0, head: 0 }]): boolean {
    if (!this.commands.has(command)) return false
    const note = instance === undefined ? undefined : this.notes.get(instance)
    this.answering = null
    if (instance !== undefined && note !== undefined && this.reads(note)) {
      this.answering = { instance, version: note.version }
      this.tell({ topic: 'editor.command', command, instance, version: note.version, selection: selection.map(range => ({ ...range })) })
    } else {
      this.tell({ topic: 'editor.command', command, instance: null })
    }
    return true
  }

  // The human Ctrl+clicked, Cmd+clicked on macOS, the character at a place or the first character of the plugin's link of
  // that id. The smallest link holding it is told, none when links of two ids tie for it, as hetu's drawer picks among
  // every plugin's links. A click on no link goes on as a plain one and changes nothing. False when nothing is sent
  clickLink(instance: string, at: string | number): boolean {
    const note = this.notes.get(instance)
    if (note === undefined) throw new Error(`no note ${instance} is open`)
    // Kept as sent, so a link past the text is left out here as hetu's drawer never holds one
    const sets = new Map([...this.marks].filter(([key]) => key.startsWith(`${instance} `))
      .map(([key, marks]) => [key, marks.filter(mark => mark.kind !== 'link' || mark.to <= note.text.length)]))
    const pos = typeof at === 'number' ? at : [...sets.values()].flat().find(mark => mark.kind === 'link' && mark.id === at)?.from
    const hit = pos === undefined ? null : linkAt(new Map([['plugin', sets]]), pos)
    if (hit === null) return false
    this.answering = null
    if (hit === 'tied' || !this.has('ui.decoration') || !this.reads(note)) return false
    this.tell({ topic: 'editor.link', instance, version: note.version, id: hit.id })
    return true
  }

  // The human changed the note, its version on by one. A plugin that reads the note hears the change list unless told
  // is false, as a change lost on the way
  type(instance: string, changes: ChangeSpec, told = true): void {
    const note = this.notes.get(instance)
    if (note === undefined) throw new Error(`no note ${instance} is open`)
    this.answering = null
    const set = ChangeSet.of(changes, note.text.length)
    note.text = set.apply(note.text)
    // Its links move with the text, one whose text went dropped. Other marks stay as sent
    for (const [key, marks] of this.marks) {
      if (!key.startsWith(`${instance} `)) continue
      this.marks.set(key, marks.flatMap((mark): Mark[] => {
        if (mark.kind !== 'link') return [mark]
        const [from, to] = [set.mapPos(mark.from, 1), set.mapPos(mark.to, -1)]
        return to > from ? [{ ...mark, from, to }] : []
      }))
    }
    note.version++
    if (told && this.reads(note)) this.tell({ topic: 'editor.changed', instance, version: note.version, changes: set.toJSON() })
  }

  // The note closed in the editor, told to the plugin only when it sent marks for it
  closeNote(instance: string): void {
    if (!this.notes.delete(instance)) throw new Error(`no note ${instance} is open`)
    this.sent.delete(instance)
    if (this.marked.delete(instance)) this.tell({ topic: 'editor.closed', instance })
  }

  // Holds each answer to verb, made when the call comes, until the function returned lets them go, as a slow drawer
  delay(verb: string): () => void {
    this.held.set(verb, [])
    return () => {
      const waiting = this.held.get(verb) ?? []
      this.held.delete(verb)
      for (const send of waiting) send()
    }
  }

  // Refuses the next call of verb with code
  refuseNext(verb: string, code: string): void {
    this.refusals.set(verb, code)
  }

  // Where the plugin's last edit with a selection put the cursor
  selection(instance: string): { anchor: number, head: number } | undefined {
    return this.notes.get(instance)?.selection
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
    if (!this.asked || !this.reads(note) || note.drawn.stamp <= (this.sent.get(instance) ?? 0)) return
    this.sent.set(instance, note.drawn.stamp)
    const { from, to } = note.drawn
    this.tell({ topic: 'editor.viewport', instance, version: note.version, from, to })
  }

  // Whether the plugin reads the note: its luoshu.read on it, or its ui.read on a note the human opened
  private reads(note: Note): boolean {
    return holds(this.granted, { capability: 'luoshu.read', scope: { paths: [note.path] } })
      || (note.human && holds(this.granted, { capability: 'ui.read', scope: { paths: [note.path] } }))
  }

  private async serve(message: unknown): Promise<void> {
    const call = parseDrawerCall(JSON.stringify(message))
    const id = (message as { id?: number } | null)?.id ?? 0
    let reply: unknown
    try {
      if (call === null) throw new Refusal('invalid')
      this.calls.push(call.verb)
      const refusal = this.refusals.get(call.verb)
      if (refusal !== undefined) {
        this.refusals.delete(call.verb)
        throw new Refusal(refusal)
      }
      reply = { v: 1, kind: 'reply', id, ok: true, result: this.answer(call) }
    } catch (err) {
      reply = { v: 1, kind: 'reply', id, ok: false, refusal: { code: err instanceof Refusal ? err.code : 'failed' } }
    }
    const send = () => queueMicrotask(() => this.toPlugin?.(reply))
    const waiting = call === null ? undefined : this.held.get(call.verb)
    if (waiting === undefined) send()
    else waiting.push(send)
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
      if (!this.reads(found)) throw new Refusal('not-granted')
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
        this.frames.delete(call.args.instance)
        return null
      case 'view.title':
        need('ui.view')
        own(call.args.instance)
        return null
      case 'view.post': {
        need('ui.view')
        own(call.args.instance)
        const view = this.views[this.instancesOf.get(call.args.instance) as string]
        if (view?.frame === undefined) throw new Refusal('not-found')
        const received = this.frames.get(call.args.instance)
        if (received === undefined) throw new Refusal('unavailable')
        // Taken from JSON text already, as the frame reads it. Nothing reaches a frame as nothing
        if (call.args.data !== undefined) received.push(call.args.data)
        return null
      }
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
        if (!this.pluginOpen(call.args.path)) throw new Refusal('not-granted')
        return null
      }
      case 'editor.instances':
        return { instances: [...this.notes].filter(([, held]) => this.reads(held)).map(([instance, held]) => ({ instance, path: held.path, version: held.version })) }
      case 'editor.read': {
        const held = note(call.args.instance)
        return { text: held.text.toString(), version: held.version, selection: [{ anchor: 0, head: 0 }] }
      }
      case 'editor.edit': {
        const held = note(call.args.instance)
        if (!holds(this.granted, { capability: 'ui.edit', scope: { paths: [held.path] } })) throw new Refusal('not-granted')
        const { selection } = call.args
        const asked = this.answering
        if (selection !== undefined) this.answering = null
        if (selection !== undefined && (asked?.instance !== call.args.instance || asked.version !== call.args.version)) throw new Refusal('not-granted')
        if (call.args.version !== held.version) throw new Refusal('stale')
        let changes: ChangeSet
        try {
          changes = ChangeSet.fromJSON(call.args.changes)
          if (changes.length !== held.text.length) throw new Error('another length')
        } catch {
          throw new Refusal('invalid')
        }
        // The cursor inside the range the edit changed or at its edges, as hetu's drawer takes it
        const ends: number[] = []
        changes.iterChangedRanges((_fromA, _toA, fromB, toB) => void ends.push(fromB, toB))
        if (selection !== undefined && ![selection.anchor, selection.head].every(pos => pos >= Math.min(...ends) && pos <= Math.max(...ends))) {
          throw new Refusal('invalid')
        }
        held.text = changes.apply(held.text)
        if (selection !== undefined) held.selection = { anchor: selection.anchor, head: selection.head }
        held.version++
        this.tell({ topic: 'editor.changed', instance: call.args.instance, version: held.version, changes: changes.toJSON() })
        return { version: held.version }
      }
      case 'editor.decorate': {
        need('ui.decoration')
        const held = note(call.args.instance)
        this.marks.set(`${call.args.instance} ${call.args.set}`, call.args.marks)
        this.versions.set(`${call.args.instance} ${call.args.set}`, call.args.version)
        this.marked.add(call.args.instance)
        return { version: held.version }
      }
      case 'editor.bind':
        need('ui.command')
        this.commands = new Set(call.args.bindings.map(binding => binding.command))
        return null
      case 'editor.keystream':
        need('ui.keystream')
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

// The node of that id in a tree, null when none
function nodeIn(tree: UiNode | null, id: string): UiNode | null {
  if (tree === null) return null
  if (tree.id === id) return tree
  const kids = 'children' in tree ? tree.children ?? [] : tree.kind === 'list' ? tree.rows : []
  for (const kid of kids) {
    const found = nodeIn(kid, id)
    if (found !== null) return found
  }
  return null
}
