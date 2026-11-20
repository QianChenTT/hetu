import { afterEach, describe, expect, it } from 'vitest'
import type { Call, LiveCall } from '../api/policy-jobs.ts'
import { cleanup, code, editor, harness, type HarnessOptions, host, tick, windowWay, worker, type Side } from './router-fakes.ts'

afterEach(cleanup)

// A chain of calls under a root that sets onBehalf: the root's call, a sub-call under it and one under that. beta and
// mcp-http-handler are roots, mcp and search serve one action each. Every plugin holds what the tests reach, so a
// refusal comes from the rule a test is about
function chain(over: HarnessOptions = {}) {
  const parts = harness(over)
  const { pluginsManager, gate, connect } = parts
  pluginsManager.utility('mcp-http-handler')
  pluginsManager.sandboxed('mcp', { handle: {} })
  pluginsManager.sandboxed('search', { query: {} })
  pluginsManager.sandboxed('beta', {})
  const reach = [
    { type: 'plugin.call' as const, targets: ['mcp', 'search', 'beta'] }, { type: 'luoshu.read' as const, paths: ['**'] },
    { type: 'luoshu.list' as const, paths: ['**'] }, { type: 'events.subscribe' as const, topics: ['search.found'] },
  ]
  for (const id of ['mcp-http-handler', 'mcp', 'search', 'beta']) gate.grants[id] = [...reach]
  parts.luoshu.files.set('inbox/a.md', 'a')
  return {
    ...parts,
    handler: connect(host('mcp-http-handler')), mcp: connect(worker('mcp')), search: connect(worker('search')), beta: connect(worker('beta')),
  }
}

// The call the callee got for root's call of action on behalf of field, taken once
const taken = new WeakSet<object>()
async function rooted(root: Side, callee: Side, action: string, field: string | null) {
  const id = root.call(action, {}, field === null ? {} : { onBehalf: field })
  const got = await callee.waitFor(message => message.kind === 'call' && message.action === action && !taken.has(message))
  taken.add(got)
  return { id, got, under: { parent: got.callId as string } }
}

const judged = (gate: ReturnType<typeof harness>['gate'], action: string) =>
  gate.asked.filter(access => access.action === action).map(access => ({ stage: access.stage, root: access.root, onBehalf: access.onBehalf, pair: access.pair }))

describe('the pair a chain under a plugin root carries', () => {
  it.each([
    ['mcp-http-handler', 'handler', 'mcp', 'mcp.handle', 'client#1'],
    ['beta', 'beta', 'search', 'search.query', 'a field of beta\'s own'],
  ] as const)('judges every call under %s\'s call with the root plugin and the field, the root call itself with neither', async (id, rootSide, calleeSide, action, field) => {
    const parts = chain()
    const callee = parts[calleeSide]
    const rootCaller = rootSide === 'handler' ? host(id) : worker(id)
    const { under } = await rooted(parts[rootSide], callee, action, field)
    expect(judged(parts.gate, action)).toEqual([
      { stage: 'raw', root: rootCaller, onBehalf: field, pair: undefined }, { stage: 'canonical', root: rootCaller, onBehalf: field, pair: undefined },
    ])
    expect((await callee.ask('luoshu.read', { path: 'inbox/a.md' }, under)).ok).toBe(true)
    expect(judged(parts.gate, 'luoshu.read')).toEqual([
      { stage: 'raw', root: rootCaller, onBehalf: field, pair: { plugin: id, field } },
      { stage: 'canonical', root: rootCaller, onBehalf: field, pair: { plugin: id, field } },
    ])
  })

  it('carries the pair three calls deep with the root caller, a plugin\'s call to another and a provider\'s call alike', async () => {
    const { beta, search, mcp, gate, luoshu } = chain()
    const { under } = await rooted(beta, search, 'search.query', 'x')
    search.call('mcp.handle', {}, under)
    const second = await mcp.delivered('mcp.handle')
    expect([second.onBehalf, second.root]).toEqual(['x', worker('beta')])
    expect((await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: second.callId as string })).ok).toBe(true)
    expect(luoshu.prepared.at(-1)).toMatchObject({ caller: worker('mcp'), root: worker('beta'), onBehalf: 'x' })
    expect(gate.asked.filter(access => access.action === 'mcp.handle' || access.action === 'luoshu.read').map(access => access.pair))
      .toEqual(Array(4).fill({ plugin: 'beta', field: 'x' }))
  })

  it('makes no pair under a window root, its onBehalf carried and recorded as text the gate never judges', async () => {
    const parts = chain()
    parts.gate.decision = access => parts.gate.granted({ ...access, caller: worker('search') })
    const way = windowWay(parts.router, { editor })
    void way.ask('editor', 'search.query', {}, { onBehalf: 'marker' })
    const got = await parts.search.delivered('search.query')
    expect([got.onBehalf, got.root]).toEqual(['marker', editor])
    expect((await parts.search.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: got.callId as string })).ok).toBe(true)
    expect(judged(parts.gate, 'luoshu.read')).toEqual([
      { stage: 'raw', root: editor, onBehalf: 'marker', pair: undefined }, { stage: 'canonical', root: editor, onBehalf: 'marker', pair: undefined },
    ])
    // A window's own call with onBehalf is the root call and makes no pair either
    expect((await way.ask('editor', 'luoshu.read', { path: 'inbox/a.md' }, { onBehalf: 'marker' })).ok).toBe(true)
    expect(parts.gate.asked.every(access => access.pair === undefined)).toBe(true)
  })

  it('makes no pair for a chain whose root set no onBehalf', async () => {
    const { beta, search, gate } = chain()
    const { under } = await rooted(beta, search, 'search.query', null)
    expect((await search.ask('luoshu.read', { path: 'inbox/a.md' }, under)).ok).toBe(true)
    expect(gate.asked.every(access => access.pair === undefined && access.onBehalf === undefined)).toBe(true)
  })

  it('refuses a sub-call that sets its own onBehalf as invalid, the chain\'s own text included, and delivers nothing', async () => {
    const { beta, search, mcp, luoshu } = chain()
    const { under } = await rooted(beta, search, 'search.query', 'x')
    expect(code(await search.ask('luoshu.read', { path: 'inbox/a.md' }, { ...under, onBehalf: 'y' }))).toBe('invalid')
    expect(code(await search.ask('luoshu.read', { path: 'inbox/a.md' }, { ...under, onBehalf: 'x' }))).toBe('invalid')
    expect(code(await search.ask('mcp.handle', {}, { ...under, onBehalf: 'y' }))).toBe('invalid')
    expect(luoshu.prepared).toEqual([])
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('hands a provider and a guard the root caller, the caller itself for a call with no parent', async () => {
    const { beta, search, luoshu } = chain()
    expect((await beta.ask('luoshu.read', { path: 'inbox/a.md' })).ok).toBe(true)
    expect(luoshu.prepared.at(-1)).toMatchObject({ caller: worker('beta'), root: worker('beta') })
    expect(luoshu.prepared.at(-1)!.onBehalf).toBeUndefined()
    const { under } = await rooted(beta, search, 'search.query', 'x')
    expect((await search.ask('luoshu.read', { path: 'inbox/a.md' }, under)).ok).toBe(true)
    expect(luoshu.prepared.at(-1)).toMatchObject({ caller: worker('search'), root: worker('beta'), onBehalf: 'x' })
  })

  it('hands a callee the root caller beside onBehalf only', async () => {
    const { beta, search } = chain()
    const plain = await rooted(beta, search, 'search.query', null)
    expect('root' in plain.got).toBe(false)
    const field = await rooted(beta, search, 'search.query', 'x')
    expect(field.got.root).toEqual(worker('beta'))
  })

  it('gives a part a live call\'s root, onBehalf and pair, the root call\'s own pair included', async () => {
    const parts = chain()
    const lives: LiveCall[] = []
    parts.router.serve('gate', async call => { lives.push(call.live!); return [] })
    const { under } = await rooted(parts.handler, parts.mcp, 'mcp.handle', 'client#1')
    expect((await parts.mcp.ask('gate.filterReadable', { call: under.parent, paths: ['inbox/a.md'] })).ok).toBe(true)
    parts.mcp.call('search.query', {}, under)
    const deeper = await parts.search.delivered('search.query')
    expect((await parts.search.ask('gate.filterReadable', { call: deeper.callId, paths: ['inbox/a.md'] })).ok).toBe(true)
    const pair = { plugin: 'mcp-http-handler', field: 'client#1' }
    expect(lives.map(live => [live.caller, live.root, live.onBehalf, live.pair])).toEqual([
      [host('mcp-http-handler'), host('mcp-http-handler'), 'client#1', pair], [worker('mcp'), host('mcp-http-handler'), 'client#1', pair],
    ])
  })
})

describe('the router with no rule of its own on a field', () => {
  it('delivers a root call whatever its field holds, past the grammar of any label', async () => {
    const { handler, mcp } = chain()
    for (const field of ['not a label', 'client#01', 'x'.repeat(512)]) {
      const { got } = await rooted(handler, mcp, 'mcp.handle', field)
      expect(got.onBehalf).toBe(field)
    }
  })

  it('never asks the plugin table about a revoked label', async () => {
    const parts = chain()
    let asked = 0
    ;(parts.pluginsManager as { revoked?: unknown }).revoked = () => { asked++; throw new Error('read') }
    const { under } = await rooted(parts.handler, parts.mcp, 'mcp.handle', 'client#1')
    expect((await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, under)).ok).toBe(true)
    expect(asked).toBe(0)
  })

  it('judges mcp with no parent on its own items, a provider, a plugin and a subscribe alike', async () => {
    const { mcp, gate, search } = chain()
    expect((await mcp.ask('luoshu.read', { path: 'inbox/a.md' })).ok).toBe(true)
    mcp.call('search.query', {})
    await search.delivered('search.query')
    expect((await mcp.ask('events.subscribe', { topics: ['search.found'] })).ok).toBe(true)
    expect(gate.asked.filter(access => access.caller.kind === 'plugin' && access.caller.id === 'mcp').map(access => access.action))
      .toEqual(['luoshu.read', 'luoshu.read', 'search.query', 'search.query', 'events.subscribe', 'events.subscribe'])
  })

  it('lets every call of a chain carrying a pair through with the gate off, a listing\'s every name included', async () => {
    const parts = chain()
    parts.luoshu.perform_ = call => (call.action === 'luoshu.list' ? { paths: ['inbox/a.md', 'private/b.md'], next: null } : { text: 'a', version: 'v', path: 'inbox/a.md' })
    const { under } = await rooted(parts.handler, parts.mcp, 'mcp.handle', 'client#1')
    parts.pluginsManager.policyJobs.gate = 'off'
    expect((await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, under)).ok).toBe(true)
    expect((await parts.mcp.ask('luoshu.list', {}, under)).result).toEqual({ paths: ['inbox/a.md', 'private/b.md'], next: null })
    expect((await parts.mcp.ask('storage.set', { key: 'k', value: 1 }, under)).ok).toBe(true)
    expect((await parts.mcp.ask('core.self', undefined, under)).ok).toBe(true)
    expect(parts.gate.asked.filter(access => access.pair !== undefined)).toEqual([])
  })

  it('judges a chain carrying a pair as any call once shutdown began, with the gate on', async () => {
    const parts = chain()
    const { under } = await rooted(parts.handler, parts.mcp, 'mcp.handle', 'client#1')
    parts.router.stopping()
    expect((await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, under)).ok).toBe(true)
    expect(parts.gate.asked.filter(access => access.action === 'luoshu.read').map(access => access.pair))
      .toEqual(Array(2).fill({ plugin: 'mcp-http-handler', field: 'client#1' }))
  })

  it('answers a gate that is down for a chain carrying a pair as for any call', async () => {
    const parts = chain()
    const { under } = await rooted(parts.handler, parts.mcp, 'mcp.handle', 'client#1')
    for (const [state, expected] of [['failed', 'policy-down'], ['absent', 'policy-down'], ['starting', 'starting']] as const) {
      parts.pluginsManager.policyJobs.gate = state
      expect(code(await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, under))).toBe(expected)
      expect((await parts.mcp.ask('storage.set', { key: 'k', value: 1 }, under)).ok).toBe(true)
    }
  })
})

describe('who may call core.identityAsk', () => {
  const asks = { capabilities: [{ type: 'luoshu.read', paths: ['inbox/**'] }] }
  function served() {
    const seen: Call[] = []
    const parts = chain({ core: async call => { seen.push(call); return { asked: 'waiting' } } })
    return { ...parts, seen }
  }

  it.each([
    ['mcp under mcp-http-handler\'s call', 'handler', 'mcp', 'mcp.handle', 'client#1', 'mcp-http-handler'],
    ['search under beta\'s call', 'beta', 'search', 'search.query', 'x', 'beta'],
  ] as const)('takes it from %s, the plugin the root called, with the chain\'s field and root', async (_name, rootSide, calleeSide, action, field, id) => {
    const parts = served()
    const { under } = await rooted(parts[rootSide], parts[calleeSide], action, field)
    expect((await parts[calleeSide].ask('core.identityAsk', asks, under)).ok).toBe(true)
    expect(parts.seen.map(call => [call.action, call.onBehalf, call.root])).toEqual([['core.identityAsk', field, rootSide === 'handler' ? host(id) : worker(id)]])
  })

  it('refuses it with no parent, under a root that set no field, two calls deep and under a window root', async () => {
    const parts = served()
    parts.gate.decision = access => ({ allow: true, view: parts.pluginsManager.current })
    expect(code(await parts.mcp.ask('core.identityAsk', asks))).toBe('not-granted')
    const none = await rooted(parts.beta, parts.search, 'search.query', null)
    expect(code(await parts.search.ask('core.identityAsk', asks, none.under))).toBe('not-granted')
    const { under } = await rooted(parts.beta, parts.search, 'search.query', 'x')
    parts.search.call('mcp.handle', {}, under)
    const deep = await parts.mcp.delivered('mcp.handle')
    expect(code(await parts.mcp.ask('core.identityAsk', asks, { parent: deep.callId as string }))).toBe('not-granted')
    const way = windowWay(parts.router, { editor })
    void way.ask('editor', 'search.query', {}, { onBehalf: 'marker' })
    const fromWindow = await parts.search.waitFor(message => message.kind === 'call' && message.onBehalf === 'marker')
    expect(code(await parts.search.ask('core.identityAsk', asks, { parent: fromWindow.callId as string }))).toBe('not-granted')
    expect(parts.seen).toEqual([])
  })
})

describe('who may call a core action from a utility process', () => {
  it.each(['mcp-http-handler', 'another-door'])('takes core.refused from %s\'s host half on its utility port', async id => {
    const seen: Call[] = []
    const parts = harness({ core: async call => { seen.push(call); return null } })
    parts.pluginsManager.utility(id)
    expect((await parts.connect(host(id)).ask('core.refused', { reason: 'host', count: 1 })).ok).toBe(true)
    expect(seen.map(call => call.caller)).toEqual([host(id)])
  })

  it('refuses it from a worker half of a plugin placed utility and from a host half placed in main', async () => {
    const parts = harness({ core: async () => null })
    parts.pluginsManager.utility('another-door')
    parts.pluginsManager.installed('in-main')
    expect(code(await parts.connect(worker('another-door')).ask('core.refused', { reason: 'host', count: 1 }))).toBe('not-granted')
    expect(code(await parts.connect(host('in-main')).ask('core.refused', { reason: 'host', count: 1 }))).toBe('not-granted')
    await tick()
  })
})
