import type { Op, UiEvent, UiNode, UiTopic } from '../api/ui.ts'
import { MAX_OPS } from '../api/ui-limits.ts'
import type { Editor } from './editor.ts'

// ctx.ui: a plugin's views and, when the human picked it, the window's layout, drawn as trees of the drawer's building
// blocks. A plugin draws a whole tree each time, as React does, and the SDK sends the drawer only what changed. A new
// editor page numbers instances afresh, so a new port forgets every tree, and the plugin draws again on view.opened
// and layout.state

export type UiClient = {
  readonly views: {
    // Another instance of a view the plugin declared, which the layout may place
    open(view: string): Promise<string>
    close(instance: string): Promise<void>
    // A title for the drawer only, shown under the plugin's name. The layout never sees it
    title(instance: string, title: string): Promise<void>
    draw(instance: string, tree: UiNode): Promise<void>
    // A message to the frame drawing the instance
    post(instance: string, data: unknown): Promise<void>
    // Bindings that fire while focus is in one of the plugin's instances
    bind(bindings: { key: string, command: string }[]): Promise<void>
  }
  readonly layout: {
    // The skeleton, taken only from the layout the human picked
    draw(tree: UiNode): Promise<void>
  }
  on<T extends UiTopic>(topic: T, handler: (event: Extract<UiEvent, { topic: T }>) => void): void
}

const SKELETON = 'layout'

function children(node: UiNode): UiNode[] {
  return (node as { children?: UiNode[] }).children ?? []
}

function withoutChildren(node: UiNode): UiNode {
  const { children: _children, ...rest } = node as UiNode & { children?: UiNode[] }
  return rest as UiNode
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function walk(before: UiNode, after: UiNode, ops: Op[]): void {
  const was = children(before)
  const now = children(after)
  if (was.length !== now.length || was.some((child, at) => child.id !== now[at]?.id || child.kind !== now[at]?.kind)) {
    ops.push({ op: 'set', node: after })
    return
  }
  const plainBefore = withoutChildren(before)
  const plainAfter = withoutChildren(after)
  if (!same(plainBefore, plainAfter)) {
    const textOnly = (after.kind === 'text' || after.kind === 'button') && same({ ...plainBefore, text: '' }, { ...plainAfter, text: '' })
    ops.push(textOnly ? { op: 'text', id: after.id, text: (after as { text: string }).text } : { op: 'props', node: plainAfter })
  }
  now.forEach((child, at) => walk(was[at] as UiNode, child, ops))
}

// The operations that turn before into after: the whole tree for a new root, else each node whose children changed set
// whole, a text alone as text and other properties as props. Past what one message takes, the whole tree
export function diffTree(before: UiNode | null, after: UiNode): Op[] {
  if (before === null || before.id !== after.id || before.kind !== after.kind) return [{ op: 'tree', root: after }]
  const ops: Op[] = []
  walk(before, after, ops)
  return ops.length > MAX_OPS ? [{ op: 'tree', root: after }] : ops
}

export class Ui implements UiClient {
  private readonly drawer: Editor
  private readonly trees = new Map<string, UiNode>()
  private bindings: { key: string, command: string }[] | null = null
  readonly views: UiClient['views']
  readonly layout: UiClient['layout']

  constructor(drawer: Editor) {
    this.drawer = drawer
    drawer.onConnect(() => {
      this.trees.clear()
      if (this.bindings !== null) drawer.call('view.bind', { bindings: this.bindings }).catch(() => {})
    })
    drawer.listen<{ instance: string }>('view.closed', event => this.trees.delete(event.instance))
    this.views = {
      open: async view => ((await drawer.call('view.open', { view })) as { instance: string }).instance,
      close: async instance => {
        this.trees.delete(instance)
        await drawer.call('view.close', { instance })
      },
      title: async (instance, title) => {
        await drawer.call('view.title', { instance, title })
      },
      draw: (instance, tree) => this.draw(instance, tree),
      post: async (instance, data) => {
        await drawer.call('view.post', { instance, data })
      },
      bind: async bindings => {
        this.bindings = bindings.map(binding => ({ key: binding.key, command: binding.command }))
        await drawer.call('view.bind', { bindings: this.bindings })
      },
    }
    this.layout = { draw: tree => this.draw(SKELETON, tree) }
  }

  on<T extends UiTopic>(topic: T, handler: (event: Extract<UiEvent, { topic: T }>) => void): void {
    this.drawer.listen(topic, handler)
  }

  // A refused draw leaves the drawer with the tree before it, so the next one goes whole
  private async draw(surface: string, tree: UiNode): Promise<void> {
    const ops = diffTree(this.trees.get(surface) ?? null, tree)
    if (ops.length === 0) return
    this.trees.set(surface, tree)
    try {
      if (surface === SKELETON) await this.drawer.call('layout.draw', { ops })
      else await this.drawer.call('view.draw', { instance: surface, ops })
    } catch (err) {
      this.trees.delete(surface)
      throw err
    }
  }
}
