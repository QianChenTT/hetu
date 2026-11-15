import { ChangeSet, Text } from '@codemirror/state'
import type { Capability } from '../../api/capabilities.ts'
import type { Mark } from '../../api/editor.ts'
import type { ViewSpec } from '../../api/manifest.ts'
import { applyOps, parseDrawerCall, type UiEvent, type UiNode } from '../../api/ui.ts'
import { Editor } from '../editor.ts'
import type { Transport } from '../transport.ts'
import { holds } from './gate.ts'

// An editor page's drawer in memory, for a plugin's tests: the plugin's views and skeleton applied as the drawer would,
// notes the test opens served through the editor bridge, and events the test sends. It holds the plugin to its
// manifest's ui items and scopes. Edits are taken only at the note's current version, with no rebase, and marks are
// kept as sent

type Body = UiEvent extends infer E ? E extends UiEvent ? Omit<E, 'v' | 'kind'> : never : never
type Note = { path: string, text: Text, version: number }

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

  // A note open in the editor, which the plugin hears of when it reads the path
  openNote(path: string, text: string): string {
    const instance = `n${++this.n}`
    this.notes.set(instance, { path, text: Text.of(text.split('\n')), version: 0 })
    if (this.reads(path)) this.emit({ topic: 'editor.opened', instance } as unknown as Body)
    return instance
  }

  text(instance: string): string | null {
    return this.notes.get(instance)?.text.toString() ?? null
  }

  private has(item: string): boolean {
    return this.granted.some(granted => granted.type === item)
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
        return null
      case 'editor.keys':
        need('ui.keys')
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
