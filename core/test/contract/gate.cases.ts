import { expect, it } from 'vitest'
import { capabilityTypes, type Capability, type CapabilityType } from '../../api/capabilities.ts'
import type { Caller } from '../../api/envelope.ts'
import type { Access, Gate, Pair, Scope } from '../../api/policy-jobs.ts'
import { editorCaller, pluginCaller } from './ask.ts'

// What a gate is made with: each plugin's grants, every item on and none asking at first use, and each pair's by the
// root plugin's id and the field. reader is the plugin a fake core runs under test and other is a test caller
export type Grants = { plugins: Record<string, Capability[]>, pairs?: Record<string, Record<string, Capability[]>> }

const reader = pluginCaller('reader')
const other = pluginCaller('other')
const allow = { allow: true, view: 1 }
const refuse = { allow: false, code: 'not-granted', view: 1 }

// One item of each type with the scope that reaches it and whether an access with an empty scope passes. A type added
// to core/api fails the case that reads this until it is listed here
const everyType: Record<CapabilityType, [Capability, Scope, boolean]> = {
  'luoshu.read': [{ type: 'luoshu.read', paths: ['**'] }, { paths: ['a.md'] }, false],
  'luoshu.write': [{ type: 'luoshu.write', paths: ['**'] }, { paths: ['a.md'] }, false],
  'luoshu.list': [{ type: 'luoshu.list', paths: ['**'] }, { paths: ['a.md'] }, false],
  'ui.edit': [{ type: 'ui.edit', paths: ['**'] }, { paths: ['a.md'] }, false],
  'ui.read': [{ type: 'ui.read', paths: ['**'] }, { paths: ['a.md'] }, false],
  'lock.set': [{ type: 'lock.set', paths: ['**'] }, { paths: ['a.md'] }, false],
  history: [{ type: 'history', access: 'read', paths: ['**'] }, { access: 'read', paths: ['a.md'] }, false],
  'events.subscribe': [{ type: 'events.subscribe', topics: ['luoshu.changed'] }, { topics: ['luoshu.changed'] }, false],
  'plugin.call': [{ type: 'plugin.call', targets: ['search'] }, { target: 'search' }, false],
  exec: [{ type: 'exec', commands: [['git', 'status']], env: [] }, { command: ['git', 'status'] }, false],
  'net.fetch': [{ type: 'net.fetch', hosts: ['example.com'] }, {}, false],
  'ui.view': [{ type: 'ui.view' }, {}, true],
  'ui.decoration': [{ type: 'ui.decoration' }, {}, true],
  'ui.command': [{ type: 'ui.command' }, {}, true],
  'ui.keystream': [{ type: 'ui.keystream' }, {}, true],
  storage: [{ type: 'storage' }, {}, true],
  'guard.hook': [{ type: 'guard.hook' }, {}, true],
  'log.read': [{ type: 'log.read' }, {}, true],
  'door.handle': [{ type: 'door.handle' }, {}, true],
}

// One canonical access, as the router asks for a call with power
function access(caller: Caller, capability: Access['capability'], scope: Scope, pair?: Pair): Access {
  return { stage: 'canonical', caller, root: caller, action: capability, capability, scope, ...(pair === undefined ? {} : { pair }) }
}

// The gate policy job's decide, canRead, canList and verbs for each caller kind and a pair, on a volume that keeps case
export function gateCases(make: (grants: Grants) => Gate): void {
  it('allows the paths an item covers, every path of an access, and keeps case', () => {
    const gate = make({ plugins: { reader: [{ type: 'luoshu.read', paths: ['notes/**'] }], other: [{ type: 'luoshu.write', paths: ['notes/a.md'] }] } })
    expect(gate.decide(access(reader, 'luoshu.read', { paths: ['notes/a.md', 'notes/deep/b.md'] }))).toEqual(allow)
    for (const paths of [['secret/b.md'], ['notes/a.md', 'secret/b.md'], ['Notes/a.md']]) {
      expect(gate.decide(access(reader, 'luoshu.read', { paths })), paths.join()).toEqual(refuse)
    }
    expect(gate.decide(access(reader, 'luoshu.write', { paths: ['notes/a.md'] }))).toEqual(refuse)
    expect(gate.decide(access(other, 'luoshu.write', { paths: ['notes/a.md'] }))).toEqual(allow)
    expect(gate.decide(access(pluginCaller('nobody'), 'luoshu.read', { paths: ['notes/a.md'] }))).toEqual(refuse)
  })

  it('refuses an access whose scope lacks what its type is judged on', () => {
    const gate = make({ plugins: { reader: [
      { type: 'luoshu.read', paths: ['**'] }, { type: 'events.subscribe', topics: ['luoshu.changed'] },
      { type: 'plugin.call', targets: ['search'] }, { type: 'history', access: 'read', paths: ['**'] }, { type: 'exec', commands: [['git', 'status']], env: [] },
    ] } })
    for (const [capability, scope] of [
      ['luoshu.read', {}], ['luoshu.read', { paths: [] }], ['events.subscribe', { topics: [] }], ['events.subscribe', {}],
      ['plugin.call', {}], ['history', { paths: ['a.md'] }], ['exec', {}], ['exec', { command: [] }],
    ] as const) expect(gate.decide(access(reader, capability, scope)), `${capability} ${JSON.stringify(scope)}`).toEqual(refuse)
  })

  it('lets each path or topic of an access be covered by a different item of its type', () => {
    const gate = make({ plugins: { reader: [
      { type: 'luoshu.read', paths: ['a/**'] }, { type: 'luoshu.read', paths: ['b/**'] },
      { type: 'events.subscribe', topics: ['luoshu.changed'] }, { type: 'events.subscribe', topics: ['lock.changed'] },
    ] } })
    expect(gate.decide(access(reader, 'luoshu.read', { paths: ['a/x.md', 'b/y.md'] }))).toEqual(allow)
    expect(gate.decide(access(reader, 'luoshu.read', { paths: ['a/x.md', 'c/z.md'] }))).toEqual(refuse)
    expect(gate.decide(access(reader, 'events.subscribe', { topics: ['luoshu.changed', 'lock.changed'] }))).toEqual(allow)
  })

  it('judges every capability type: held, it passes on the scope that reaches it, and with an empty scope only when it needs none', () => {
    expect(Object.keys(everyType).sort()).toEqual([...capabilityTypes].sort())
    for (const [type, [item, scope, bare]] of Object.entries(everyType) as [CapabilityType, [Capability, Scope, boolean]][]) {
      const gate = make({ plugins: { reader: [item] } })
      // net.fetch's scope holds no host yet, so nothing reaches it
      expect(gate.decide(access(reader, type, scope)), `${type} reached`).toEqual(type === 'net.fetch' ? refuse : allow)
      expect(gate.decide(access(reader, type, {})), `${type} empty`).toEqual(bare ? allow : refuse)
      expect(make({ plugins: {} }).decide(access(reader, type, scope)), `${type} not held`).toEqual(refuse)
    }
  })

  it('judges history by the access an item names, exec by the whole argument array and refuses net.fetch', () => {
    const gate = make({ plugins: { reader: [
      { type: 'history', access: 'read', paths: ['notes/**'] }, { type: 'exec', commands: [['git', 'status']], env: [] }, { type: 'net.fetch', hosts: ['example.com'] },
    ] } })
    expect(gate.decide(access(reader, 'history', { access: 'read', paths: ['notes/a.md'] }))).toEqual(allow)
    expect(gate.decide(access(reader, 'history', { access: 'commit', paths: ['notes/a.md'] }))).toEqual(refuse)
    expect(gate.decide(access(reader, 'exec', { command: ['git', 'status'] }))).toEqual(allow)
    for (const command of [['git', 'status', '-s'], ['status', 'git'], ['git'], ['git', 42 as unknown as string]]) {
      expect(gate.decide(access(reader, 'exec', { command })), command.join(' ')).toEqual(refuse)
    }
    expect(gate.decide(access(reader, 'net.fetch', {}))).toEqual(refuse)
  })

  it('holds a type with no scope by its item, plugin.call by target and events.subscribe by every topic', () => {
    const gate = make({ plugins: { reader: [
      { type: 'storage' }, { type: 'ui.view' }, { type: 'plugin.call', targets: ['search'] }, { type: 'events.subscribe', topics: ['luoshu.changed'] },
    ] } })
    for (const capability of ['storage', 'ui.view'] as const) expect(gate.decide(access(reader, capability, {}))).toEqual(allow)
    expect(gate.decide(access(reader, 'log.read', {}))).toEqual(refuse)
    expect(gate.decide(access(reader, 'plugin.call', { target: 'search' }))).toEqual(allow)
    expect(gate.decide(access(reader, 'plugin.call', { target: 'tags' }))).toEqual(refuse)
    expect(gate.decide(access(reader, 'events.subscribe', { topics: ['luoshu.changed'] }))).toEqual(allow)
    expect(gate.decide(access(reader, 'events.subscribe', { topics: ['luoshu.changed', 'lock.changed'] }))).toEqual(refuse)
  })

  it('judges a window on core/api\'s window grants and a content caller as holding nothing', () => {
    const gate = make({ plugins: {} })
    expect(gate.decide(access(editorCaller, 'luoshu.write', { paths: ['notes/a.md'] }))).toEqual(allow)
    expect(gate.decide(access(editorCaller, 'history', { access: 'commit', paths: ['notes/a.md'] }))).toEqual(refuse)
    expect(gate.decide(access(editorCaller, 'exec', { command: ['ls'] }))).toEqual(refuse)
    expect(gate.decide(access({ kind: 'window', role: 'trusted', n: 0 }, 'storage', {}))).toEqual(refuse)
    expect(gate.canRead(editorCaller, 'notes/a.md')).toBe(true)
    expect(gate.canRead({ kind: 'content', plugin: 'reader', token: 'a'.repeat(32) }, 'notes/a.md')).toBe(false)
  })

  it('needs the caller\'s items and the pair\'s both, a pair holding only the types pairTypes lists', () => {
    const pair = { plugin: 'reader', field: 'client' }
    const gate = make({
      plugins: { reader: [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'storage' }] },
      pairs: { reader: { client: [{ type: 'luoshu.read', paths: ['notes/a.md', 'secret/**'] }, { type: 'storage' }] } },
    })
    expect(gate.decide(access(reader, 'luoshu.read', { paths: ['notes/a.md'] }, pair))).toEqual(allow)
    for (const path of ['notes/b.md', 'secret/c.md']) expect(gate.decide(access(reader, 'luoshu.read', { paths: [path] }, pair)), path).toEqual(refuse)
    expect(gate.decide(access(reader, 'storage', {}, pair))).toEqual(refuse)
    expect(gate.decide(access(reader, 'luoshu.read', { paths: ['notes/a.md'] }, { plugin: 'reader', field: 'stranger' }))).toEqual(refuse)
    expect([gate.canRead(reader, 'notes/a.md', pair), gate.canRead(reader, 'notes/b.md', pair), gate.canRead(reader, 'secret/c.md', pair)]).toEqual([true, false, false])
  })

  it('lists through luoshu.list or luoshu.read and reads only through luoshu.read', () => {
    const gate = make({ plugins: { reader: [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'luoshu.list', paths: ['shared/**'] }] } })
    expect(['notes/a.md', 'shared/a.md', 'secret/a.md'].map(path => [gate.canRead(reader, path), gate.canList(reader, path)]))
      .toEqual([[true, true], [false, true], [false, false]])
  })

  it('names the ui verbs a plugin holds whole in the editor, none scoped by paths and none in another window', () => {
    const gate = make({ plugins: { reader: [{ type: 'ui.command' }, { type: 'ui.view' }, { type: 'ui.edit', paths: ['**'] }, { type: 'storage' }] } })
    expect(gate.verbs('reader', 'editor').sort()).toEqual(['ui.command', 'ui.view'])
    expect(gate.verbs('reader', 'trusted')).toEqual([])
    expect(gate.verbs('nobody', 'editor')).toEqual([])
  })
}
