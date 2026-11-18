import type { LayoutState, UiNode } from '../../api/ui.ts'
import { type DrawHooks, TreeView } from './draw.ts'
import type { Rect } from './drag.ts'
import { SKELETON, type UiPort } from './ui-port.ts'

// The editor window's layers below the core layer. The base layer holds the layout's skeleton, or the drawer's plain
// layout until a layout has drawn one. The lifted layer above it holds every view, the editors, the titles and the
// frames, each laid over its placeholder and clipped to it, so no node of the layout's covers them or hears what
// happens in them, whatever its CSS does. The overlay layer above that holds popovers under the strip naming their
// owner. Theme variables reach the base and lifted layers only. Each owner's redraws are held to a budget of writes
// to the page a second, past which the rest wait for the next second, so a busy view can't take the page from typing

export type EditorsLike = {
  // The instance the human works in, null with none open
  shown(): string | null
  ids(): string[]
  // Each editor's element placed over its box, or hidden for null
  place(id: string, box: Rect | null): void
}

export type FramesLike = {
  // The frame drawing a view instance, laid over its slot or hidden for null
  place(owner: string, instance: string, frame: string, box: Rect | null): void
  forget(keep: ReadonlySet<string>): void
}

export type TitleSource = {
  view(instance: string): { text: string, down: boolean } | null
  note(instance: string): string | null
}

export type LayersParts = { stage: HTMLElement, base: HTMLElement, lifted: HTMLElement, overlay: HTMLElement, empty: HTMLElement }

// Writes to the page one owner's redraws may make in a second
export const DRAW_WRITES_PER_SECOND = 20_000

type Hooks = {
  // Draw hooks for the tree of one owner's surface
  drawHooks(owner: string, surface: string): DrawHooks
  // A title's view was pressed, which may become a drag
  titlePressed(instance: string, event: PointerEvent): void
  // A title the layout placed was clicked
  titleClicked(owner: string, node: string): void
  // Placing changed what the layout plans from
  state(state: Omit<LayoutState, 'views' | 'editors' | 'current'>): void
}

export class Layers {
  private readonly parts: LayersParts
  private readonly ui: UiPort
  private readonly editors: EditorsLike
  private readonly frames: FramesLike | null
  private readonly titles: TitleSource
  private readonly hooks: Hooks
  private skeleton: TreeView | null = null
  private readonly views = new Map<string, TreeView>()
  private readonly lifted = new Map<string, HTMLElement>()
  private readonly downs = new Map<string, HTMLElement>()
  private readonly itemBoxes = new Map<string, HTMLElement>()
  private readonly spent = new Map<string, { start: number, writes: number }>()
  private readonly waiting = new Set<string>()
  private readonly plain: HTMLElement
  private queued = false

  constructor(parts: LayersParts, deps: { ui: UiPort, editors: EditorsLike, frames: FramesLike | null, titles: TitleSource, hooks: Hooks }) {
    this.parts = parts
    this.ui = deps.ui
    this.editors = deps.editors
    this.frames = deps.frames
    this.titles = deps.titles
    this.hooks = deps.hooks
    this.plain = document.createElement('div')
    this.plain.className = 'hetu-plain'
    const observer = new ResizeObserver(() => this.schedule())
    observer.observe(parts.stage)
    parts.base.addEventListener('scroll', () => this.schedule(), { capture: true, passive: true })
  }

  // The tree view drawing a surface, made on first use
  treeOf(owner: string, surface: string): TreeView {
    if (surface === SKELETON) {
      if (this.skeleton === null || this.skeleton.owner !== owner) this.skeleton = new TreeView(owner, SKELETON, owner, this.hooks.drawHooks(owner, SKELETON))
      return this.skeleton
    }
    let tree = this.views.get(surface)
    if (tree === undefined || tree.owner !== owner) {
      // A popover's strip names the plugin by its id, which the core checks, never a name the plugin picked
      tree = new TreeView(owner, surface, owner, this.hooks.drawHooks(owner, surface))
      this.views.set(surface, tree)
    }
    return tree
  }

  // A surface changed: draw it again within the owner's budget, then place everything in the next frame
  drawn(owner: string, surface: string): void {
    if (surface === SKELETON && this.ui.layout() !== owner) return
    const now = performance.now()
    let spent = this.spent.get(owner)
    if (spent === undefined || now - spent.start >= 1000) {
      spent = { start: now, writes: 0 }
      this.spent.set(owner, spent)
    }
    const key = `${owner} ${surface}`
    if (spent.writes >= DRAW_WRITES_PER_SECOND) {
      // Drawn once the second is over, with whatever the tree is by then
      if (!this.waiting.has(key)) {
        this.waiting.add(key)
        setTimeout(() => {
          this.waiting.delete(key)
          this.drawn(owner, surface)
        }, Math.max(1, 1000 - (now - spent.start)))
      }
      return
    }
    spent.writes += this.treeOf(owner, surface).render(this.ui.surfaces.tree(owner, surface))
    this.schedule()
  }

  // The layout drawing the window changed, or views came or went
  changed(): void {
    const layout = this.ui.layout()
    if (layout === null) this.skeleton = null
    else this.treeOf(layout, SKELETON).render(this.ui.surfaces.tree(layout, SKELETON))
    for (const [instance, tree] of this.views) {
      if (this.ui.views.owner(instance) === tree.owner) continue
      tree.root.remove()
      this.views.delete(instance)
    }
    for (const [instance, note] of this.downs) {
      if (this.ui.views.get(instance)?.down === true) continue
      note.remove()
      this.downs.delete(instance)
    }
    this.place()
  }

  schedule(): void {
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      this.place()
    })
  }

  // The views the human sees, by instance, for the menu
  shownViews(): Set<string> {
    const shown = new Set<string>()
    for (const held of this.ui.views.all()) if (held.size !== null) shown.add(held.instance)
    return shown
  }

  // Everything laid out again: what the base layer holds, each view in its slot, each lifted element over its box
  place(): void {
    const { base, stage } = this.parts
    const skeleton = this.ui.drawing() !== null ? this.skeleton : null
    const top = skeleton === null ? this.plain : skeleton.root
    if (base.firstElementChild !== top || base.childElementCount !== 1) base.replaceChildren(top)
    const stageBox = stage.getBoundingClientRect()
    const box = (element: HTMLElement): Rect => {
      const at = element.getBoundingClientRect()
      return { left: at.left - stageBox.left, top: at.top - stageBox.top, width: at.width, height: at.height }
    }
    const placeholders = skeleton === null
      ? [{ node: { kind: 'editor', id: 'plain', instance: 'current' } as UiNode, element: this.plain }]
      : [...skeleton.placeholders.values()]

    // Views over their slots in the lifted layer, frames among them. Items share a box of the drawer's over theirs
    const shown = new Map<string, Rect>()
    const framed = new Set<string>()
    const laid = new Set<HTMLElement>()
    const items = this.ui.views.all().filter(held => held.spec.kind === 'item' && !held.down)
      .sort((a, b) => this.rankOf(a.owner, a.view) - this.rankOf(b.owner, b.view))
    for (const { node, element } of placeholders) {
      if (node.kind !== 'slot') continue
      const at = box(element)
      if (node.items === true) {
        const holder = this.itemBox(node.id)
        const roots: HTMLElement[] = []
        for (const held of items) {
          if (shown.has(held.instance)) continue
          shown.set(held.instance, at)
          if (held.spec.frame !== undefined) {
            framed.add(held.instance)
            this.frames?.place(held.owner, held.instance, held.spec.frame, at)
            continue
          }
          const root = this.viewRoot(held.owner, held.instance)
          lay(root, null)
          root.hidden = false
          root.removeAttribute('style')
          roots.push(root)
        }
        syncChildren(holder, roots)
        lay(holder, at)
        laid.add(holder)
        continue
      }
      const instance = node.instance as string
      const held = this.ui.views.get(instance)
      if (held === null || shown.has(instance)) continue
      if (held.down) {
        const note = this.downNote(instance, held.owner)
        lay(note, at)
        laid.add(note)
        continue
      }
      shown.set(instance, at)
      if (held.spec.frame !== undefined) {
        framed.add(instance)
        this.frames?.place(held.owner, instance, held.spec.frame, at)
        continue
      }
      const root = this.viewRoot(held.owner, instance)
      if (root.parentElement !== this.parts.lifted) this.parts.lifted.append(root)
      lay(root, at)
      laid.add(root)
    }
    // What isn't placed this time is hidden where it is, never moved, so a view keeps its focus and scroll
    for (const element of [...this.views.values()].map(tree => tree.root).filter(root => root.parentElement === this.parts.lifted)) {
      if (!laid.has(element)) lay(element, null)
    }
    for (const element of [...this.downs.values(), ...this.itemBoxes.values()]) if (!laid.has(element)) lay(element, null)
    for (const held of this.ui.views.all()) this.ui.views.shown(held.instance, held.down ? null : sizeOf(shown.get(held.instance)))
    this.frames?.forget(framed)

    // Editors over their boxes. The first placeholder for an instance wins
    const placed = new Map<string, Rect>()
    let emptyAt: Rect | null = null
    for (const { node, element } of placeholders) {
      if (node.kind !== 'editor') continue
      const instance = node.instance === 'current' ? this.editors.shown() : node.instance
      if (instance === null) {
        emptyAt ??= box(element)
        continue
      }
      if (!placed.has(instance)) placed.set(instance, box(element))
    }
    for (const id of this.editors.ids()) this.editors.place(id, placed.get(id) ?? null)
    lay(this.parts.empty, emptyAt)

    // Titles over theirs, drawn by the drawer
    const titled = new Set<string>()
    for (const { node, element } of placeholders) {
      if (node.kind !== 'title') continue
      titled.add(node.id)
      lay(this.title(node.id, node.of, skeleton?.owner ?? ''), box(element))
    }
    for (const [id, element] of this.lifted) {
      if (titled.has(id)) continue
      element.remove()
      this.lifted.delete(id)
    }

    this.popovers([skeleton, ...[...shown.keys()].map(instance => this.views.get(instance) ?? null)], box)

    const slots: Record<string, { width: number, height: number }> = {}
    for (const { node, element } of placeholders) {
      if (node.kind === 'slot' || node.kind === 'editor') slots[node.id] = sizeOf(box(element)) as { width: number, height: number }
    }
    this.hooks.state({ width: Math.round(stageBox.width), height: Math.round(stageBox.height), slots })
  }

  private rankOf(owner: string, view: string): number {
    const at = this.favorites.indexOf(`${owner}/${view}`)
    return at === -1 ? Number.MAX_SAFE_INTEGER : at
  }

  favorites: readonly string[] = []

  // A view's tree, drawn on first use
  private viewRoot(owner: string, instance: string): HTMLElement {
    const tree = this.treeOf(owner, instance)
    if (tree.root.childElementCount === 0) tree.render(this.ui.surfaces.tree(owner, instance))
    return tree.root
  }

  private itemBox(id: string): HTMLElement {
    let holder = this.itemBoxes.get(id)
    if (holder === undefined) {
      holder = document.createElement('div')
      holder.className = 'hetu-items'
      this.parts.lifted.append(holder)
      this.itemBoxes.set(id, holder)
    }
    return holder
  }

  private downNote(instance: string, owner: string): HTMLElement {
    let note = this.downs.get(instance)
    if (note === undefined) {
      note = document.createElement('div')
      note.className = 'hetu-down'
      note.textContent = `${owner} isn't running`
      this.parts.lifted.append(note)
      this.downs.set(instance, note)
    }
    return note
  }

  private title(id: string, of: string, layout: string): HTMLElement {
    let element = this.lifted.get(id)
    if (element === undefined) {
      element = document.createElement('div')
      element.className = 'hetu-title'
      element.addEventListener('pointerdown', event => {
        const instance = element?.dataset.of
        if (event.isTrusted && event.button === 0 && instance?.startsWith('v') === true) this.hooks.titlePressed(instance, event)
      })
      element.addEventListener('click', event => {
        if (event.isTrusted) this.hooks.titleClicked(element?.dataset.layout ?? '', id)
      })
      this.parts.lifted.append(element)
      this.lifted.set(id, element)
    }
    element.dataset.of = of
    element.dataset.layout = layout
    const view = of.startsWith('v') ? this.titles.view(of) : null
    const text = view !== null ? `${view.text}${view.down ? ' (not running)' : ''}` : this.titles.note(of) ?? ''
    if (element.textContent !== text) element.textContent = text
    element.title = text
    return element
  }

  private popovers(trees: (TreeView | null)[], box: (element: HTMLElement) => Rect): void {
    const keep = new Set<HTMLElement>()
    for (const tree of trees) {
      if (tree === null) continue
      for (const { node, element } of tree.popovers.values()) {
        if (node.kind !== 'popover') continue
        const anchor = tree.element(node.anchor)
        if (anchor === null || !anchor.isConnected) continue
        keep.add(element)
        if (element.parentElement !== this.parts.overlay) this.parts.overlay.append(element)
        const at = box(anchor)
        element.style.setProperty('left', `${node.side === 'right' ? at.left + at.width : node.side === 'left' ? Math.max(0, at.left - element.offsetWidth) : at.left}px`)
        element.style.setProperty('top', `${node.side === 'below' ? at.top + at.height : node.side === 'above' ? Math.max(0, at.top - element.offsetHeight) : at.top}px`)
      }
    }
    for (const child of [...this.parts.overlay.children]) {
      if (child.classList.contains('hetu-popover') && !keep.has(child as HTMLElement)) child.remove()
    }
  }

  // The zones the layout marked, with their boxes, in the order drawn
  zones(): { zone: string, rect: Rect, element: HTMLElement }[] {
    if (this.skeleton === null || this.ui.drawing() === null) return []
    const stageBox = this.parts.stage.getBoundingClientRect()
    return [...this.skeleton.zones].map(([zone, element]) => {
      const at = element.getBoundingClientRect()
      return { zone, element, rect: { left: at.left - stageBox.left, top: at.top - stageBox.top, width: at.width, height: at.height } }
    })
  }
}

function sizeOf(rect: Rect | undefined): { width: number, height: number } | null {
  return rect === undefined ? null : { width: Math.round(rect.width), height: Math.round(rect.height) }
}

// An element of the lifted layer laid over a box of the stage, or hidden
export function lay(element: HTMLElement, box: Rect | null): void {
  element.hidden = box === null
  if (box === null) return
  element.style.left = `${box.left}px`
  element.style.top = `${box.top}px`
  element.style.width = `${box.width}px`
  element.style.height = `${box.height}px`
}

function syncChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
  if (children.length === parent.childElementCount && children.every((child, at) => parent.children[at] === child)) return
  parent.replaceChildren(...children)
}
