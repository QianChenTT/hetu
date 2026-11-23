import { ChangeSet } from '@codemirror/state'
import {
  type BridgeCall, type BridgeEvent, type BridgeReply, type Mark, MARKS_PER_SECOND, MAX_MARK_SETS, MAX_MARKS,
  READ_CHARS_PER_SECOND, refused, reply, verbNeeds,
} from '../../api/editor.ts'
import type { RefusalCode } from '../../api/envelope.ts'
import { type DrawerCall, parseDrawerCall, type UiCall, uiNeeds } from '../../api/ui.ts'
import { normalKey } from './keys.ts'
import type { CoreLink } from './link.ts'
import type { SettingsValue } from './settings.ts'
import { type UiHooks, UiPort, UiRefusal } from './ui-port.ts'
import type { ViewBody } from './views.ts'
import type { Versions } from './versions.ts'

// The drawer's end of each plugin's port: the editor bridge as the editor window serves it. Main hands the page one
// port per running plugin holding a ui item, named with the plugin and its incarnation, so no plugin sets the owner of
// what arrives. Every message is text the relay in the worker host page already held to the plugin's cap and rate.
// Before serving anything about a note the drawer asks the core what the plugin reaches there, through gate.reach,
// and keeps the answers until core.security or core.status says something changed. The drawer holds no power of its
// own: a plugin reaches through it only what the gate gives that plugin. Views and the layout's skeleton come on the
// same port, served by UiPort

// An open note as the drawer serves it. The page's editor implements it
export type Instance = {
  readonly id: string
  readonly path: string
  readonly versions: Versions
  text(): string
  selection(): { anchor: number, head: number }[]
  // A plugin's edit as one transaction, kept apart in undo, with the cursor it places. The page's update then pushes it
  // to versions
  apply(changes: ChangeSet, plugin: string, selection?: { anchor: number, head: number }): void
  // Replaces the owner's set of that name
  setMarks(owner: string, set: string, marks: Mark[]): void
  clearMarks(owner: string): void
}

export type PortLike = {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

// The keys the drawer takes for itself before CodeMirror or any binding: the raw view, quick open, save and Quit
export const CORE_KEYS: readonly string[] = Object.freeze(['Mod-/', 'Mod-p', 'Mod-s', 'Mod-q'])
// No binding takes these: the core keys, the raw view's key where / needs Shift, and the editor's own copy, cut, paste,
// undo, redo and select all
export const RESERVED_KEYS: readonly string[] = Object.freeze([
  ...CORE_KEYS, 'Mod-Shift-/', 'Mod-c', 'Mod-x', 'Mod-v', 'Mod-z', 'Mod-y', 'Mod-Shift-z', 'Mod-a',
])

// read is the plugin's luoshu.read and uiRead its ui.read, which counts only for a note the human opened
type Reach = { read: boolean, edit: boolean, uiRead: boolean, list: boolean, verbs: readonly string[] }
const none: Reach = Object.freeze({ read: false, edit: false, uiRead: false, list: false, verbs: Object.freeze([]) })

// A range of a note's text its editor draws, in the version it was drawn at, stamped in the order the page told them
type Drawn = { version: number, from: number, to: number, stamp: number }

// The nodes one plugin's draws may have the drawer look at in a second, past which a draw answers throttled
export const NODES_PER_SECOND = 200_000
// How long after the human's key a plugin's edit may still place the cursor in answer to it
export const ANSWER_MS = 1000

const noHooks: UiHooks = { drawn() {}, changed() {}, layoutConnected() {}, post: () => 'unavailable', open: async () => {} }
const noSettings = (): SettingsValue => ({ layout: null, plain: false, theme: null, favorites: [], keyOwners: {} })

type Connection = {
  readonly plugin: string
  readonly incarnation: number
  readonly port: PortLike
  bindings: Map<string, string>
  keystream: boolean
  // Whether it asked for the range each editor draws and the stamp of the last range it was sent, by instance
  viewports: boolean
  readonly ranges: Map<string, number>
  // The instances it holds marks on
  readonly marked: Set<string>
  // How many marks each of its sets holds, by instance
  readonly sets: Map<string, Map<string, number>>
  // The instances it was told opened, so one the human opens after it connected is told once
  readonly told: Set<string>
  // What it had the drawer do in the second that started at start
  spent: { start: number, marks: number, chars: number, nodes: number }
  // The last command the human invoked through its binding, which one edit may place the cursor in answer to: its note,
  // version and selection and when the key came. Any other key, a binding changed, a refused edit with a cursor and
  // ANSWER_MS gone close it, as a move of the caret or a change does at the edit
  answering: { instance: string, version: number, selection: string, at: number } | null
}

class Refusal {
  readonly code: RefusalCode

  constructor(code: RefusalCode) {
    this.code = code
  }
}

export class Drawer {
  private readonly link: CoreLink
  private readonly instances: () => Iterable<Instance>
  private readonly edited: (instance: string, plugin: string) => void
  private readonly connections = new Map<string, Connection>()
  private reaches = new Map<string, Promise<Reach>>()
  // The instances the human opened, the only ones ui.read reaches
  private readonly human = new Set<string>()
  // The range each open instance's editor draws as the page last told it, with the version it was measured at and a
  // stamp, so a plugin is sent each range once
  private readonly viewports = new Map<string, Drawn>()
  private stamped = 0
  private readonly mac: boolean
  private readonly clock: () => number
  private readonly settings: () => SettingsValue
  readonly ui: UiPort

  // mac says Mod is Cmd, as the page names keys
  constructor(
    link: CoreLink,
    instances: () => Iterable<Instance>,
    edited: (instance: string, plugin: string) => void,
    options: { mac?: boolean, clock?: (() => number) | undefined, ui?: { settings: () => SettingsValue, hooks: UiHooks } } = {},
  ) {
    this.link = link
    this.instances = instances
    this.edited = edited
    this.mac = options.mac ?? false
    this.clock = options.clock ?? (() => performance.now())
    this.settings = options.ui?.settings ?? noSettings
    this.ui = new UiPort({
      send: (owner, body) => this.tellOwner(owner, body),
      reach: (owner, path) => this.reachOf(owner, path),
      settings: this.settings,
      hooks: options.ui?.hooks ?? noHooks,
      normal: key => normalKey(key, this.mac),
      reserved: key => RESERVED_KEYS.includes(key),
    })
  }

  // core.status comes on the shell's subscription
  start(): void {
    this.link.on('core.security', () => this.forget())
    this.link.on('core.status', () => this.forget())
    void this.link.subscribe(['core.security'])
  }

  connect(plugin: string, incarnation: number, port: PortLike): void {
    const held = this.connections.get(plugin)
    if (held !== undefined && held.incarnation > incarnation) {
      port.close()
      return
    }
    if (held !== undefined) this.drop(held)
    const conn: Connection = {
      plugin, incarnation, port, bindings: new Map(), answering: null, keystream: false, viewports: false, ranges: new Map(), marked: new Set(), sets: new Map(), told: new Set(),
      spent: { start: this.clock(), marks: 0, chars: 0, nodes: 0 },
    }
    this.connections.set(plugin, conn)
    port.onmessage = event => {
      if (typeof event.data === 'string' && this.connections.get(plugin) === conn) void this.serve(conn, event.data)
    }
    void this.reachOf(plugin).then(reach => {
      if (this.live(conn)) this.ui.held(plugin, reach.verbs)
    })
    for (const instance of this.instances()) void this.tell(conn, instance, { topic: 'editor.opened', instance: instance.id })
  }

  end(plugin: string, incarnation: number): void {
    const held = this.connections.get(plugin)
    if (held === undefined || held.incarnation !== incarnation) return
    this.drop(held)
    this.connections.delete(plugin)
  }

  opened(instance: Instance): void {
    for (const conn of this.connections.values()) void this.tell(conn, instance, { topic: 'editor.opened', instance: instance.id })
  }

  // The human opened the instance, from hetu's own palette or, with via, from a node of that plugin naming the note.
  // A note a plugin opened isn't the human's, and neither is one opened from a node of a plugin that can't read or list
  // the note itself, or a plugin could draw a button naming any note and read it through ui.read once clicked. Plugins
  // that read it only through ui.read hear of it now
  async humanOpened(instance: Instance, via?: string): Promise<void> {
    if (this.human.has(instance.id)) return
    if (via !== undefined) {
      const named = await this.reachOf(via, instance.path)
      if (!named.read && !named.list) return
    }
    if (this.find(instance.id) !== instance || this.human.has(instance.id)) return
    this.human.add(instance.id)
    for (const conn of this.connections.values()) void this.tell(conn, instance, { topic: 'editor.opened', instance: instance.id })
  }

  closed(instance: string): void {
    this.human.delete(instance)
    this.viewports.delete(instance)
    for (const conn of this.connections.values()) {
      conn.told.delete(instance)
      conn.ranges.delete(instance)
    }
    for (const conn of this.connections.values()) {
      if (!conn.marked.delete(instance)) continue
      conn.port.postMessage(JSON.stringify(event({ topic: 'editor.closed', instance })))
    }
  }

  // A change the instance applied, already pushed to its versions
  changed(instance: Instance, changes: ChangeSet): void {
    const version = instance.versions.version
    const json = changes.toJSON()
    for (const conn of this.connections.values()) {
      void this.tell(conn, instance, { topic: 'editor.changed', instance: instance.id, version, changes: json })
    }
  }

  // The editor of the instance draws another range of its text. Each plugin that asked for ranges and reads the note
  // hears it. One told of the note later hears the last range with editor.opened, one that asks later at its ask
  viewport(instance: Instance, from: number, to: number): void {
    const range = { version: instance.versions.version, from, to, stamp: ++this.stamped }
    this.viewports.set(instance.id, range)
    for (const conn of this.connections.values()) {
      if (conn.viewports) void this.tellRange(conn, instance, range)
    }
  }

  // A key in the editor, named as keys.ts names it, after the core keys. The plugin bound to it hears its command,
  // with the note's instance, the selection at the key and its version only when it reads the note. True says the key
  // was taken. A key two plugins bind goes to the one the human picked in the views menu, else to neither.
  // Otherwise each plugin holding the key stream that reads the note hears the key
  key(instance: string | null, key: string): boolean {
    if (RESERVED_KEYS.includes(key)) return false
    const open = instance === null ? undefined : this.find(instance)
    for (const conn of this.connections.values()) conn.answering = null
    const bound = [...this.connections.values()].filter(conn => conn.bindings.has(key))
    const picked = this.settings().keyOwners[key]
    const owner = bound.length === 1 ? bound[0] : bound.find(conn => conn.plugin === picked)
    if (owner !== undefined) {
      const conn = owner
      const command = conn.bindings.get(key) as string
      // Where the human was when the key came, sent once the core says the plugin reads the note
      const at = open === undefined ? undefined : { version: open.versions.version, selection: open.selection() }
      conn.answering = open === undefined || at === undefined ? null : { instance: open.id, version: at.version, selection: JSON.stringify(at.selection), at: this.clock() }
      const told = open === undefined ? Promise.resolve(none) : this.reachOf(conn.plugin, open.path)
      void told.then(reach => {
        if (!this.live(conn)) return
        const body: EventBody = open !== undefined && at !== undefined && this.readsWith(reach, open)
          ? { topic: 'editor.command', command, instance: open.id, ...at }
          : { topic: 'editor.command', command, instance: null }
        conn.port.postMessage(JSON.stringify(event(body)))
      })
      return true
    }
    if (open === undefined) return false
    for (const conn of this.connections.values()) {
      if (!conn.keystream) continue
      void this.reachOf(conn.plugin, open.path).then(reach => {
        if (this.live(conn) && this.readsWith(reach, open) && reach.verbs.includes('ui.keystream')) {
          conn.port.postMessage(JSON.stringify(event({ topic: 'editor.key', instance: open.id, key })))
        }
      })
    }
    return false
  }

  // A key while focus is in a view instance, after the core keys: the view's own binding, then the global ones
  viewKey(instance: string, key: string): boolean {
    if (RESERVED_KEYS.includes(key)) return false
    return this.ui.viewKey(instance, key) || this.key(null, key)
  }

  // The keys two plugins bind, which fire for neither until the human picks an owner
  conflicts(): { key: string, plugins: string[] }[] {
    const byKey = new Map<string, string[]>()
    for (const conn of this.connections.values()) {
      for (const key of conn.bindings.keys()) byKey.set(key, [...byKey.get(key) ?? [], conn.plugin])
    }
    return [...byKey].filter(([, plugins]) => plugins.length > 1).map(([key, plugins]) => ({ key, plugins: plugins.sort() }))
  }

  // Something changed what plugins may reach: ask again, and take back what a plugin no longer reaches
  forget(): void {
    this.reaches = new Map()
    for (const conn of this.connections.values()) void this.recheck(conn)
  }

  // A note the plugin no longer reads is forgotten as told, so once it reads the note again it hears editor.opened, reads
  // the text afresh and hears the range drawn then. A check overtaken by a newer core.security leaves told to the newer
  private async recheck(conn: Connection): Promise<void> {
    const asked = this.reaches
    const held = await this.reachOf(conn.plugin)
    if (!this.live(conn)) return
    this.ui.held(conn.plugin, held.verbs)
    if (!held.verbs.includes('ui.command')) [conn.bindings, conn.answering] = [new Map(), null]
    if (!held.verbs.includes('ui.keystream')) conn.keystream = false
    for (const id of [...conn.marked]) {
      const instance = this.find(id)
      const reach = instance === undefined ? none : await this.reachOf(conn.plugin, instance.path)
      if (!this.live(conn) || (instance !== undefined && this.readsWith(reach, instance) && reach.verbs.includes('ui.decoration'))) continue
      instance?.clearMarks(conn.plugin)
      conn.marked.delete(id)
      conn.sets.delete(id)
    }
    for (const instance of [...this.instances()]) {
      const reach = await this.reachOf(conn.plugin, instance.path)
      if (!this.live(conn) || this.reaches !== asked) return
      if (this.readsWith(reach, instance)) void this.tell(conn, instance, { topic: 'editor.opened', instance: instance.id })
      else this.untell(conn, instance.id)
    }
  }

  private untell(conn: Connection, instance: string): void {
    conn.told.delete(instance)
    conn.ranges.delete(instance)
  }

  private drop(conn: Connection): void {
    conn.port.onmessage = null
    conn.port.close()
    this.ui.ended(conn.plugin)
    for (const id of conn.marked) this.find(id)?.clearMarks(conn.plugin)
    conn.marked.clear()
    conn.sets.clear()
    conn.bindings = new Map()
    conn.keystream = false
    conn.viewports = false
    conn.ranges.clear()
  }

  private live(conn: Connection): boolean {
    return this.connections.get(conn.plugin) === conn
  }

  private find(id: string): Instance | undefined {
    for (const instance of this.instances()) if (instance.id === id) return instance
    return undefined
  }

  private reachOf(plugin: string, path?: string): Promise<Reach> {
    const key = path === undefined ? plugin : `${plugin}\u0000${path}`
    let asked = this.reaches.get(key)
    if (asked === undefined) {
      asked = this.link.call('gate.reach', path === undefined ? { plugin } : { plugin, path }).then(got => {
        if (!got.ok) return none
        const { read, edit, uiRead, list, verbs } = got.result as Reach
        return {
          read: read === true, edit: edit === true, uiRead: uiRead === true, list: list === true, verbs: Array.isArray(verbs) ? verbs : [],
        }
      }, () => none)
      this.reaches.set(key, asked)
    }
    return asked
  }

  // Whether a plugin with this reach reads the instance: its luoshu.read on the note, or its ui.read on a note the human
  // opened
  private readsWith(reach: Reach, instance: Instance): boolean {
    return reach.read || (reach.uiRead && this.human.has(instance.id))
  }

  // An event about an instance, to the plugin only when it reads the note. editor.opened goes once and brings the last
  // range the editor drew to a plugin that asked for ranges. An event held back forgets the note as told, so the plugin
  // hears editor.opened again once it reads the note: at the next check, or now when a newer core.security came while
  // the core answered
  private async tell(conn: Connection, instance: Instance, body: EventBody): Promise<void> {
    const asked = this.reaches
    const reach = await this.reachOf(conn.plugin, instance.path)
    if (!this.live(conn)) return
    if (!this.readsWith(reach, instance)) {
      this.untell(conn, instance.id)
      if (this.reaches !== asked && this.find(instance.id) === instance) void this.tell(conn, instance, { topic: 'editor.opened', instance: instance.id })
      return
    }
    if (body.topic === 'editor.opened') {
      if (conn.told.has(instance.id)) return
      conn.told.add(instance.id)
    }
    conn.port.postMessage(JSON.stringify(event(body)))
    if (body.topic === 'editor.opened') this.sendRange(conn, instance, reach, this.viewports.get(instance.id))
  }

  private async tellRange(conn: Connection, instance: Instance, range: Drawn | undefined): Promise<void> {
    this.sendRange(conn, instance, await this.reachOf(conn.plugin, instance.path), range)
  }

  // A range the instance's editor drew, to a plugin that asked for ranges, was told the note opened and reads it with
  // this reach. A range no newer than the last it was sent doesn't go, so none goes twice or out of order. The range
  // the editor still draws goes with the note's version now: the page tells each change of its ends, a change that
  // shifts them included, so changes since left it where it was. An older one goes with the version it was drawn at
  private sendRange(conn: Connection, instance: Instance, reach: Reach, range: Drawn | undefined): void {
    if (range === undefined || !this.live(conn) || !conn.viewports || !conn.told.has(instance.id)) return
    if (!this.readsWith(reach, instance) || range.stamp <= (conn.ranges.get(instance.id) ?? 0)) return
    conn.ranges.set(instance.id, range.stamp)
    const { from, to } = range
    const version = this.viewports.get(instance.id) === range ? instance.versions.version : range.version
    conn.port.postMessage(JSON.stringify(event({ topic: 'editor.viewport', instance: instance.id, version, from, to })))
  }

  // A ui event to an owner's live port
  private tellOwner(owner: string, body: ViewBody): void {
    const conn = this.connections.get(owner)
    if (conn !== undefined) conn.port.postMessage(JSON.stringify({ v: 1, kind: 'event', ...body }))
  }

  private async serve(conn: Connection, text: string): Promise<void> {
    const call = parseDrawerCall(text)
    if (call === null) {
      conn.answering = null
      const id = idOf(text)
      if (id !== null) this.send(conn, refused(id, 'invalid'))
      return
    }
    let answer: BridgeReply
    try {
      answer = reply(call.id, await this.answer(conn, call))
    } catch (err) {
      answer = refused(call.id, err instanceof Refusal || err instanceof UiRefusal ? err.code : 'failed')
    }
    this.send(conn, answer)
  }

  private send(conn: Connection, message: BridgeReply): void {
    if (this.live(conn)) conn.port.postMessage(JSON.stringify(message))
  }

  // What a call answers. Throws a Refusal with its code
  private async answer(conn: Connection, call: DrawerCall): Promise<unknown> {
    const { plugin } = conn
    if (Object.hasOwn(uiNeeds, call.verb)) {
      const item = uiNeeds[call.verb as UiCall['verb']]
      if (!(await this.reachOf(plugin)).verbs.includes(item)) throw new Refusal('not-granted')
      if (!this.live(conn)) throw new Refusal('stopped')
      // A draw is refused before it applies once the second's nodes are spent or its operations could spend the rest:
      // each may walk the whole tree. It is charged for what it looked at after
      if (call.verb === 'view.draw' || call.verb === 'layout.draw') {
        this.spend(conn, 0, 0)
        const surface = call.verb === 'layout.draw' ? 'layout' : call.args.instance
        const others = call.args.ops.filter(each => each.op !== 'tree').length
        if (conn.spent.nodes + others * this.ui.surfaces.size(plugin, surface) > NODES_PER_SECOND) throw new Refusal('throttled')
      }
      return this.ui.answer(plugin, call as UiCall, nodes => {
        conn.spent.nodes += nodes
      })
    }
    return this.answerEditor(conn, call as BridgeCall)
  }

  private async answerEditor(conn: Connection, call: BridgeCall): Promise<unknown> {
    const needs = verbNeeds[call.verb]
    const { plugin } = conn
    if (needs.ui !== null && !(await this.reachOf(plugin)).verbs.includes(needs.ui)) throw new Refusal('not-granted')
    switch (call.verb) {
      case 'editor.instances': {
        const listed: { instance: string, path: string, version: number }[] = []
        for (const instance of this.instances()) {
          if (this.readsWith(await this.reachOf(plugin, instance.path), instance)) listed.push({ instance: instance.id, path: instance.path, version: instance.versions.version })
        }
        return { instances: listed }
      }
      case 'editor.read': {
        const instance = await this.reached(plugin, call.args.instance, needs.edit)
        const text = instance.text()
        this.spend(conn, 0, text.length)
        return { text, version: instance.versions.version, selection: instance.selection() }
      }
      case 'editor.decorate': {
        const instance = await this.reached(plugin, call.args.instance, needs.edit)
        const { set, marks } = call.args
        // The plugin's sets on this note with this one replaced, held to the caps across sets
        const sets = new Map(conn.sets.get(instance.id) ?? [])
        sets.delete(set)
        if (marks.length > 0) sets.set(set, marks.length)
        const total = [...sets.values()].reduce((sum, count) => sum + count, 0)
        if (sets.size > MAX_MARK_SETS || total > MAX_MARKS) throw new Refusal('invalid')
        const mapped = instance.versions.mapMarks(marks, call.args.version)
        if (mapped === null) throw new Refusal('stale')
        if (!this.live(conn)) throw new Refusal('stopped')
        this.spend(conn, marks.length, 0)
        instance.setMarks(plugin, set, mapped)
        conn.sets.set(instance.id, sets)
        conn.marked.add(instance.id)
        return { version: instance.versions.version }
      }
      case 'editor.edit': {
        const { selection } = call.args
        const asked = selection === undefined ? null : conn.answering
        if (selection !== undefined) conn.answering = null
        const instance = await this.reached(plugin, call.args.instance, needs.edit)
        let changes: ChangeSet
        try {
          changes = ChangeSet.fromJSON(call.args.changes)
        } catch {
          throw new Refusal('invalid')
        }
        if (selection !== undefined) {
          const late = asked === null || this.clock() - asked.at > ANSWER_MS
          if (late || asked.instance !== instance.id || asked.version !== call.args.version) throw new Refusal('not-granted')
          if (instance.versions.version !== call.args.version) throw new Refusal('stale')
          if (JSON.stringify(instance.selection()) !== asked.selection) throw new Refusal('not-granted')
        }
        const rebased = instance.versions.rebase(changes, call.args.version)
        if (rebased === 'stale') throw new Refusal('stale')
        if (selection !== undefined && !within(rebased, selection)) throw new Refusal('invalid')
        if (!this.live(conn)) throw new Refusal('stopped')
        instance.apply(rebased, plugin, selection)
        this.edited(instance.id, plugin)
        return { version: instance.versions.version }
      }
      case 'editor.bind': {
        const bindings = call.args.bindings.map(binding => [normalKey(binding.key, this.mac), binding.command] as const)
        if (bindings.some(([key]) => RESERVED_KEYS.includes(key))) throw new Refusal('invalid')
        for (const each of this.connections.values()) each.answering = null
        conn.bindings = new Map(bindings)
        return null
      }
      case 'editor.keystream':
        conn.keystream = call.args.on
        return null
      // An ask sends the range each note it reads is drawn at now, one it was sent already excepted. A stop forgets what
      // was sent, so the next ask sends the ranges of then
      case 'editor.viewports':
        conn.viewports = call.args.on
        if (!call.args.on) conn.ranges.clear()
        if (call.args.on) for (const instance of this.instances()) void this.tellRange(conn, instance, this.viewports.get(instance.id))
        return null
    }
  }

  // Charges the plugin's second for marks drawn and text read, throttled past either budget or once the nodes its draws
  // looked at passed theirs. A new second starts afresh
  private spend(conn: Connection, marks: number, chars: number): void {
    const now = this.clock()
    if (now - conn.spent.start >= 1000) conn.spent = { start: now, marks: 0, chars: 0, nodes: 0 }
    const over = conn.spent.marks + marks > MARKS_PER_SECOND || conn.spent.chars + chars > READ_CHARS_PER_SECOND
    if (over || conn.spent.nodes > NODES_PER_SECOND) throw new Refusal('throttled')
    conn.spent.marks += marks
    conn.spent.chars += chars
  }

  // The open instance, once the plugin reads its note and, for an edit, holds ui.edit on it
  private async reached(plugin: string, id: string, edit: boolean): Promise<Instance> {
    const instance = this.find(id)
    if (instance === undefined) throw new Refusal('not-found')
    const reach = await this.reachOf(plugin, instance.path)
    if (!this.readsWith(reach, instance) || (edit && !reach.edit)) throw new Refusal('not-granted')
    // The note may have closed while the core answered
    if (this.find(id) !== instance) throw new Refusal('not-found')
    return instance
  }
}

// Whether a selection lies inside the range an edit changed or at its edges, in the text after the edit
function within(changes: ChangeSet, selection: { anchor: number, head: number }): boolean {
  let [from, to] = [Infinity, -Infinity]
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    ;[from, to] = [Math.min(from, fromB), Math.max(to, toB)]
  })
  return [selection.anchor, selection.head].every(pos => pos >= from && pos <= to)
}

type EventBody = BridgeEvent extends infer E ? E extends BridgeEvent ? Omit<E, 'v' | 'kind'> : never : never

function event(body: EventBody): BridgeEvent {
  return { v: 1, kind: 'event', ...body } as BridgeEvent
}

// The id of a call the drawer couldn't read, so its caller hears invalid rather than waiting
function idOf(text: string): number | null {
  try {
    const value = JSON.parse(text) as { id?: unknown } | null
    const id = value?.id
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}
