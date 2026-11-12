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
  return { n: 1, foldCase: false, plugins: Object.assign(Object.create(null), plugins), execAny: [], ...more }
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
    expect(gate.decide(access(alpha, 'ui.view', {}))).toMatchObject({ code: 'not-granted' })
  })

  it('refuses a type it has no scope rule for even to a plugin holding it, until its provider brings the fields', () => {
    const gate = gateOn({ alpha: [item({ type: 'net.fetch', hosts: ['example.com'] })] })
    expect(gate.decide(access(alpha, 'net.fetch', { paths: ['a.md'] }))).toMatchObject({ code: 'not-granted' })
  })

  it('judges history on the access and on every path, so reading old versions and committing are two grants', () => {
    const gate = gateOn({
      alpha: [item({ type: 'history', access: 'read', paths: ['notes/**'] }), item({ type: 'history', access: 'commit', paths: ['journal/**'] })],
    })
    expect(gate.decide(access(alpha, 'history', { paths: ['notes/a.md'], access: 'read' }))).toMatchObject({ allow: true })
    expect(gate.decide(access(alpha, 'history', { paths: ['notes/a.md'], access: 'commit' }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(alpha, 'history', { paths: ['journal/a.md'], access: 'commit' }))).toMatchObject({ allow: true })
    expect(gate.decide(access(alpha, 'history', { paths: ['journal/a.md'], access: 'read' }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(alpha, 'history', { paths: ['journal/a.md', 'notes/a.md'], access: 'commit' }))).toMatchObject({ code: 'not-granted' })
    // No access in the scope is no question the gate can answer
    expect(gate.decide(access(alpha, 'history', { paths: ['notes/a.md'] }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(alpha, 'history', { paths: ['notes/a.md'], access: 'rewrite' as never }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(alpha, 'history', { access: 'read' }))).toMatchObject({ code: 'not-granted' })
  })

  it('switches a history item off and asks at its first use like any other item', () => {
    const commit: Capability = { type: 'history', access: 'commit', paths: ['**'] }
    expect(gateOn({ alpha: [item(commit, { off: true })] }).decide(access(alpha, 'history', { paths: ['a.md'], access: 'commit' })))
      .toMatchObject({ code: 'switched-off' })
    const asked = gateOn({ alpha: [item(commit, { firstUse: true })] }).decide(access(alpha, 'history', { paths: ['a.md'], access: 'commit' }))
    expect(JSON.parse((asked as { ask: string }).ask)).toEqual([['access', 'commit'], ['paths', ['**']], ['type', 'history']])
  })

  it('lets the editor window read history and never commit', () => {
    const gate = gateOn({})
    expect(gate.decide(access(editor, 'history', { paths: ['notes/a.md'], access: 'read' }))).toMatchObject({ allow: true })
    expect(gate.decide(access(editor, 'history', { paths: ['notes/a.md'], access: 'commit' }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(editor, 'history', { paths: ['notes/.todo.md'], access: 'read' }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(trusted, 'history', { paths: ['notes/a.md'], access: 'read' }))).toMatchObject({ code: 'not-granted' })
  })

  it('judges exec on the whole argument array, never on its words joined', () => {
    const gate = gateOn({ alpha: [item({ type: 'exec', commands: [['git', 'status'], ['git', 'log', '--oneline']], env: ['HOME'] })] })
    expect(gate.decide(access(alpha, 'exec', { command: ['git', 'status'] }))).toMatchObject({ allow: true })
    expect(gate.decide(access(alpha, 'exec', { command: ['git', 'log', '--oneline'] }))).toMatchObject({ allow: true })
    for (const command of [['git'], ['git', 'status', '--short'], ['git status'], ['git', 'log --oneline'], ['GIT', 'status'], ['status', 'git'], []]) {
      expect(gate.decide(access(alpha, 'exec', { command }))).toMatchObject({ code: 'not-granted' })
    }
    expect(gate.decide(access(alpha, 'exec', {}))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(alpha, 'exec', { command: 'git status' as never }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(alpha, 'exec', { command: ['git', 7 as never] }))).toMatchObject({ code: 'not-granted' })
    expect(gate.decide(access(editor, 'exec', { command: ['git', 'status'] }))).toMatchObject({ code: 'not-granted' })
  })

  it('switches one exec item off and asks at the first use of another, each by its own commands', () => {
    const status: Capability = { type: 'exec', commands: [['git', 'status']], env: [] }
    const push: Capability = { type: 'exec', commands: [['git', 'push']], env: ['HOME'] }
    const gate = gateOn({ alpha: [item(status, { off: true }), item(push, { firstUse: true })] })
    expect(gate.decide(access(alpha, 'exec', { command: ['git', 'status'] }))).toMatchObject({ code: 'switched-off' })
    const asked = gate.decide(access(alpha, 'exec', { command: ['git', 'push'] }))
    expect(JSON.parse((asked as { ask: string }).ask)).toEqual([['commands', [['git', 'push']]], ['env', ['HOME']], ['type', 'exec']])
  })

  it('lets a plugin the human named in execAny run a command past its list, only while it holds an exec item that is on', () => {
    const status: Capability = { type: 'exec', commands: [['git', 'status']], env: [] }
    const any = gateOn({ alpha: [item(status)], beta: [item(notes)] }, { execAny: ['alpha', 'beta', 'gamma'] })
    expect(any.decide(access(alpha, 'exec', { command: ['curl', 'https://example.com'] }))).toMatchObject({ allow: true })
    expect(any.decide(access(alpha, 'exec', { command: ['git', 'status'] }))).toMatchObject({ allow: true })
    // The switch lifts the list. It hands exec to no plugin that never held it
    const beta: Caller = { ...alpha, id: 'beta' }
    const gamma: Caller = { ...alpha, id: 'gamma' }
    expect(any.decide(access(beta, 'exec', { command: ['curl'] }))).toMatchObject({ code: 'not-granted' })
    expect(any.decide(access(gamma, 'exec', { command: ['curl'] }))).toMatchObject({ code: 'not-granted' })
    expect(any.decide(access(alpha, 'exec', {}))).toMatchObject({ code: 'not-granted' })
    const off = gateOn({ alpha: [item(status, { off: true })] }, { execAny: ['alpha'] })
    expect(off.decide(access(alpha, 'exec', { command: ['curl'] }))).toMatchObject({ code: 'switched-off' })
    const asking = gateOn({ alpha: [item(status, { firstUse: true })] }, { execAny: ['alpha'] })
    expect(asking.decide(access(alpha, 'exec', { command: ['curl'] }))).toMatchObject({ ask: expect.any(String) })
    // Not named, the list holds
    const listed = gateOn({ alpha: [item(status)] }, { execAny: ['beta'] })
    expect(listed.decide(access(alpha, 'exec', { command: ['curl'] }))).toMatchObject({ code: 'not-granted' })
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

// The carrier hands a move's write as both ends in one scope and its read as the from end alone
describe('a move, judged on both its ends', () => {
  const sorter = { alpha: [item({ type: 'luoshu.write', paths: ['public/**'] }), item({ type: 'luoshu.read', paths: ['**'] })] }
  const move = (paths: string[], stage: Access['stage']): Access => ({ ...access(alpha, 'luoshu.write', { paths }, stage), action: 'luoshu.move' })

  it.each(['raw', 'canonical'] as const)('refuses a move granted on one end only, whichever end that is, at the %s stage', stage => {
    const gate = gateOn(sorter)
    expect(gate.decide(move(['public/a.md', 'private/a.md'], stage))).toMatchObject({ allow: false, code: 'not-granted' })
    expect(gate.decide(move(['private/a.md', 'public/a.md'], stage))).toMatchObject({ allow: false, code: 'not-granted' })
    expect(gate.decide(move(['public/a.md', 'public/old/a.md'], stage))).toMatchObject({ allow: true })
  })

  it('refuses a move with one end inside an item switched off and asks for one whose first use asks on either end', () => {
    const write = (more: Partial<GrantedItem>) => item({ type: 'luoshu.write', paths: ['private/**'] }, more)
    const off = gateOn({ alpha: [...sorter.alpha, write({ off: true })] })
    expect(off.decide(move(['private/a.md', 'public/a.md'], 'canonical'))).toMatchObject({ allow: false, code: 'switched-off' })
    expect(off.decide(move(['public/a.md', 'private/a.md'], 'canonical'))).toMatchObject({ allow: false, code: 'switched-off' })
    const asking = gateOn({ alpha: [...sorter.alpha, write({ firstUse: true })] })
    expect(asking.decide(move(['public/a.md', 'private/a.md'], 'canonical'))).toEqual({ ask: expect.any(String), view: 1 })
    expect(asking.decide(move(['private/a.md', 'public/a.md'], 'canonical'))).toEqual({ ask: expect.any(String), view: 1 })
  })
})

// Changing an open note through the editor, which the human then saves. It reaches the disk through no action
describe('ui.edit', () => {
  const edits = { alpha: [item({ type: 'ui.edit', paths: ['notes/**'] }), item({ type: 'luoshu.read', paths: ['**'] })] }

  it('covers the paths it names and no other', () => {
    const gate = gateOn(edits)
    expect(gate.decide(access(alpha, 'ui.edit', { paths: ['notes/a.md'] }))).toMatchObject({ allow: true })
    expect(gate.decide(access(alpha, 'ui.edit', { paths: ['journal/a.md'] }))).toMatchObject({ allow: false, code: 'not-granted' })
  })

  it('serves no action that changes the disk, whatever its scope', () => {
    const gate = gateOn({ alpha: [item({ type: 'ui.edit', paths: ['**'] })] })
    for (const action of ['luoshu.write', 'luoshu.remove', 'luoshu.move', 'leases.acquire']) {
      const asked = { ...access(alpha, 'luoshu.write', { paths: ['notes/a.md'] }), action }
      expect(gate.decide(asked)).toMatchObject({ allow: false, code: 'not-granted' })
    }
  })

  it('is no verb the editor serves on holding alone, since it reaches only the notes it names', () => {
    const gate = gateOn({ alpha: [item({ type: 'ui.edit', paths: ['**'] }), item({ type: 'ui.decoration' })] })
    expect(gate.verbs('alpha', 'editor')).toEqual(['ui.decoration'])
  })
})

describe('windows', () => {
  it('judges the editor on core/api\'s fixed grants, whatever the StateView holds, and the trusted window on none', () => {
    const gate = gateOn({ alpha: [item(notes)] })
    expect(gate.decide(access(editor, 'luoshu.write', { paths: ['notes/a.md'] }))).toMatchObject({ allow: true })
    // Windows read the log through core actions the floor decides, so the editor holds no log.read
    expect(gate.decide(access(editor, 'log.read', {}))).toMatchObject({ code: 'not-granted' })
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

  it('lets a caller see a name through a list or read item switched on and confirmed, and read through a list item never', () => {
    const tree: Capability = { type: 'luoshu.list', paths: ['projects/**'] }
    const beta: Caller = { ...alpha, id: 'beta' }
    const gate = gateOn({
      alpha: [item(notes), item(tree), item({ type: 'luoshu.list', paths: ['journal/**'] }, { off: true }), item({ type: 'luoshu.list', paths: ['inbox/**'] }, { firstUse: true })],
    })
    expect(gate.canList(alpha, 'notes/a.md')).toBe(true)
    expect(gate.canList(alpha, 'projects/plan.md')).toBe(true)
    expect(gate.canRead(alpha, 'projects/plan.md')).toBe(false)
    expect(gate.decide(access(alpha, 'luoshu.read', { paths: ['projects/plan.md'] }))).toMatchObject({ code: 'not-granted' })
    expect(gate.canList(alpha, 'journal/a.md')).toBe(false)
    expect(gate.canList(alpha, 'inbox/a.md')).toBe(false)
    expect(gate.canList(alpha, 'other/a.md')).toBe(false)
    expect(gate.canList(editor, 'other/a.md')).toBe(true)
    expect(gate.canList(editor, '.scratch.md')).toBe(false)
    expect(gate.canList(trusted, 'notes/a.md')).toBe(false)
    expect(gate.canList(beta, 'notes/a.md')).toBe(false)
  })

  it('gives the ui types a plugin holds switched on as its verbs in the editor, and none in the trusted window', () => {
    const gate = gateOn({
      alpha: [item({ type: 'ui.view' }), item({ type: 'ui.command' }, { off: true }), item({ type: 'ui.keys' }, { firstUse: true }), item(notes)],
    })
    expect(gate.verbs('alpha', 'editor')).toEqual(['ui.view'])
    expect(gate.verbs('alpha', 'trusted')).toEqual([])
    expect(gate.verbs('beta', 'editor')).toEqual([])
  })
})

describe('the StateView', () => {
  it('throws on one it can\'t read, which marks the gate failed', () => {
    const gate = createGate()
    expect(() => gate.stateChanged({ n: 1.5, foldCase: false, plugins: {}, execAny: [] })).toThrow()
    expect(() => gate.stateChanged({ n: 1, foldCase: false, plugins: {}, execAny: 'alpha' } as never)).toThrow()
    expect(() => gate.stateChanged({ n: 1, foldCase: false, plugins: {}, execAny: [7] } as never)).toThrow()
    expect(() => gate.stateChanged({ n: 1, foldCase: false, plugins: {} } as never)).toThrow()
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
      ['luoshu.remove', 'luoshu.write', 'path', 'paths'],
      ['luoshu.move', 'luoshu.write', 'ends', 'paths'],
      ['leases.acquire', 'luoshu.write', 'paths', 'paths'],
      ['history.commit', 'history', 'paths', 'access'],
      ['history.log', 'history', 'path', 'access'],
      ['history.read', 'history', 'path', 'access'],
      ['exec.run', 'exec', 'command', 'command'],
    ])
    for (const [, , scope, rule] of rows) {
      expect(rule).not.toBe('none')
      // Paths are judged by the paths rule or, with an access beside them, by history's. A command by exec's
      expect(rule === 'command').toBe(scope === 'command')
      expect(rule === 'paths' || rule === 'access').toBe(scope === 'path' || scope === 'paths' || scope === 'ends')
    }
    // A second requirement is judged on paths too
    for (const [, action] of Object.entries(providerActions)) {
      if (action.also !== undefined) expect(scopeRules[action.also.capability]).toBe('paths')
    }
    // A history action names its access in core/api, which the carrier puts in the scope
    for (const [name, capability] of rows) expect('access' in providerActions[name as string]).toBe(capability === 'history')
    expect(scopeRules['events.subscribe']).toBe('topics')
    expect(scopeRules['plugin.call']).toBe('target')
  })
})
