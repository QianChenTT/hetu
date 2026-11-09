import type { NodeEventType, Payload, PayloadType, UiNode } from '../../api/ui.ts'

// One plugin's tree drawn with the drawer's own elements. Nodes are kept by id, so a redraw changes elements in place
// and an input keeps its focus and what is typed. Styles go in as values with style.setProperty, already checked
// against the list, and hover, focus and pressed styles apply here with no round trip. Text is always text. The layout's
// slots, editors and titles are placeholders the drawer fills or lays its own elements over. Popovers are drawn apart,
// in the overlay layer, under a strip naming the owner. Every element knows its owner and surface, which the page reads
// to send an event to that owner and no other

export type DrawHooks = {
  event(node: string, type: NodeEventType, value?: string | boolean): void
  // A node carrying a payload was pressed: the drawer runs the drag
  dragStart(node: string, payload: Payload, event: PointerEvent): void
  // A split's divider was pressed
  divider(node: string, index: number, event: PointerEvent, split: HTMLElement): void
  // Where an icon of the owner's own files loads from
  iconUrl(src: string): string
  // A list scrolled, so its rows on screen changed
  scrolled(): void
}

export type Tagged = { readonly tree: TreeView, readonly id: string }
const tags = new WeakMap<Element, Tagged>()

// The node an element belongs to, walking up from it, with the tree that drew it
export function taggedOf(start: Element | null): Tagged | null {
  for (let at = start; at !== null; at = at.parentElement) {
    const tag = tags.get(at)
    if (tag !== undefined) return tag
  }
  return null
}

type States = { hover: boolean, focus: boolean, pressed: boolean }
type Held = { node: UiNode, element: HTMLElement, states: States, applied: string[], value?: unknown }

const LIST_SLACK = 4

export class TreeView {
  readonly owner: string
  readonly surface: string
  // The owner's name, which a popover's strip shows
  readonly name: string
  readonly root: HTMLElement
  private readonly hooks: DrawHooks
  private held = new Map<string, Held>()
  private tree: UiNode | null = null
  // Filled each draw: the layout's placeholders, popovers, zones and drop targets by node id
  placeholders = new Map<string, { node: UiNode, element: HTMLElement }>()
  popovers = new Map<string, { node: UiNode, element: HTMLElement }>()
  zones = new Map<string, HTMLElement>()

  constructor(owner: string, surface: string, name: string, hooks: DrawHooks) {
    this.owner = owner
    this.surface = surface
    this.name = name
    this.hooks = hooks
    this.root = document.createElement('div')
    this.root.className = 'hetu-surface'
  }

  node(id: string): UiNode | null {
    return this.held.get(id)?.node ?? null
  }

  element(id: string): HTMLElement | null {
    return this.held.get(id)?.element ?? null
  }

  render(tree: UiNode | null): void {
    this.tree = tree
    const seen = new Set<string>()
    this.placeholders = new Map()
    this.popovers = new Map()
    this.zones = new Map()
    const top = tree === null ? [] : [this.build(tree, seen)]
    sync(this.root, top)
    for (const [id, held] of this.held) {
      if (seen.has(id)) continue
      held.element.remove()
      this.held.delete(id)
    }
  }

  // A list scrolled: draw the rows now on screen
  refresh(): void {
    this.render(this.tree)
  }

  private build(node: UiNode, seen: Set<string>): HTMLElement {
    seen.add(node.id)
    let held = this.held.get(node.id)
    if (held === undefined || held.node.kind !== node.kind) {
      held?.element.remove()
      held = { node, element: this.create(node), states: { hover: false, focus: false, pressed: false }, applied: [] }
      this.held.set(node.id, held)
      this.wire(held)
    }
    const before = held.node
    held.node = node
    const element = held.element
    style(held)
    if (node.tip === undefined) element.removeAttribute('title')
    else element.title = node.tip
    if (node.zone !== undefined) this.zones.set(node.zone, element)
    switch (node.kind) {
      case 'box':
      case 'scroll':
        sync(element, this.kids(node.children, seen))
        break
      case 'text':
        element.textContent = node.text
        break
      case 'icon': {
        const image = element as HTMLImageElement
        const src = this.hooks.iconUrl(node.src)
        if (image.getAttribute('src') !== src) image.src = src
        image.alt = node.alt ?? ''
        break
      }
      case 'button':
        element.textContent = node.text
        ;(element as HTMLButtonElement).disabled = node.disabled === true
        break
      case 'input': {
        const input = element as HTMLInputElement
        // Only a value the plugin changed is put back, so what the human is typing isn't overwritten by an older one
        if (before.kind !== 'input' || before.value !== node.value || held.value === undefined) input.value = node.value
        held.value = node.value
        input.placeholder = node.placeholder ?? ''
        input.disabled = node.disabled === true
        break
      }
      case 'checkbox': {
        const box = element.querySelector('input') as HTMLInputElement
        box.checked = node.checked
        box.disabled = node.disabled === true
        ;(element.querySelector('span') as HTMLElement).textContent = node.label ?? ''
        break
      }
      case 'select': {
        const select = element as HTMLSelectElement
        select.replaceChildren(...node.options.map(option => {
          const made = document.createElement('option')
          made.value = option.value
          made.textContent = option.text
          return made
        }))
        select.value = node.value
        select.disabled = node.disabled === true
        break
      }
      case 'list':
        this.list(held, node, seen)
        break
      case 'split':
        this.split(element, node, seen)
        break
      case 'popover': {
        const body = element.lastElementChild as HTMLElement
        ;(element.firstElementChild as HTMLElement).textContent = this.name
        sync(body, this.kids(node.children, seen))
        this.popovers.set(node.id, { node, element })
        break
      }
      case 'slot':
      case 'editor':
      case 'title':
        this.placeholders.set(node.id, { node, element })
        break
    }
    return element
  }

  // A node's children, popovers left out since they draw in the overlay layer
  private kids(children: UiNode[] | undefined, seen: Set<string>): HTMLElement[] {
    const made: HTMLElement[] = []
    for (const child of children ?? []) {
      const element = this.build(child, seen)
      if (child.kind !== 'popover') made.push(element)
    }
    return made
  }

  private list(held: Held, node: Extract<UiNode, { kind: 'list' }>, seen: Set<string>): void {
    const element = held.element
    const inner = element.firstElementChild as HTMLElement
    inner.style.height = `${node.rows.length * node.rowHeight}px`
    const first = Math.max(0, Math.floor(element.scrollTop / node.rowHeight) - LIST_SLACK)
    const count = Math.ceil((element.clientHeight || 600) / node.rowHeight) + LIST_SLACK * 2
    const rows: HTMLElement[] = []
    for (let at = first; at < Math.min(node.rows.length, first + count); at++) {
      const row = this.build(node.rows[at] as UiNode, seen)
      row.classList.add('hetu-row')
      row.style.setProperty('top', `${at * node.rowHeight}px`)
      row.style.setProperty('height', `${node.rowHeight}px`)
      rows.push(row)
    }
    sync(inner, rows)
  }

  private split(element: HTMLElement, node: Extract<UiNode, { kind: 'split' }>, seen: Set<string>): void {
    const children = this.kids(node.children, seen)
    element.style.setProperty('display', 'flex')
    element.style.setProperty('flex-direction', node.direction)
    const placed: HTMLElement[] = []
    children.forEach((child, at) => {
      const size = node.sizes?.[at]
      const last = at === children.length - 1
      child.style.setProperty('flex', last || size === undefined ? '1 1 0' : `0 0 ${size}px`)
      child.style.setProperty(node.direction === 'row' ? 'min-width' : 'min-height', `${node.min?.[at] ?? 0}px`)
      placed.push(child)
      if (!last && node.resizable === true) {
        let divider = element.querySelector<HTMLElement>(`:scope > [data-divider="${at}"]`)
        if (divider === null) {
          divider = document.createElement('div')
          divider.dataset.divider = String(at)
          divider.className = `hetu-divider hetu-divider-${node.direction}`
          const index = at
          divider.addEventListener('pointerdown', event => {
            if (!event.isTrusted || event.button !== 0) return
            event.preventDefault()
            this.hooks.divider(node.id, index, event, element)
          })
        }
        placed.push(divider)
      }
    })
    sync(element, placed)
  }

  private create(node: UiNode): HTMLElement {
    let element: HTMLElement
    switch (node.kind) {
      case 'text':
        element = document.createElement('span')
        break
      case 'icon':
        element = document.createElement('img')
        ;(element as HTMLImageElement).draggable = false
        break
      case 'button':
        element = document.createElement('button')
        ;(element as HTMLButtonElement).type = 'button'
        break
      case 'input': {
        const input = document.createElement('input')
        input.type = 'text'
        input.autocomplete = 'off'
        input.spellcheck = false
        element = input
        break
      }
      case 'checkbox': {
        element = document.createElement('label')
        const box = document.createElement('input')
        box.type = 'checkbox'
        element.append(box, document.createElement('span'))
        break
      }
      case 'select':
        element = document.createElement('select')
        break
      case 'list':
        element = document.createElement('div')
        element.append(document.createElement('div'))
        element.addEventListener('scroll', () => this.hooks.scrolled(), { passive: true })
        break
      case 'popover': {
        element = document.createElement('div')
        const strip = document.createElement('div')
        strip.className = 'hetu-strip'
        const body = document.createElement('div')
        body.className = 'hetu-popover-body'
        element.append(strip, body)
        break
      }
      default:
        element = document.createElement('div')
    }
    element.classList.add('hetu-node', `hetu-${node.kind}`)
    return element
  }

  // Listeners made once per element, reading the node as it is now
  private wire(held: Held): void {
    const element = held.element
    const id = held.node.id
    tags.set(element, { tree: this, id })
    const state = (name: keyof States, on: boolean) => {
      if (held.states[name] === on) return
      held.states[name] = on
      style(held)
    }
    element.addEventListener('pointerenter', () => state('hover', true))
    element.addEventListener('pointerleave', () => {
      state('hover', false)
      state('pressed', false)
    })
    element.addEventListener('pointerdown', event => {
      state('pressed', true)
      const { drag } = held.node
      if (drag !== undefined && event.isTrusted && event.button === 0) {
        event.stopPropagation()
        this.hooks.dragStart(id, drag, event)
      }
    })
    element.addEventListener('pointerup', () => state('pressed', false))
    element.addEventListener('focusin', () => state('focus', true))
    element.addEventListener('focusout', () => state('focus', false))
    element.addEventListener('click', event => {
      if (!event.isTrusted) return
      const { node } = held
      if (node.kind === 'button' || node.click === true) {
        event.stopPropagation()
        this.hooks.event(id, 'click')
      }
    })
    if (held.node.kind === 'input') {
      const input = element as HTMLInputElement
      input.addEventListener('input', event => {
        if (event.isTrusted) this.hooks.event(id, 'input', input.value)
      })
      input.addEventListener('keydown', event => {
        if (event.isTrusted && event.key === 'Enter') this.hooks.event(id, 'submit', input.value)
      })
    }
    if (held.node.kind === 'checkbox') {
      const box = element.querySelector('input') as HTMLInputElement
      box.addEventListener('change', event => {
        if (event.isTrusted) this.hooks.event(id, 'change', box.checked)
      })
    }
    if (held.node.kind === 'select') {
      const select = element as HTMLSelectElement
      select.addEventListener('change', event => {
        if (event.isTrusted) this.hooks.event(id, 'change', select.value)
      })
    }
  }

  // Whether the node takes a drop of this type
  accepts(id: string): readonly PayloadType[] {
    return this.held.get(id)?.node.accepts ?? []
  }
}

// The node's style with the states it is in, the properties set last time cleared first
function style(held: Held): void {
  const { node, element, states } = held
  for (const name of held.applied) element.style.removeProperty(name)
  const merged = {
    ...node.style,
    ...(states.hover ? node.hover : {}),
    ...(states.focus ? node.focus : {}),
    ...(states.pressed ? node.pressed : {}),
  }
  for (const [name, value] of Object.entries(merged)) element.style.setProperty(name, value)
  held.applied = Object.keys(merged)
}

// The parent's children made exactly these, in order, moving each only when it is out of place
function sync(parent: HTMLElement, children: readonly HTMLElement[]): void {
  let at = parent.firstElementChild
  for (const child of children) {
    if (child !== at) parent.insertBefore(child, at)
    else at = at.nextElementSibling
  }
  while (at !== null) {
    const next = at.nextElementSibling
    at.remove()
    at = next
  }
}
