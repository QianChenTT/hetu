import { ChangeSet } from '@codemirror/state'
import {
  type BridgeCall, type BridgeEvent, type BridgeReply, type Mark, parseBridgeCall, refused, reply, verbNeeds,
} from '../../api/editor.ts'
import type { RefusalCode } from '../../api/envelope.ts'
import { normalKey } from './keys.ts'
import type { CoreLink } from './link.ts'
import type { Versions } from './versions.ts'

// The drawer's end of each plugin's port: the editor bridge as the editor window serves it. Main hands the page one
// port per running plugin holding a ui item, named with the plugin and its incarnation, so no plugin sets the owner of
// what arrives. Every message is text the relay in the worker host page already held to the plugin's cap and rate.
// Before serving anything about a note the drawer asks the core what the plugin reaches there, through editor.reach,
// and keeps the answers until core.security or core.status says something changed. The drawer holds no power of its
// own: a plugin reaches through it only what the gate gives that plugin

// An open note as the drawer serves it. The page's editor implements it
export type Instance = {
  readonly id: string
  readonly path: string
  readonly versions: Versions
  text(): string
  selection(): { anchor: number, head: number }[]
  // A plugin's edit as one transaction, kept apart in undo. The page's update then pushes it to versions
  apply(changes: ChangeSet, plugin: string): void
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

type Reach = { read: boolean, write: boolean, verbs: readonly string[] }
const none: Reach = Object.freeze({ read: false, write: false, verbs: Object.freeze([]) })

type Connection = {
  readonly plugin: string
  readonly incarnation: number
  readonly port: PortLike
  bindings: Map<string, string>
  keys: boolean
  // The instances it holds marks on
  readonly marked: Set<string>
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
  private readonly mac: boolean

  // mac says Mod is Cmd, as the page names keys
  constructor(link: CoreLink, instances: () => Iterable<Instance>, edited: (instance: string, plugin: string) => void, mac = false) {
    this.link = link
    this.instances = instances
    this.edited = edited
    this.mac = mac
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
    const conn: Connection = { plugin, incarnation, port, bindings: new Map(), keys: false, marked: new Set() }
    this.connections.set(plugin, conn)
    port.onmessage = event => {
      if (typeof event.data === 'string' && this.connections.get(plugin) === conn) void this.serve(conn, event.data)
    }
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

  closed(instance: string): void {
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

  // A key in the editor, named as keys.ts names it, after the core keys. The first plugin bound to it hears its command
  // and true says the key was taken. Otherwise each plugin holding the key stream that reads the note hears the key
  key(instance: string | null, key: string): boolean {
    if (CORE_KEYS.includes(key)) return false
    for (const conn of this.connections.values()) {
      const command = conn.bindings.get(key)
      if (command === undefined) continue
      conn.port.postMessage(JSON.stringify(event({ topic: 'editor.command', command, instance })))
      return true
    }
    const open = instance === null ? undefined : this.find(instance)
    if (open === undefined) return false
    for (const conn of this.connections.values()) {
      if (!conn.keys) continue
      void this.reachOf(conn.plugin, open.path).then(reach => {
        if (this.live(conn) && reach.read && reach.verbs.includes('ui.keys')) {
          conn.port.postMessage(JSON.stringify(event({ topic: 'editor.key', instance: open.id, key })))
        }
      })
    }
    return false
  }

  // Something changed what plugins may reach: ask again, and take back what a plugin no longer reaches
  forget(): void {
    this.reaches = new Map()
    for (const conn of this.connections.values()) void this.recheck(conn)
  }

  private async recheck(conn: Connection): Promise<void> {
    const held = await this.reachOf(conn.plugin)
    if (!this.live(conn)) return
    if (!held.verbs.includes('ui.command')) conn.bindings = new Map()
    if (!held.verbs.includes('ui.keys')) conn.keys = false
    for (const id of [...conn.marked]) {
      const instance = this.find(id)
      const reach = instance === undefined ? none : await this.reachOf(conn.plugin, instance.path)
      if (!this.live(conn) || (reach.read && reach.verbs.includes('ui.decoration'))) continue
      instance?.clearMarks(conn.plugin)
      conn.marked.delete(id)
    }
  }

  private drop(conn: Connection): void {
    conn.port.onmessage = null
    conn.port.close()
    for (const id of conn.marked) this.find(id)?.clearMarks(conn.plugin)
    conn.marked.clear()
    conn.bindings = new Map()
    conn.keys = false
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
      asked = this.link.call('editor.reach', path === undefined ? { plugin } : { plugin, path }).then(got => {
        if (!got.ok) return none
        const { read, write, verbs } = got.result as Reach
        return { read: read === true, write: write === true, verbs: Array.isArray(verbs) ? verbs : [] }
      }, () => none)
      this.reaches.set(key, asked)
    }
    return asked
  }

  // An event about an instance, to the plugin only when it reads the note
  private async tell(conn: Connection, instance: Instance, body: EventBody): Promise<void> {
    const reach = await this.reachOf(conn.plugin, instance.path)
    if (this.live(conn) && reach.read) conn.port.postMessage(JSON.stringify(event(body)))
  }

  private async serve(conn: Connection, text: string): Promise<void> {
    const call = parseBridgeCall(text)
    if (call === null) {
      const id = idOf(text)
      if (id !== null) this.send(conn, refused(id, 'invalid'))
      return
    }
    let answer: BridgeReply
    try {
      answer = reply(call.id, await this.answer(conn, call))
    } catch (err) {
      answer = refused(call.id, err instanceof Refusal ? err.code : 'failed')
    }
    this.send(conn, answer)
  }

  private send(conn: Connection, message: BridgeReply): void {
    if (this.live(conn)) conn.port.postMessage(JSON.stringify(message))
  }

  // What a call answers. Throws a Refusal with its code
  private async answer(conn: Connection, call: BridgeCall): Promise<unknown> {
    const needs = verbNeeds[call.verb]
    const { plugin } = conn
    if (needs.ui !== null && !(await this.reachOf(plugin)).verbs.includes(needs.ui)) throw new Refusal('not-granted')
    switch (call.verb) {
      case 'editor.instances': {
        const listed: { instance: string, path: string, version: number }[] = []
        for (const instance of this.instances()) {
          if ((await this.reachOf(plugin, instance.path)).read) listed.push({ instance: instance.id, path: instance.path, version: instance.versions.version })
        }
        return { instances: listed }
      }
      case 'editor.read': {
        const instance = await this.reached(plugin, call.args.instance, needs.write)
        return { text: instance.text(), version: instance.versions.version, selection: instance.selection() }
      }
      case 'editor.decorate': {
        const instance = await this.reached(plugin, call.args.instance, needs.write)
        const mapped = instance.versions.mapMarks(call.args.marks, call.args.version)
        if (mapped === null) throw new Refusal('stale')
        if (!this.live(conn)) throw new Refusal('stopped')
        instance.setMarks(plugin, call.args.set, mapped)
        conn.marked.add(instance.id)
        return { version: instance.versions.version }
      }
      case 'editor.edit': {
        const instance = await this.reached(plugin, call.args.instance, needs.write)
        let changes: ChangeSet
        try {
          changes = ChangeSet.fromJSON(call.args.changes)
        } catch {
          throw new Refusal('invalid')
        }
        const rebased = instance.versions.rebase(changes, call.args.version)
        if (rebased === 'stale') throw new Refusal('stale')
        if (!this.live(conn)) throw new Refusal('stopped')
        instance.apply(rebased, plugin)
        this.edited(instance.id, plugin)
        return { version: instance.versions.version }
      }
      case 'editor.bind':
        conn.bindings = new Map(call.args.bindings.map(binding => [normalKey(binding.key, this.mac), binding.command]))
        return null
      case 'editor.keys':
        conn.keys = call.args.on
        return null
    }
  }

  // The open instance, once the plugin reads its note and, for an edit, writes it
  private async reached(plugin: string, id: string, write: boolean): Promise<Instance> {
    const instance = this.find(id)
    if (instance === undefined) throw new Refusal('not-found')
    const reach = await this.reachOf(plugin, instance.path)
    if (!reach.read || (write && !reach.write)) throw new Refusal('not-granted')
    // The note may have closed while the core answered
    if (this.find(id) !== instance) throw new Refusal('not-found')
    return instance
  }
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
