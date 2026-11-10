import { describe, expect, it } from 'vitest'
import { applyOps, type UiNode } from '../api/ui.ts'
import { Editor } from '../sdk/editor.ts'
import type { Transport } from '../sdk/transport.ts'
import { diffTree, Ui } from '../sdk/ui.ts'

const text = (id: string, value: string): UiNode => ({ kind: 'text', id, text: value })
const box = (id: string, children: UiNode[], extra: object = {}): UiNode => ({ kind: 'box', id, children, ...extra } as UiNode)

describe('the difference between two trees', () => {
  const before = box('root', [box('side', [text('a', 'one')]), text('b', 'two')])
  const cases: [string, UiNode, string[]][] = [
    ['a style change as props', box('root', [box('side', [text('a', 'one')], { style: { color: 'red' } }), text('b', 'two')]), ['props']],
    ['a text change as text', box('root', [box('side', [text('a', 'one')]), text('b', 'TWO')]), ['text']],
    ['a changed child list as set', box('root', [box('side', [text('a', 'one'), text('c', 'three')]), text('b', 'two')]), ['set']],
    ['a new root as tree', box('top', [text('a', 'x')]), ['tree']],
    ['nothing changed as nothing', before, []],
  ]

  it.each(cases)('sends %s, which applied gives the same tree', (_name, after, kinds) => {
    const ops = diffTree(before, after)
    expect(ops.map(each => each.op)).toEqual(kinds)
    const applied = applyOps(before, ops, { layout: false })
    expect('tree' in applied && applied.tree).toEqual(after)
  })

  it('sends the whole tree with nothing before it', () => {
    expect(diffTree(null, before)).toEqual([{ op: 'tree', root: before }])
  })

  it('sends the whole tree when the difference would pass the operations a message takes', () => {
    const many = (suffix: string) => box('root', Array.from({ length: 150 }, (_, i) => text(`t${i}`, `${i}${suffix}`)))
    expect(diffTree(many(''), many('!')).map(each => each.op)).toEqual(['tree'])
  })
})

// A drawer end in memory that answers each call from a table and records what came
function drawerEnd(answers: Record<string, (args: unknown) => { ok: boolean, result?: unknown, code?: string }> = {}) {
  const calls: { verb: string, args: unknown }[] = []
  let toPlugin: ((message: unknown) => void) | null = null
  const transport: Transport = {
    post(message) {
      const call = message as { id: number, verb: string, args: unknown }
      calls.push({ verb: call.verb, args: call.args })
      const answer = answers[call.verb]?.(call.args) ?? { ok: true, result: null }
      queueMicrotask(() => toPlugin?.(answer.ok
        ? { v: 1, kind: 'reply', id: call.id, ok: true, result: answer.result ?? null }
        : { v: 1, kind: 'reply', id: call.id, ok: false, refusal: { code: answer.code } }))
    },
    listen(next) {
      toPlugin = next
    },
  }
  return { transport, calls, event: (body: object) => toPlugin?.({ v: 1, kind: 'event', ...body }) }
}

describe('ctx.ui', () => {
  it('answers unavailable with no port', async () => {
    const ui = new Ui(new Editor())
    await expect(ui.views.draw('v1', text('a', 'x'))).rejects.toMatchObject({ code: 'unavailable' })
    await expect(ui.layout.draw(text('a', 'x'))).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('sends the whole tree first and then only the difference', async () => {
    const editor = new Editor()
    const ui = new Ui(editor)
    const end = drawerEnd()
    editor.connect(end.transport)
    await ui.views.draw('v1', box('root', [text('a', 'one')]))
    await ui.views.draw('v1', box('root', [text('a', 'two')]))
    await ui.views.draw('v1', box('root', [text('a', 'two')]))
    expect(end.calls.map(call => (call.args as { ops: { op: string }[] }).ops.map(each => each.op))).toEqual([['tree'], ['text']])
  })

  it('sends the whole tree again after a refused draw', async () => {
    const editor = new Editor()
    const ui = new Ui(editor)
    let refuse = false
    const end = drawerEnd({ 'view.draw': () => (refuse ? { ok: false, code: 'invalid' } : { ok: true }) })
    editor.connect(end.transport)
    await ui.views.draw('v1', box('root', [text('a', 'one')]))
    refuse = true
    await expect(ui.views.draw('v1', box('root', [text('a', 'two')]))).rejects.toMatchObject({ code: 'invalid' })
    refuse = false
    await ui.views.draw('v1', box('root', [text('a', 'three')]))
    expect(end.calls.map(call => (call.args as { ops: { op: string }[] }).ops[0]?.op)).toEqual(['tree', 'text', 'tree'])
  })

  it('forgets every tree on a new port, whose page numbers instances afresh, and sends its view bindings again', async () => {
    const editor = new Editor()
    const ui = new Ui(editor)
    const first = drawerEnd()
    editor.connect(first.transport)
    await ui.views.bind([{ key: 'j', command: 'down' }])
    await ui.layout.draw(box('root', [text('a', 'x')]))
    const second = drawerEnd()
    editor.connect(second.transport)
    await new Promise(resolve => setTimeout(resolve, 0))
    await ui.layout.draw(box('root', [text('a', 'x')]))
    expect(second.calls.map(call => call.verb)).toEqual(['view.bind', 'layout.draw'])
    expect((second.calls[1]?.args as { ops: { op: string }[] }).ops[0]?.op).toBe('tree')
  })

  it('hands ui events to their handlers and answers view.open with the instance', async () => {
    const editor = new Editor()
    const ui = new Ui(editor)
    const end = drawerEnd({ 'view.open': () => ({ ok: true, result: { instance: 'v7' } }) })
    editor.connect(end.transport)
    const heard: unknown[] = []
    ui.on('view.event', event => heard.push(event))
    ui.on('layout.state', event => heard.push(event))
    end.event({ topic: 'view.event', instance: 'v1', node: 'add', type: 'click' })
    end.event({ topic: 'layout.state', state: { width: 1 } })
    expect(heard).toEqual([
      { v: 1, kind: 'event', topic: 'view.event', instance: 'v1', node: 'add', type: 'click' },
      { v: 1, kind: 'event', topic: 'layout.state', state: { width: 1 } },
    ])
    expect(await ui.views.open('board')).toBe('v7')
  })

  it('holds events that came before the plugin\'s start ran, so its handlers hear them once registered', async () => {
    const editor = new Editor()
    editor.hold()
    const ui = new Ui(editor)
    const end = drawerEnd()
    editor.connect(end.transport)
    end.event({ topic: 'view.opened', instance: 'v1', view: 'board' })
    end.event({ topic: 'layout.state', state: { width: 1 } })
    const heard: string[] = []
    ui.on('view.opened', event => heard.push(event.topic))
    ui.on('layout.state', event => heard.push(event.topic))
    expect(heard).toEqual([])
    editor.release()
    expect(heard).toEqual(['view.opened', 'layout.state'])
    end.event({ topic: 'view.closed', instance: 'v1' })
    ui.on('view.closed', event => heard.push(event.topic))
    end.event({ topic: 'view.closed', instance: 'v1' })
    expect(heard).toEqual(['view.opened', 'layout.state', 'view.closed'])
  })

  it('opens a note through ctx.editor', async () => {
    const editor = new Editor()
    const end = drawerEnd()
    editor.connect(end.transport)
    await editor.open('notes/a.md')
    expect(end.calls).toEqual([{ verb: 'editor.open', args: { path: 'notes/a.md' } }])
  })
})
