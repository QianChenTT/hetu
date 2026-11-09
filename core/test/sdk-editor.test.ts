import { describe, expect, it } from 'vitest'
import { Editor } from '../sdk/editor.ts'
import { Refused } from '../sdk/refused.ts'
import type { Transport } from '../sdk/transport.ts'

// The worker's end of a port to the drawer: what the plugin sent, and replies and events from the drawer
function drawerPort() {
  const sent: { id: number, verb: string, args: unknown }[] = []
  let listener: ((message: unknown) => void) | null = null
  const transport: Transport = {
    paces: true,
    post: message => void sent.push(message as { id: number, verb: string, args: unknown }),
    listen: next => {
      listener = next
    },
  }
  return {
    transport,
    sent,
    replies: (id: number, result: unknown) => listener?.({ v: 1, kind: 'reply', id, ok: true, result }),
    refuses: (id: number, code: string) => listener?.({ v: 1, kind: 'reply', id, ok: false, refusal: { code } }),
    tells: (event: Record<string, unknown>) => listener?.({ v: 1, kind: 'event', ...event }),
  }
}

describe("the SDK's editor side", () => {
  it('answers unavailable for every call while there is no port to the drawer', async () => {
    const editor = new Editor()
    await expect(editor.read('n1')).rejects.toMatchObject({ code: 'unavailable', action: 'editor.read' })
    await expect(editor.instances()).rejects.toBeInstanceOf(Refused)
  })

  it('sends each call on the port and settles with its reply', async () => {
    const editor = new Editor()
    const port = drawerPort()
    editor.connect(port.transport)
    const reading = editor.read('n1')
    expect(port.sent).toEqual([{ v: 1, kind: 'call', id: 1, verb: 'editor.read', args: { instance: 'n1' } }])
    port.replies(1, { text: 'a', version: 0, selection: [] })
    expect(await reading).toEqual({ text: 'a', version: 0, selection: [] })
    const deco = editor.decorate('n1', 0, 'spell', [{ kind: 'mark', from: 0, to: 1, style: 'error' }])
    expect(port.sent[1]).toMatchObject({ verb: 'editor.decorate', args: { instance: 'n1', version: 0, set: 'spell', marks: [{ kind: 'mark', from: 0, to: 1, style: 'error' }] } })
    port.replies(2, { version: 0 })
    await deco
    const edit = editor.edit('n1', 0, [1, [0, '!']])
    expect(port.sent[2]).toMatchObject({ verb: 'editor.edit', args: { instance: 'n1', version: 0, changes: [1, [0, '!']] } })
    port.replies(3, { version: 1 })
    expect(await edit).toEqual({ version: 1 })
  })

  it('throws a refusal as Refused with its code and the verb', async () => {
    const editor = new Editor()
    const port = drawerPort()
    editor.connect(port.transport)
    const edit = editor.edit('n1', 0, [1])
    port.refuses(1, 'stale')
    await expect(edit).rejects.toMatchObject({ code: 'stale', action: 'editor.edit' })
  })

  it('hands each event to the handlers for its topic', () => {
    const editor = new Editor()
    const port = drawerPort()
    editor.connect(port.transport)
    const heard: unknown[] = []
    editor.on('changed', event => heard.push(['changed', event]))
    editor.on('command', event => heard.push(['command', event]))
    port.tells({ topic: 'editor.changed', instance: 'n1', version: 2, changes: [1, [0, 'x']] })
    port.tells({ topic: 'editor.command', command: 'kill', instance: 'n1' })
    port.tells({ topic: 'editor.opened', instance: 'n2' })
    expect(heard).toEqual([
      ['changed', { v: 1, kind: 'event', topic: 'editor.changed', instance: 'n1', version: 2, changes: [1, [0, 'x']] }],
      ['command', { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: 'n1' }],
    ])
  })

  it('on a new port sends its bindings and key stream again and fails what was in flight on the old one', async () => {
    const editor = new Editor()
    const first = drawerPort()
    editor.connect(first.transport)
    const bound = editor.bind([{ key: 'Mod-k', command: 'kill' }])
    first.replies(1, null)
    await bound
    const streaming = editor.keys(true)
    first.replies(2, null)
    await streaming
    const reading = editor.read('n1')
    const next = drawerPort()
    editor.connect(next.transport)
    await expect(reading).rejects.toMatchObject({ code: 'unavailable' })
    expect(next.sent.map(call => [call.verb, call.args])).toEqual([
      ['editor.bind', { bindings: [{ key: 'Mod-k', command: 'kill' }] }],
      ['editor.keys', { on: true }],
    ])
    // A late reply on the old port settles nothing
    first.replies(3, { text: 'late' })
  })
})
