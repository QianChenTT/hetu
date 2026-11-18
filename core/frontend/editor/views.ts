import type { CoreViewsPlugin } from '../../api/actions.ts'
import type { RefusalCode } from '../../api/envelope.ts'
import type { ViewSpec } from '../../api/manifest.ts'
import { type LayoutView, MAX_SURFACES, type UiEvent } from '../../api/ui.ts'

// The view instances the drawer holds. A view is declared in its plugin's manifest, so the drawer opens each one's
// first instance once its owner connects holding ui.view, and the owner opens more. Ids are the drawer's, v and a
// number. A crashed owner's first instances stay in place, down, so the screen doesn't rearrange itself, and come up
// again when it connects. A title set while running reaches the drawer only, never the layout

export type ViewBody = UiEvent extends infer E ? E extends UiEvent ? Omit<E, 'v' | 'kind'> : never : never

export type ViewInstance = {
  readonly instance: string
  readonly owner: string
  readonly view: string
  readonly first: boolean
  spec: ViewSpec
  runtimeTitle: string | null
  down: boolean
  size: { width: number, height: number } | null
}

export class ViewList {
  private readonly tell: (owner: string, event: ViewBody) => void
  private declaredBy = new Map<string, CoreViewsPlugin>()
  private readonly instances = new Map<string, ViewInstance>()
  private readonly up = new Set<string>()
  private n = 0

  constructor(tell: (owner: string, event: ViewBody) => void) {
    this.tell = tell
  }

  // What core.views says now. An instance whose view its owner no longer declares closes
  declared(plugins: readonly CoreViewsPlugin[]): void {
    this.declaredBy = new Map(plugins.map(plugin => [plugin.plugin, plugin]))
    for (const held of [...this.instances.values()]) {
      const spec = this.specOf(held.owner, held.view)
      if (spec === null) this.remove(held, true)
      else held.spec = spec
    }
    // An owner whose port came before its views were known, or that declares a new one, gets its first instances now
    for (const owner of this.up) this.openFirst(owner, true)
  }

  // The owner's port came. Without ui.view it draws no view
  connected(owner: string, canView: boolean): void {
    if (!canView) return
    this.up.add(owner)
    this.openFirst(owner, false)
  }

  // The first instance of each view the owner declares, told to it. A port that came again hears of those it had too
  private openFirst(owner: string, onlyNew: boolean): void {
    for (const view of Object.keys(this.declaredBy.get(owner)?.views ?? {})) {
      const spec = this.specOf(owner, view) as ViewSpec
      let held = [...this.instances.values()].find(each => each.owner === owner && each.view === view && each.first)
      if (held !== undefined && onlyNew) continue
      if (held === undefined) {
        held = { instance: `v${++this.n}`, owner, view, first: true, spec, runtimeTitle: null, down: false, size: null }
        this.instances.set(held.instance, held)
      }
      held.down = false
      held.size = null
      this.tell(owner, { topic: 'view.opened', instance: held.instance, view })
    }
  }

  // The owner's port ended: its first instances stay down, the rest close
  ended(owner: string): void {
    this.up.delete(owner)
    for (const held of [...this.instances.values()]) {
      if (held.owner !== owner) continue
      if (held.first) {
        held.down = true
        held.size = null
      } else {
        this.remove(held, false)
      }
    }
  }

  open(owner: string, view: string): string | RefusalCode {
    if (!this.up.has(owner)) return 'not-granted'
    const spec = this.specOf(owner, view)
    if (spec === null) return 'not-found'
    if ([...this.instances.values()].filter(each => each.owner === owner).length >= MAX_SURFACES - 1) return 'invalid'
    const held: ViewInstance = { instance: `v${++this.n}`, owner, view, first: false, spec, runtimeTitle: null, down: false, size: null }
    this.instances.set(held.instance, held)
    this.tell(owner, { topic: 'view.opened', instance: held.instance, view })
    return held.instance
  }

  close(owner: string, instance: string): RefusalCode | null {
    const held = this.instances.get(instance)
    if (held === undefined) return 'not-found'
    if (held.owner !== owner) return 'not-granted'
    this.remove(held, true)
    return null
  }

  title(owner: string, instance: string, title: string): RefusalCode | null {
    const held = this.instances.get(instance)
    if (held === undefined) return 'not-found'
    if (held.owner !== owner) return 'not-granted'
    held.runtimeTitle = title
    return null
  }

  owner(instance: string): string | null {
    return this.instances.get(instance)?.owner ?? null
  }

  get(instance: string): ViewInstance | null {
    return this.instances.get(instance) ?? null
  }

  all(): ViewInstance[] {
    return [...this.instances.values()]
  }

  // The plugin's name as the views menu and titles show it
  name(owner: string): string {
    return this.declaredBy.get(owner)?.name ?? owner
  }

  // Every declared view, running or not, for the views menu
  declarations(): CoreViewsPlugin[] {
    return [...this.declaredBy.values()]
  }

  // What the layout plans from. favorites hold owner/view keys in the human's order
  list(favorites: readonly string[]): LayoutView[] {
    return [...this.instances.values()].map(held => {
      const at = favorites.indexOf(`${held.owner}/${held.view}`)
      return {
        instance: held.instance, owner: held.owner, view: held.view, kind: held.spec.kind, title: held.spec.title,
        size: { ...held.spec.size }, priority: held.spec.priority ?? null, favorite: at === -1 ? null : at, down: held.down,
      }
    })
  }

  // The instance's size on screen, null when it isn't. The owner hears each change once
  shown(instance: string, size: { width: number, height: number } | null): void {
    const held = this.instances.get(instance)
    if (held === undefined || held.down) return
    const before = held.size
    if (size === null) {
      if (before === null) return
      held.size = null
      this.tell(held.owner, { topic: 'view.hidden', instance })
      return
    }
    if (before !== null && before.width === size.width && before.height === size.height) return
    held.size = { ...size }
    this.tell(held.owner, { topic: 'view.shown', instance, width: size.width, height: size.height })
  }

  private specOf(owner: string, view: string): ViewSpec | null {
    const views = this.declaredBy.get(owner)?.views
    return views !== undefined && Object.hasOwn(views, view) ? views[view] as ViewSpec : null
  }

  private remove(held: ViewInstance, tell: boolean): void {
    this.instances.delete(held.instance)
    if (tell && this.up.has(held.owner)) this.tell(held.owner, { topic: 'view.closed', instance: held.instance })
  }
}
