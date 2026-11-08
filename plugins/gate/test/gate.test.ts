import { describe, expect, it } from 'vitest'
import { providerActions } from 'hetu-core/api/actions.ts'
import { capabilityTypes, type Capability } from 'hetu-core/api/capabilities.ts'
import type { Caller } from 'hetu-core/api/envelope.ts'
import type { Access, GrantedItem, Scope, StateView } from 'hetu-core/api/slots.ts'
import { createGate, scopeRules } from '../src/gate.ts'

const alpha: Caller = { kind: 'plugin', id: 'alpha', half: 'worker', incarnation: 1 }
const editor: Caller = { kind: 'window', role: 'editor', n: 0 }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 0 }

const item = (capability: Capability, more: Partial<GrantedItem> = {}): GrantedItem =>
  ({ capability, off: false, firstUse: false, ...more })

function view(plugins: Record<string, GrantedItem[]>, more: Partial<StateView> = {}): StateView {
  return { n: 1, foldCase: false, plugins: Object.assign(Object.create(null), plugins), ...more }
}

function access(caller: Caller, capability: Access['capability'], scope: Scope, stage: Access['stage'] = 'canonical'): Access {
  return { stage, caller, action: 'test.action', capability, scope }
}

// A gate given one StateView
function gateOn(plugins: Record<string, GrantedItem[]>, more: Partial<StateView> = {}) {
  const gate = createGate()
  gate.stateChanged(view(plugins, more))
  return gate
}

const notes: Capability = { type: 'luoshu.read', paths: ['notes/**'] }

describe('deciding', () => {
  it('allows a plugin a path inside an item it holds and refuses one outside, naming the StateView it decided on', () => {
    const gate = gateOn({ alpha: [item(notes)] }, { n: 7 })
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: ['notes/a.md'] }))).toEqual({ allow: true, view: 7 })
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: ['journal/a.md'] }))).toEqual({ allow: false, code: 'not-granted', view: 7 })
    expect(gate.decide(access(alpha, 'luoshu.write', { paths: ['notes/a.md'] }))).toMatchObject({ allow: false, code: 'not-granted' })
  })

  it('needs every path of a call inside the grants, each through any item of the type', () => {
    const gate = gateOn({ alpha: [item({ type: 'luoshu.write', paths: ['a/**'] }), item({ type: 'luoshu.write', paths: ['b/**'] })] })
    expect(gate.decide(access(alpha, 'luoshu.write', { paths: ['a/1.md', 'b/2.md'] }))).toMatchObject({ allow: true })
    expect(gate.decide(access(alpha, 'luoshu.write', { paths: ['a/1.md', 'c/3.md'] }))).toMatchObject({ allow: false, code: 'not-granted' })
  })

  it('answers switched-off for a path inside only items switched off, and allows one an item still on covers', () => {
    const gate = gateOn({ alpha: [item(notes, { off: true }), item({ type: 'luoshu.read', paths: ['notes/public/**'] })] })
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: ['notes/a.md'] }))).toMatchObject({ allow: false, code: 'switched-off' })
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: ['notes/public/a.md'] }))).toMatchObject({ allow: true })
    // Outside every item is not-granted, even with one switched off
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: ['journal/a.md'] }))).toMatchObject({ allow: false, code: 'not-granted' })
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: ['notes/a.md', 'journal/a.md'] }))).toMatchObject({ code: 'not-granted' })
  })

  it('asks at the canonical stage for an item whose first use asks, naming the item, and allows it at the raw stage, which can only refuse', () => {
    const gate = gateOn({ alpha: [item(notes, { firstUse: true })] })
    const asked = gate.decide(access(alpha, 'luoshu.read', { paths: ['notes/a.md'] }))
    expect(asked).toEqual({ ask: expect.any(String), view: 1 })
    expect(JSON.parse((asked as { ask: string }).ask)).toEqual([['paths', ['notes/**']], ['type', 'luoshu.read']])
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: ['notes/a.md'] }, 'raw'))).toEqual({ allow: true, view: 1 })
    // A switched-off item never asks
    const off = gateOn({ alpha: [item(notes, { firstUse: true, off: true })] })
    expect(off.decide(access(alpha, 'luoshu.read', { paths: ['notes/a.md'] }))).toMatchObject({ code: 'switched-off' })
  })

  it('judges a subscribe on every topic and a plugin call on its target', () => {
    const gate = gateOn({
      alpha: [item({ type: 'events.subscribe', topics: ['luoshu.changed'] }), item({ type: 'plugin.call', targets: ['search'] })],
    })
    expect(gate.decide(access(alpha, 'events.subscribe', { topics: ['luoshu.changed'] }))).toMatchObject({ allow: true })
    expect(gate.decide(access(alpha, 'events.subscribe', { topics: ['luoshu.changed', 'search.indexed'] }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(alpha, 'plugin.call', { target: 'search' }))).toMatchObject({ allow: true })
    expect(gate.decide(access(alpha, 'plugin.call', { target: 'git' }))).toMatchObject({ code: 'not-granted' })
  })

  it('allows a type with no scope to a plugin holding it', () => {
    const gate = gateOn({ alpha: [item({ type: 'log.read' })] })
    expect(gate.decide(access(alpha, 'log.read', {}))).toMatchObject({ allow: true })
    expect(gate.decide(access(alpha, 'ui.panel', {}))).toMatchObject({ code: 'not-granted' })
  })

  it('refuses a type it has no scope rule for even to a plugin holding it, until its provider brings the fields', () => {
    const gate = gateOn({
      alpha: [
        item({ type: 'net.fetch', hosts: ['example.com'] }),
        item({ type: 'history', access: 'read', paths: ['**'] }),
        item({ type: 'exec', commands: [['git', 'status']], env: [] }),
      ],
    })
    for (const capability of ['net.fetch', 'history', 'exec'] as const) {
      expect(gate.decide(access(alpha, capability, { paths: ['a.md'] }))).toMatchObject({ code: 'not-granted' })
    }
  })

  it('refuses a plugin holding nothing, a content caller and a scope without the field its type is judged on', () => {
    const gate = gateOn({ alpha: [item(notes), item({ type: 'plugin.call', targets: ['search'] })] })
    const beta: Caller = { ...alpha, id: 'beta' }
    expect(gate.decide(access(beta, 'luoshu.read', { paths: ['notes/a.md'] }))).toMatchObject({ code: 'not-granted' })
    const content: Caller = { kind: 'content', plugin: 'alpha', token: 'a'.repeat(32) }
    expect(gate.decide(access(content, 'luoshu.read', { paths: ['notes/a.md'] }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(alpha, 'luoshu.read', {}))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: [] }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(alpha, 'plugin.call', {}))).toMatchObject({ code: 'not-granted' })
  })

  it('refuses an id every object has rather than finding a grant there', () => {
    const gate = gateOn({ alpha: [item(notes)] })
    const constructor: Caller = { ...alpha, id: 'constructor' }
    expect(gate.decide(access(constructor, 'luoshu.read', { paths: ['notes/a.md'] }))).toMatchObject({ code: 'not-granted' })
  })

  it('matches with case unless the StateView says the volume folds case', () => {
    const grant = { alpha: [item({ type: 'luoshu.read', paths: ['Notes/**'] })] }
    expect(gateOn(grant).decide(access(alpha, 'luoshu.read', { paths: ['notes/a.md'] }))).toMatchObject({ code: 'not-granted' })
    expect(gateOn(grant, { foldCase: true }).decide(access(alpha, 'luoshu.read', { paths: ['notes/a.md'] }))).toMatchObject({ allow: true })
  })

  it('decides on the newest StateView it was given', () => {
    const gate = gateOn({ alpha: [item(notes)] })
    gate.stateChanged(view({ alpha: [item({ type: 'luoshu.read', paths: ['journal/**'] })] }, { n: 2 }))
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: ['notes/a.md'] }))).toEqual({ allow: false, code: 'not-granted', view: 2 })
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: ['journal/a.md'] }))).toEqual({ allow: true, view: 2 })
  })
})

describe('windows', () => {
  it('judges the editor on core/api\'s fixed grants, whatever the StateView holds, and the trusted window on none', () => {
    const gate = gateOn({ alpha: [item(notes)] })
    expect(gate.decide(access(editor, 'luoshu.write', { paths: ['notes/a.md'] }))).toMatchObject({ allow: true })
    expect(gate.decide(access(editor, 'log.read', {}))).toMatchObject({ allow: true })
    expect(gate.decide(access(editor, 'events.subscribe', { topics: ['luoshu.changed'] }))).toMatchObject({ allow: true })
    // ** leaves out dot files and dot folders
    expect(gate.decide(access(editor, 'luoshu.read', { paths: ['.scratch.md'] }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(editor, 'plugin.call', { target: 'alpha' }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(trusted, 'luoshu.read', { paths: ['notes/a.md'] }))).toMatchObject({ code: 'not-granted' })
  })
})

describe('reading on another\'s behalf', () => {
  it('lets a caller read a path only through a read item switched on and confirmed, windows through their grants', () => {
    const gate = gateOn({ alpha: [item(notes), item({ type: 'luoshu.read', paths: ['journal/**'] }, { off: true })] })
    expect(gate.canRead(alpha, 'notes/a.md')).toBe(true)
    expect(gate.canRead(alpha, 'journal/a.md')).toBe(false)
    expect(gate.canRead(alpha, 'other/a.md')).toBe(false)
    expect(gate.canRead(editor, 'other/a.md')).toBe(true)
    expect(gate.canRead(editor, 'notes/.todo.md')).toBe(false)
    expect(gate.canRead(trusted, 'notes/a.md')).toBe(false)
    const asking = gateOn({ alpha: [item(notes, { firstUse: true })] })
    expect(asking.canRead(alpha, 'notes/a.md')).toBe(false)
  })

  it('gives the ui types a plugin holds switched on as its verbs in the editor, and none in the trusted window', () => {
    const gate = gateOn({
      alpha: [item({ type: 'ui.panel' }), item({ type: 'ui.command' }, { off: true }), item({ type: 'ui.keys' }, { firstUse: true }), item(notes)],
    })
    expect(gate.verbs('alpha', 'editor')).toEqual(['ui.panel'])
    expect(gate.verbs('alpha', 'trusted')).toEqual([])
    expect(gate.verbs('beta', 'editor')).toEqual([])
  })
})

describe('the StateView', () => {
  it('throws on one it can\'t read, which marks the gate failed', () => {
    const gate = createGate()
    expect(() => gate.stateChanged({ n: 1.5, foldCase: false, plugins: {} })).toThrow()
    expect(() => gate.stateChanged({ n: 1, foldCase: 'no', plugins: {} } as never)).toThrow()
    expect(() => gate.stateChanged({ n: 1, foldCase: false } as never)).toThrow()
    expect(() => gate.stateChanged(view({ alpha: [{ capability: notes } as never] }))).toThrow()
  })

  it('throws when asked before it has one, which refuses the call', () => {
    expect(() => createGate().decide(access(alpha, 'luoshu.read', { paths: ['notes/a.md'] }))).toThrow()
  })
})

describe('coverage', () => {
  it('has a rule for every capability type', () => {
    expect(Object.keys(scopeRules).sort()).toEqual([...capabilityTypes].sort())
  })

  // Every action core/api serves with a capability, the scope the carrier hands the gate and how the gate judges it.
  // A new action fails here until this table says how the gate judges it. The carrier asks the gate at precheck and at
  // decide for each, events.subscribe on the topics it names and a plugin call on its target
  it('judges every action in core/api on the scope the carrier hands it', () => {
    const rows = Object.entries(providerActions)
      .filter(([, action]) => action.capability !== null)
      .map(([name, action]) => [name, action.capability, action.scope, scopeRules[action.capability!]])
    expect(rows).toEqual([
      ['luoshu.read', 'luoshu.read', 'path', 'paths'],
      ['luoshu.write', 'luoshu.write', 'path', 'paths'],
      ['leases.acquire', 'luoshu.write', 'paths', 'paths'],
      ['log.history', 'log.read', null, 'held'],
      ['log.verify', 'log.read', null, 'held'],
    ])
    for (const [, , scope, rule] of rows) {
      expect(rule).not.toBe('none')
      expect(rule === 'paths').toBe(scope !== null)
    }
    expect(scopeRules['events.subscribe']).toBe('topics')
    expect(scopeRules['plugin.call']).toBe('target')
  })
})
