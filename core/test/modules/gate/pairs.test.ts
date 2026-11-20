import { describe, expect, it } from 'vitest'
import { capabilityTypes, pairTypes, type Capability } from '../../../api/capabilities.ts'
import type { Caller } from '../../../api/envelope.ts'
import type { Access, Call, GrantedItem, GrantsSnapshot, LiveCall, Pair, PluginTable, Scope } from '../../../api/policy-jobs.ts'
import { createGateActions } from '../../../backend/policy/gate/actions.ts'
import { createGate } from '../../../backend/policy/gate/gate.ts'

const plugin = (id: string, half = 'worker'): Caller => ({ kind: 'plugin', id, half, incarnation: 1 })
const handler = plugin('mcp-http-handler', 'host')
const mcp = plugin('mcp')
const search = plugin('search')

const item = (capability: Capability): GrantedItem => ({ capability, off: false, firstUse: false })
const table = <T>(entries: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), entries)
const pair = (field: string, root = 'mcp-http-handler'): Pair => ({ plugin: root, field })

// One item of each type, scoped to everything
const everything: Capability[] = [
  { type: 'luoshu.read', paths: ['**'] }, { type: 'luoshu.write', paths: ['**'] }, { type: 'luoshu.list', paths: ['**'] },
  { type: 'ui.edit', paths: ['**'] }, { type: 'ui.read', paths: ['**'] }, { type: 'net.fetch', hosts: ['example.com'] },
  { type: 'ui.view' }, { type: 'ui.layout' }, { type: 'ui.decoration' }, { type: 'ui.command' }, { type: 'ui.keys' },
  { type: 'events.subscribe', topics: ['search.found'] }, { type: 'storage' }, { type: 'history', access: 'read', paths: ['**'] },
  { type: 'history', access: 'commit', paths: ['**'] }, { type: 'exec', commands: [['git', 'status']], env: [] },
  { type: 'plugin.call', targets: ['search'] }, { type: 'guard.hook' }, { type: 'log.read' },
]

// What a call of each type reaches, judged at the canonical stage
const scopeOf = (capability: Capability): Scope => {
  if ('paths' in capability) return { paths: ['inbox/a.md'], ...(capability.type === 'history' ? { access: capability.access } : {}) }
  if (capability.type === 'events.subscribe') return { topics: ['search.found'] }
  if (capability.type === 'plugin.call') return { target: 'search' }
  if (capability.type === 'exec') return { command: ['git', 'status'] }
  return {}
}

function access(caller: Caller, capability: Capability, given?: Pair, stage: Access['stage'] = 'canonical'): Access {
  return { stage, caller, root: handler, action: 'test.action', capability: capability.type, scope: scopeOf(capability), ...(given === undefined ? {} : { pair: given, onBehalf: given.field }) }
}

// mcp and search hold every type. client#1 under the handler holds every type, client#2 under the handler inbox reads,
// client#1 under beta only private reads
function gateWith(more: Partial<GrantsSnapshot> = {}) {
  const gate = createGate()
  gate.stateChanged({
    n: 3, foldCase: false, execAny: [],
    plugins: table({ mcp: everything.map(item), search: everything.map(item) }),
    pairs: table({
      'mcp-http-handler': table({ 'client#1': everything.map(item), 'client#2': [item({ type: 'luoshu.read', paths: ['inbox/**'] })] }),
      beta: table({ 'client#1': [item({ type: 'luoshu.read', paths: ['private/**'] })] }),
    }),
    ...more,
  })
  return gate
}

describe('the types a pair\'s items may hold', () => {
  it('lists reading, writing and listing notes and their history, as the gate holds them', () => {
    expect(pairTypes).toEqual(['luoshu.read', 'luoshu.list', 'luoshu.write', 'history'])
    expect(Object.isFrozen(pairTypes)).toBe(true)
    for (const type of pairTypes) expect(capabilityTypes).toContain(type)
  })

  it.each(everything.map(capability => [JSON.stringify(capability), capability] as const))('judges a pair\'s item %s by the list, the caller holding it too', (_name, capability) => {
    const gate = gateWith()
    const listed = (pairTypes as readonly string[]).includes(capability.type)
    // The caller's own answer, which net.fetch's scope makes a refusal until its provider brings the host
    const own = gate.decide(access(mcp, capability))
    expect(own).toEqual(capability.type === 'net.fetch' ? { allow: false, code: 'not-granted', view: 3 } : { allow: true, view: 3 })
    for (const stage of ['raw', 'canonical'] as const) {
      expect(gate.decide(access(mcp, capability, pair('client#1'), stage))).toEqual(listed ? own : { allow: false, code: 'not-granted', view: 3 })
    }
  })

  it('reads and lists for a pair through its listed items only', () => {
    const gate = gateWith({
      pairs: table({ 'mcp-http-handler': table({ 'client#1': [item({ type: 'ui.read', paths: ['**'] }), item({ type: 'luoshu.list', paths: ['inbox/**'] })] }) }),
    })
    expect(gate.canRead(mcp, 'inbox/a.md', pair('client#1'))).toBe(false)
    expect(gate.canList(mcp, 'inbox/a.md', pair('client#1'))).toBe(true)
    expect(gate.canList(mcp, 'private/b.md', pair('client#1'))).toBe(false)
  })
})

describe('a pair keyed by its root plugin and its field', () => {
  it('finds a field\'s items under its own root plugin alone', () => {
    const gate = gateWith()
    const read = (path: string): Capability => ({ type: 'luoshu.read', paths: [path] })
    expect(gate.decide({ ...access(mcp, read('private/b.md'), pair('client#1', 'beta')), scope: { paths: ['private/b.md'] } })).toEqual({ allow: true, view: 3 })
    expect(gate.decide({ ...access(mcp, read('inbox/a.md'), pair('client#1', 'beta')), scope: { paths: ['inbox/a.md'] } })).toMatchObject({ allow: false })
    expect(gate.decide({ ...access(mcp, read('private/b.md'), pair('client#2')), scope: { paths: ['private/b.md'] } })).toMatchObject({ allow: false })
    expect(gate.decide({ ...access(mcp, read('inbox/a.md'), pair('client#2', 'search')), scope: { paths: ['inbox/a.md'] } })).toMatchObject({ allow: false })
  })
})

describe('a revoked pair', () => {
  const revoked = (fields: string[], root = 'mcp-http-handler') => gateWith({ revoked: table({ [root]: fields }) })
  const read: Capability = { type: 'luoshu.read', paths: ['**'] }

  it('is refused not-granted at both stages whatever its items, the caller\'s own call and the same field under another root as before', () => {
    const gate = revoked(['client#1'])
    for (const stage of ['raw', 'canonical'] as const) {
      expect(gate.decide(access(mcp, read, pair('client#1'), stage))).toEqual({ allow: false, code: 'not-granted', view: 3 })
      expect(gate.decide(access(mcp, read, pair('client#2'), stage))).toEqual({ allow: true, view: 3 })
      expect(gate.decide(access(mcp, read, undefined, stage))).toEqual({ allow: true, view: 3 })
    }
    expect(gate.decide({ ...access(mcp, read, pair('client#1', 'beta')), scope: { paths: ['private/b.md'] } })).toEqual({ allow: true, view: 3 })
  })

  it('reads and lists nothing', () => {
    const gate = revoked(['client#2'])
    expect(gate.canRead(mcp, 'inbox/a.md', pair('client#2'))).toBe(false)
    expect(gate.canList(mcp, 'inbox/a.md', pair('client#2'))).toBe(false)
    expect(gate.canRead(mcp, 'inbox/a.md')).toBe(true)
  })

  it('fails the gate on a revoked set it can\'t read', () => {
    for (const given of [null, [], 'client#1', { 'mcp-http-handler': 'client#1' }, { 'mcp-http-handler': [7] }]) {
      expect(() => gateWith({ revoked: given as never })).toThrow()
    }
    expect(() => gateWith({ revoked: undefined })).not.toThrow()
  })
})

describe('gate.filterReadable on a chain carrying a pair', () => {
  // The gate module's action over the real gate, on grants snapshot 3
  function filtering(more: Partial<GrantsSnapshot> = {}) {
    const gate = gateWith({
      plugins: table({ mcp: [item({ type: 'luoshu.read', paths: ['inbox/**', 'private/**'] })], search: [item({ type: 'luoshu.read', paths: ['**'] })] }),
      pairs: table({ 'mcp-http-handler': table({ 'client#1': [item({ type: 'luoshu.read', paths: ['inbox/**', 'secret/**'] })] }) }),
      ...more,
    })
    const tableOf = { policyJob: () => 'on', view: () => 3 } as unknown as PluginTable
    const actions = createGateActions({ gate: () => gate, table: () => tableOf, stopping: () => false, limit: () => 100, clock: () => performance.now(), fault: () => {} })
    return (callee: Caller, live: LiveCall) => actions.serve({
      callId: 'c1', caller: callee, root: live.root, action: 'gate.filterReadable', args: { call: 'x', paths: ['inbox/a.md', 'private/b.md', 'secret/c.md'] },
      deadline: Date.now() + 30_000, live,
    } as Call)
  }
  const liveOf = (caller: Caller, given?: Pair): LiveCall => ({
    caller, principal: `plugin:${caller.kind === 'plugin' ? caller.id : ''}`, plugin: caller.kind === 'plugin' ? caller.id : null, root: handler,
    ...(given === undefined ? {} : { onBehalf: given.field, pair: given }), open: () => true,
  })

  it('keeps what the callee and the pair may read on the root call, the pair standing in for the root plugin, which reads nothing', async () => {
    expect(await filtering()(mcp, liveOf(handler, pair('client#1')))).toEqual(['inbox/a.md'])
  })

  it('keeps what the callee, the live call\'s own caller and the pair may read further down the chain', async () => {
    expect(await filtering()(search, liveOf(mcp, pair('client#1')))).toEqual(['inbox/a.md'])
  })

  it('keeps nothing for a pair with no items or a revoked one', async () => {
    expect(await filtering()(mcp, liveOf(handler, pair('client#9')))).toEqual([])
    expect(await filtering({ revoked: table({ 'mcp-http-handler': ['client#1'] }) })(mcp, liveOf(handler, pair('client#1')))).toEqual([])
  })

  it('needs the root plugin\'s own read on a live call with no pair, as for any caller', async () => {
    expect(await filtering()(mcp, liveOf(handler))).toEqual([])
  })
})
