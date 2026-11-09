import type { RefusalCode } from '../../api/envelope.ts'
import type { LayoutState, NodeEventType, Payload, UiCall } from '../../api/ui.ts'
import { Surfaces } from './surfaces.ts'
import type { SettingsValue } from './settings.ts'
import { type ViewBody, ViewList } from './views.ts'

// The ui half of each plugin's port to the drawer: views drawn by their owners and the skeleton of the layout the human
// picked. The Drawer reads every message, checks the plugin holds the item the verb needs and hands the call here with
// the owner main named. Every event the human makes goes to the owner of the surface it happened in and no other

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
  // A frame view's message from its owner's worker
  post(owner: string, instance: string, data: unknown): RefusalCode | null
  // Opens a note in the editor with the window's own read, once the plugin's reach was checked
  open(path: string): Promise<void>
}

export type UiReach = { read: boolean, list: boolean, verbs: readonly string[] }

// The id hetu's own layout has, picked when the human picked none
export const OWN_LAYOUT = 'layout'
// The surface a layout draws its skeleton on
export const SKELETON = 'layout'

type Options = {
  send(owner: string, body: ViewBody): void
  reach(owner: string, path: string): Promise<UiReach>
  settings(): SettingsValue
  hooks: UiHooks
  // A binding's key as the page names keys, and whether the drawer keeps it for itself
  normal(key: string): string
  reserved(key: string): boolean
}

export class UiPort {
  readonly surfaces = new Surfaces()
  readonly views: ViewList
  private readonly options: Options
  // Owners connected holding ui.view, holding ui.layout
  private readonly viewers = new Set<string>()
  private readonly layouts = new Set<string>()
  private readonly bindings = new Map<string, Map<string, string>>()
  private current: string | null = null
  private lastState = ''

  constructor(options: Options) {
    this.options = options
    this.views = new ViewList((owner, body) => options.send(owner, body))
  }

  // The layout drawing the window: the human's pick, else hetu's own, while it is connected holding ui.layout. Null
  // means the drawer's plain layout
  layout(): string | null {
    return this.current
  }

  // The layout whose skeleton draws the window: the picked one once it sent a skeleton. Until then, and when it can't,
  // the drawer draws its plain layout, so a layout that hangs or whose skeleton is refused never leaves a blank window
  drawing(): string | null {
    return this.current !== null && this.surfaces.tree(this.current, SKELETON) !== null ? this.current : null
  }

  // The connected plugins the human can pick as the layout
  layoutChoices(): string[] {
    return [...this.layouts].sort()
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
    if (verbs.includes('ui.layout')) this.layouts.add(owner)
    else {
      this.layouts.delete(owner)
      this.surfaces.dropSurface(owner, SKELETON)
    }
    this.settingsChanged()
  }

  ended(owner: string): void {
    this.viewers.delete(owner)
    this.layouts.delete(owner)
    this.dropViews(owner)
    this.surfaces.drop(owner)
    this.settingsChanged()
  }

  // The human picked another layout, or none
  settingsChanged(): void {
    const settings = this.options.settings()
    const wanted = settings.layout ?? OWN_LAYOUT
    const next = !settings.plain && this.layouts.has(wanted) ? wanted : null
    if (next === this.current) return
    this.current = next
    this.lastState = ''
    this.options.hooks.changed()
  }

  // What the layout plans from. Sent only when it changed since the last
  state(state: LayoutState): void {
    if (this.current === null) return
    const text = JSON.stringify(state)
    if (text === this.lastState) return
    this.lastState = text
    this.options.send(this.current, { topic: 'layout.state', state })
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
        return null
      }
      case 'layout.draw': {
        if (this.current !== owner) throw new UiRefusal('not-granted')
        const applied = this.surfaces.apply(owner, SKELETON, call.args.ops, true)
        if ('refusal' in applied) throw new UiRefusal(applied.refusal)
        spend(applied.visited)
        this.options.hooks.drawn(owner, SKELETON)
        return null
      }
      case 'editor.open': {
        // Asked before anything is read, so opening never tells a plugin whether a note it can't name exists
        const reach = await this.options.reach(owner, call.args.path)
        if (!reach.read && !reach.list) throw new UiRefusal('not-granted')
        await this.options.hooks.open(call.args.path)
        return null
      }
    }
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
      if (owner === this.current) this.options.send(owner, { topic: 'layout.event', node, type, ...extra })
      return
    }
    if (this.views.owner(surface) === owner && this.viewers.has(owner)) this.options.send(owner, { topic: 'view.event', instance: surface, node, type, ...extra })
  }

  // A split the human resized, to its owner
  resized(owner: string, surface: string, node: string, sizes: number[]): void {
    if (surface === SKELETON) {
      if (owner === this.current) this.options.send(owner, { topic: 'layout.resized', node, sizes })
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
    if (this.current !== null && this.views.get(instance) !== null) this.options.send(this.current, { topic: 'layout.drop', instance, zone, x, y })
  }

  // The human asked from the views menu for a view to show, or to go
  openView(instance: string): void {
    if (this.current !== null && this.views.get(instance) !== null) this.options.send(this.current, { topic: 'layout.open', instance })
  }

  closeView(instance: string): void {
    if (this.current !== null && this.views.get(instance) !== null) this.options.send(this.current, { topic: 'layout.close', instance })
  }

  private own(owner: string, instance: string): void {
    const found = this.views.owner(instance)
    if (found === null) throw new UiRefusal('not-found')
    if (found !== owner) throw new UiRefusal('not-granted')
  }

  private dropViews(owner: string): void {
    for (const held of this.views.all()) if (held.owner === owner) this.surfaces.dropSurface(owner, held.instance)
    this.bindings.delete(owner)
    this.views.ended(owner)
    this.options.hooks.changed()
  }
}
