import { describe, expect, it } from 'vitest'
import {
  editorVerbs, lineStyles, mark, markStyles, MAX_BINDINGS, MAX_MARKS, parseBridgeCall, refused, reply, verbNeeds,
} from '../api/editor.ts'

const call = (verb: string, args: unknown, id = 1) => JSON.stringify({ v: 1, kind: 'call', id, verb, args })

describe("the bridge's verbs", () => {
  it('names each verb with what it needs: a read of the note, a write of it and a ui item', () => {
    expect(editorVerbs).toEqual(['editor.instances', 'editor.read', 'editor.decorate', 'editor.edit', 'editor.bind', 'editor.keys'])
    expect(verbNeeds['editor.instances']).toEqual({ read: false, write: false, ui: null })
    expect(verbNeeds['editor.read']).toEqual({ read: true, write: false, ui: null })
    expect(verbNeeds['editor.decorate']).toEqual({ read: true, write: false, ui: 'ui.decoration' })
    expect(verbNeeds['editor.edit']).toEqual({ read: true, write: true, ui: null })
    expect(verbNeeds['editor.bind']).toEqual({ read: false, write: false, ui: 'ui.command' })
    expect(verbNeeds['editor.keys']).toEqual({ read: false, write: false, ui: 'ui.keys' })
  })

  it('is frozen, so a slip in the page or a host half changes nothing it decides', () => {
    expect(Object.isFrozen(verbNeeds)).toBe(true)
    expect(Object.isFrozen(verbNeeds['editor.edit'])).toBe(true)
    expect(Object.getPrototypeOf(verbNeeds)).toBe(null)
  })
})

describe('a mark', () => {
  it('takes a styled range, a hidden range, a widget of text and a line style', () => {
    expect(mark.safeParse({ kind: 'mark', from: 0, to: 4, style: 'strong' }).success).toBe(true)
    expect(mark.safeParse({ kind: 'hide', from: 0, to: 2 }).success).toBe(true)
    expect(mark.safeParse({ kind: 'widget', from: 2, to: 2, text: '•' }).success).toBe(true)
    expect(mark.safeParse({ kind: 'widget', from: 0, to: 3, text: '—' }).success).toBe(true)
    expect(mark.safeParse({ kind: 'line', from: 0, style: 'h1' }).success).toBe(true)
  })

  it('knows a fixed list of styles and no class or CSS of its own', () => {
    expect(markStyles).toEqual(['strong', 'em', 'strike', 'highlight', 'code', 'link', 'muted', 'error', 'warning', 'info'])
    expect(lineStyles).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'codeblock', 'rule'])
    expect(mark.safeParse({ kind: 'mark', from: 0, to: 4, style: 'red' }).success).toBe(false)
    expect(mark.safeParse({ kind: 'mark', from: 0, to: 4, style: 'strong', class: 'x' }).success).toBe(false)
    expect(mark.safeParse({ kind: 'line', from: 0, style: 'strong' }).success).toBe(false)
  })

  it.each([
    ['a negative position', { kind: 'hide', from: -1, to: 2 }],
    ['to before from', { kind: 'mark', from: 5, to: 2, style: 'em' }],
    ['an empty styled range', { kind: 'mark', from: 2, to: 2, style: 'em' }],
    ['an empty hidden range', { kind: 'hide', from: 2, to: 2 }],
    ['a fraction', { kind: 'hide', from: 0.5, to: 2 }],
    ['a widget with a bidi control', { kind: 'widget', from: 0, to: 0, text: `a${String.fromCodePoint(0x202e)}b` }],
    ['a widget with no text', { kind: 'widget', from: 0, to: 0, text: '' }],
    ['a widget past 200 characters', { kind: 'widget', from: 0, to: 0, text: 'x'.repeat(201) }],
  ])('refuses %s', (_name, given) => {
    expect(mark.safeParse(given).success).toBe(false)
  })
})

describe('a call on the bridge', () => {
  it('reads each verb with its args', () => {
    expect(parseBridgeCall(call('editor.instances', undefined))).toEqual({ v: 1, kind: 'call', id: 1, verb: 'editor.instances' })
    expect(parseBridgeCall(call('editor.read', { instance: 'n1' }))?.verb).toBe('editor.read')
    const marks = [{ kind: 'hide', from: 0, to: 2 }]
    expect(parseBridgeCall(call('editor.decorate', { instance: 'n1', version: 3, set: 'spelling', marks }))?.args)
      .toEqual({ instance: 'n1', version: 3, set: 'spelling', marks })
    expect(parseBridgeCall(call('editor.edit', { instance: 'n1', version: 0, changes: [3, [0, 'x'], 2, [1]] }))?.verb).toBe('editor.edit')
    expect(parseBridgeCall(call('editor.bind', { bindings: [{ key: 'Mod-Shift-k', command: 'kill' }] }))?.verb).toBe('editor.bind')
    expect(parseBridgeCall(call('editor.keys', { on: true }))?.verb).toBe('editor.keys')
  })

  it.each([
    ['text that is no JSON', '{'],
    ['a __proto__ key', '{"v":1,"kind":"call","id":1,"verb":"editor.read","args":{"instance":"n1","__proto__":{"x":1}}}'],
    ['an unknown verb', call('editor.open', { path: 'a.md' })],
    ['a core action', call('core.status', undefined)],
    ['an id of 0', call('editor.read', { instance: 'n1' }, 0)],
    ['an instance id outside the grammar', call('editor.read', { instance: '../a' })],
    ['an extra field', call('editor.read', { instance: 'n1', path: 'a.md' })],
    ['5,001 marks', call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: Array.from({ length: MAX_MARKS + 1 }, () => ({ kind: 'hide', from: 0, to: 1 })) })],
    ['a set name outside the grammar', call('editor.decorate', { instance: 'n1', version: 0, set: 'a b', marks: [] })],
    ['a change list that is no change set', call('editor.edit', { instance: 'n1', version: 0, changes: [[0, 1]] })],
    ['a change list as text', call('editor.edit', { instance: 'n1', version: 0, changes: 'abc' })],
    ['a negative version', call('editor.edit', { instance: 'n1', version: -1, changes: [1] })],
    ['a binding naming no command', call('editor.bind', { bindings: [{ key: 'Mod-k' }] })],
    ['a binding on no key', call('editor.bind', { bindings: [{ key: 'Mod-', command: 'kill' }] })],
    ['a binding on a bare letter', call('editor.bind', { bindings: [{ key: 'k', command: 'kill' }] })],
    ['a binding with Shift alone', call('editor.bind', { bindings: [{ key: 'Shift-k', command: 'kill' }] })],
    ['65 bindings', call('editor.bind', { bindings: Array.from({ length: MAX_BINDINGS + 1 }, () => ({ key: 'Mod-k', command: 'kill' })) })],
    ['a key stream switch that is no boolean', call('editor.keys', { on: 'yes' })],
  ])('answers null for %s', (_name, text) => {
    expect(parseBridgeCall(text)).toBe(null)
  })
})

describe('what the drawer sends back', () => {
  it('answers a call with its result or a refusal code, never text', () => {
    expect(reply(4, { version: 2 })).toEqual({ v: 1, kind: 'reply', id: 4, ok: true, result: { version: 2 } })
    expect(refused(4, 'stale')).toEqual({ v: 1, kind: 'reply', id: 4, ok: false, refusal: { code: 'stale' } })
  })
})
