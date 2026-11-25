import type { RefusalCode } from '../../api/envelope.ts'
import type { LayoutState, NodeEventType, Payload, UiCall, UiNode } from '../../api/ui.ts'
import type { Arrangement } from './layout/arrange.ts'
import { type Layout, startLayout } from './layout/layout.ts'
import { Surfaces } from './surfaces.ts'
import { type ViewBody, ViewList } from './views.ts'

// The ui half of each plugin's port to the drawer: views drawn by their owners, placed by the drawer's own layout. The
// Drawer reads every message, checks the plugin holds the item the verb needs and hands the call here with the owner
// main named. Every event the human makes goes to the owner of the surface it happened in and no other, the
// skeleton's to the layout

export class UiRefusal {
  readonly code: RefusalCode

  constructor(code: RefusalCode) {
    this.code = code
  }
}

// What the page does with what plugins send
export type UiHooks = {
  // A surface changed: draw it again
  drawn(owner: string, surface: string): void
  // Views came or went, or the layout drawing the window changed
  changed(): void
  // The layout's arrangement changed, to keep in the window's settings
  arranged(arrangement: Arrangement): void
  // A frame view's message from its owner's worker
  post(owner: string, instance: string, data: unknown): RefusalCode | null
  // Opens a note in the editor with the window's own read, once the plugin's reach was checked on the path it named.
  // reads says whether the plugin reads the path the luoshu resolved, and a no opens nothing
  open(path: string, reads: (resolved: string) => Promise<boolean>): Promise<void>
}

export type UiReach = { read: boolean, list: boolean, verbs: readonly string[] }

// The surface a layout draws its skeleton on
export const SKELETON = 'layout'
// The owner the drawer's own layout draws its skeleton under: hetu, which no plugin id can be
export const LAYOUT_OWNER = 'hetu'

type Options = {
  send(owner: string, body: ViewBody): void
  reach(owner: string, path: string): Promise<UiReach>
  hooks: UiHooks
  // A binding's key as the page names keys, and whether the drawer keeps it for itself
  normal(key: string): string
  reserved(key: string): boolean
}

export class UiPort {
  readonly surfaces = new Surfaces()
  readonly views: ViewList
  private readonly options: Options
  private readonly layout: Layout
  // Owners connected holding ui.view
  private readonly viewers = new Set<string>()
  private readonly bindings = new Map<string, Map<string, string>>()
  private lastState = ''
  // Told the keys an owner's views bound, named the page's way, each time they change
  onBindings: ((owner: string, keys: string[]) => void) | null = null

  constructor(options: Options) {
    this.options = options
    this.views = new ViewList((owner, body) => options.send(owner, body))
    this.layout = startLayout({ draw: tree => this.drawSkeleton(tree), save: arrangement => options.hooks.arranged(arrangement) })
  }

  // The owner of the skeleton drawing the window, once the layout drew one. Until then, and when it can't, the drawer
  // draws its plain layout, so a layout that throws or whose skeleton is refused never leaves a blank window
  drawing(): string | null {
    return this.surfaces.tree(LAYOUT_OWNER, SKELETON) !== null ? LAYOUT_OWNER : null
  }

  // The arrangement the window's settings held, which the layout draws from
  arrangementLoaded(saved: unknown): void {
    this.arrange(layout => layout.loaded(saved))
  }

  // The owner's port came, or what it holds changed. What it no longer holds is taken back
  held(owner: string, verbs: readonly string[]): void {
    const view = verbs.includes('ui.view')
    if (view && !this.viewers.has(owner)) {
      this.viewers.add(owner)
      this.views.connected(owner, true)
      this.options.hooks.changed()
    } else if (!view && this.viewers.has(owner)) {
      this.viewers.delete(owner)
      this.dropViews(owner)
    }
  }

  ended(owner: string): void {
    this.viewers.delete(owner)
    this.dropViews(owner)
    this.surfaces.drop(owner)
  }

  // What the layout plans from. Handed on only when it changed since the last
  state(state: LayoutState): void {
    const text = JSON.stringify(state)
    if (text === this.lastState) return
    this.lastState = text
    this.arrange(layout => layout.state(state))
  }

  // A call the Drawer read and checked the item of. spend charges the nodes a draw looked at to the plugin's second
  async answer(owner: string, call: UiCall, spend: (nodes: number) => void): Promise<unknown> {
    switch (call.verb) {
      case 'view.open': {
        const opened = this.views.open(owner, call.args.view)
        if (!opened.startsWith('v')) throw new UiRefusal(opened as RefusalCode)
        this.options.hooks.changed()
        // An owner asking for a view is the layout's to place
        this.openView(opened)
        return { instance: opened }
      }
      case 'view.close': {
        this.own(owner, call.args.instance)
        this.views.close(owner, call.args.instance)
        this.surfaces.dropSurface(owner, call.args.instance)
        this.options.hooks.changed()
        return null
      }
      case 'view.title': {
        this.own(owner, call.args.instance)
        this.views.title(owner, call.args.instance, call.args.title)
        this.options.hooks.drawn(owner, call.args.instance)
        return null
      }
      case 'view.draw': {
        this.own(owner, call.args.instance)
        const applied = this.surfaces.apply(owner, call.args.instance, call.args.ops, false)
        if ('refusal' in applied) throw new UiRefusal(applied.refusal)
        spend(applied.visited)
        this.options.hooks.drawn(owner, call.args.instance)
        return null
      }
      case 'view.post': {
        this.own(owner, call.args.instance)
        const refusal = this.options.hooks.post(owner, call.args.instance, call.args.data)
        if (refusal !== null) throw new UiRefusal(refusal)
        return null
      }
      case 'view.bind': {
        const bound = call.args.bindings.map(binding => [this.options.normal(binding.key), binding.command] as const)
        if (bound.some(([key]) => this.options.reserved(key))) throw new UiRefusal('invalid')
        this.bindings.set(owner, new Map(bound))
        this.onBindings?.(owner, bound.map(([key]) => key))
        return null
      }
      case 'editor.open':
        await this.pluginOpen(owner, call.args.path)
        return null
    }
  }

  // A note the plugin opens itself, in the background and never as the human's: by its worker's editor.open, or from
  // one of its frames with no press of the human's behind it
  async pluginOpen(owner: string, path: string): Promise<void> {
    // Asked before anything is read, so opening never tells a plugin whether a note it can't name exists
    const reach = await this.options.reach(owner, path)
    // A real read only, so a note a plugin opens is never one ui.read reaches through a list grant or its own
    if (!reach.read) throw new UiRefusal('not-granted')
    // And on where the note is, so a spelling through a link into a folder the plugin can't read opens nothing. It
    // answers as an open whose read failed does, so the plugin can't tell whether a note is there
    await this.options.hooks.open(path, this.resolvedReads(owner))
  }

  // Whether the plugin's own read reaches the path the luoshu resolved a note it named to
  resolvedReads(owner: string): (resolved: string) => Promise<boolean> {
    return async resolved => (await this.options.reach(owner, resolved)).read
  }

  // A key while focus is in a view instance: its owner's own binding, true when one took it
  viewKey(instance: string, key: string): boolean {
    const owner = this.views.owner(instance)
    const command = owner === null ? undefined : this.bindings.get(owner)?.get(key)
    if (owner === null || command === undefined || !this.viewers.has(owner)) return false
    this.options.send(owner, { topic: 'view.command', instance, command })
    return true
  }

  // What the human did to a node, to the owner of the surface it is in
  nodeEvent(owner: string, surface: string, node: string, type: NodeEventType, value?: string | boolean, payload?: Payload): void {
    const extra = { ...(value === undefined ? {} : { value }), ...(payload === undefined ? {} : { payload }) }
    if (surface === SKELETON) {
      if (owner === LAYOUT_OWNER) this.arrange(layout => layout.event(node, type))
      return
    }
    if (this.views.owner(surface) === owner && this.viewers.has(owner)) this.options.send(owner, { topic: 'view.event', instance: surface, node, type, ...extra })
  }

  // A split the human resized, to its owner
  resized(owner: string, surface: string, node: string, sizes: number[]): void {
    if (surface === SKELETON) {
      if (owner === LAYOUT_OWNER) this.arrange(layout => layout.resized(node, sizes))
      return
    }
    if (this.views.owner(surface) === owner) this.options.send(owner, { topic: 'view.resized', instance: surface, node, sizes })
  }

  // What a view's frame sent, to the frame's owner's worker
  frameMessage(owner: string, instance: string, data: unknown): void {
    if (this.views.owner(instance) === owner && this.viewers.has(owner)) this.options.send(owner, { topic: 'view.message', instance, data })
  }

  // A view the human dragged onto one of the layout's zones, x and y where in the zone from 0 to 1
  viewDropped(instance: string, zone: string, x: number, y: number): void {
    if (this.views.get(instance) !== null) this.arrange(layout => layout.drop(instance, zone, x, y))
  }

  // The human asked from the views menu for a view to show, or to go
  openView(instance: string): void {
    if (this.views.get(instance) !== null) this.arrange(layout => layout.open(instance))
  }

  closeView(instance: string): void {
    if (this.views.get(instance) !== null) this.arrange(layout => layout.close(instance))
  }

  // A call into the layout. One that throws, or draws a skeleton the tree's check refuses, is logged as the page logs a
  // failed handler and leaves the plain layout drawing until the layout draws again
  private arrange(act: (layout: Layout) => void): void {
    try {
      act(this.layout)
    } catch (err) {
      console.error('the layout failed, the plain layout draws until it draws again', err)
      this.surfaces.dropSurface(LAYOUT_OWNER, SKELETON)
      this.options.hooks.changed()
    }
  }

  // The skeleton under the drawer's own owner, checked as a layout's tree is
  private drawSkeleton(tree: UiNode): void {
    const applied = this.surfaces.apply(LAYOUT_OWNER, SKELETON, [{ op: 'tree', root: tree }], true)
    if ('refusal' in applied) throw new Error(applied.problem)
    this.options.hooks.drawn(LAYOUT_OWNER, SKELETON)
  }

  private own(owner: string, instance: string): void {
    const found = this.views.owner(instance)
    if (found === null) throw new UiRefusal('not-found')
    if (found !== owner) throw new UiRefusal('not-granted')
  }

  private dropViews(owner: string): void {
    for (const held of this.views.all()) if (held.owner === owner) this.surfaces.dropSurface(owner, held.instance)
    if (this.bindings.delete(owner)) this.onBindings?.(owner, [])
    this.views.ended(owner)
    this.options.hooks.changed()
  }
}
