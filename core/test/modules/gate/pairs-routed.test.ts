import { afterEach, describe, expect, it } from 'vitest'
import { createGate } from '../../../backend/policy/gate/gate.ts'
import type { Access, Call, Gate } from '../../../api/policy-jobs.ts'
import { cleanup, code, harness, type HarnessOptions, host, worker, type Side } from '../../router-fakes.ts'

// The gate's rules for a pair as a call through the router meets them: both the caller's items and the pair's, a
// pair's refusal telling nothing of the caller's own items, the pair standing in for the root plugin in a filter and a
// listing, and the second ask judged as the first

afterEach(cleanup)

// mcp-http-handler's host half on its utility port is the door. mcp serves handle for it only, search serves query and calls on.
// Every plugin holds what the tests reach, so a refusal comes from the rule a test is about
function agents(over: HarnessOptions = {}) {
  const parts = harness(over)
  const { pluginsManager, gate, connect } = parts
  pluginsManager.utility('mcp-http-handler')
  pluginsManager.sandboxed('mcp', { handle: { from: ['mcp-http-handler'] } })
  pluginsManager.sandboxed('search', { query: {} })
  pluginsManager.sandboxed('beta', { go: {} })
  gate.grants['mcp-http-handler'] = [{ type: 'plugin.call', targets: ['mcp', 'search'] }]
  gate.grants.mcp = [
    { type: 'plugin.call', targets: ['search', 'beta'] }, { type: 'luoshu.read', paths: ['**'] }, { type: 'luoshu.write', paths: ['**'] },
    { type: 'history', access: 'read', paths: ['**'] }, { type: 'storage' },
  ]
  gate.grants.search = [{ type: 'plugin.call', targets: ['mcp'] }, { type: 'luoshu.read', paths: ['**'] }]
  gate.grants.beta = [{ type: 'plugin.call', targets: ['mcp'] }, { type: 'luoshu.read', paths: ['**'] }]
  parts.luoshu.files.set('inbox/a.md', 'a')
  return {
    ...parts,
    door: connect(host('mcp-http-handler')), httpWorker: connect(worker('mcp-http-handler')), mcp: connect(worker('mcp')), search: connect(worker('search')),
    beta: connect(worker('beta')),
  }
}

// The call mcp got for the door's mcp.handle on behalf of label, null for a call with no label. Each delivery is taken
// once, so two calls with one label are two
const taken = new WeakSet<object>()
async function handled(door: Side, mcp: Side, label: string | null = 'client#1') {
  const id = door.call('mcp.handle', { body: '{}' }, label === null ? {} : { onBehalf: label })
  const got = await mcp.waitFor(message => message.kind === 'call' && message.action === 'mcp.handle' && !taken.has(message)
    && (message.caller as { half?: string }).half === 'host' && message.onBehalf === (label ?? undefined))
  taken.add(got)
  return { id, got, parent: { parent: got.callId as string } }
}

// What the gate was asked about one action, the label it carried and whether it was an agent's
const asked = (gate: ReturnType<typeof harness>['gate'], action: string) =>
  gate.asked.filter(access => access.action === action).map(access => ({ stage: access.stage, onBehalf: access.onBehalf, agent: access.pair?.field }))




// The real gate on one grants snapshot: mcp holds inbox and private and asks at first use for asks, agent #1 inbox, secret
// and asks, search everything. decided holds every Access the gate was asked to decide
function gated() {
  const real = createGate()
  const decided: Access[] = []
  const gate: Gate = {
    ...real,
    decide: access => {
      decided.push(access)
      return real.decide(access)
    },
  }
  const items = (...paths: string[]) => [{ capability: { type: 'luoshu.read' as const, paths }, off: false, firstUse: false }]
  const table = <T>(entries: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), entries)
  gate.stateChanged({
    n: 1, foldCase: false, execAny: [],
    plugins: table({
      'mcp-http-handler': [{ capability: { type: 'plugin.call', targets: ['mcp'] }, off: false, firstUse: false }],
      mcp: [
        ...items('inbox/**', 'private/**'), { capability: { type: 'luoshu.read', paths: ['asks/**'] }, off: false, firstUse: true },
        { capability: { type: 'luoshu.read', paths: ['off/**'] }, off: true, firstUse: false },
        { capability: { type: 'plugin.call', targets: ['search'] }, off: false, firstUse: false }, { capability: { type: 'storage' }, off: false, firstUse: false },
      ],
      search: items('**'),
      beta: [{ capability: { type: 'plugin.call', targets: ['search', 'mcp'] }, off: false, firstUse: false }],
    }),
    pairs: table({
      'mcp-http-handler': table({
        'client#1': [...items('inbox/**', 'secret/**', 'asks/**'), { capability: { type: 'storage' }, off: false, firstUse: false }],
        // Two agents that reach search through mcp, one reading inbox and one private
        'client#4': [...items('inbox/**'), { capability: { type: 'plugin.call', targets: ['search'] }, off: false, firstUse: false }],
        'client#5': [...items('private/**'), { capability: { type: 'plugin.call', targets: ['search'] }, off: false, firstUse: false }],
      }),
    }),
  })
  const parts = agents({ gate: () => gate })
  for (const path of ['private/b.md', 'secret/c.md', 'asks/a.md']) parts.luoshu.files.set(path, path)
  return { ...parts, decided }
}

describe('the gate over a call for a pair, in every gate state', () => {
  const cases = ['agent inside', 'agent outside', 'agent with no item', 'mcp outside its own', 'a plugin\'s own call'] as const
  const expected: Record<string, (string | null)[]> = {
    on: [null, 'not-granted', 'not-granted', 'not-granted', null],
    off: [null, null, null, null, null],
    failed: ['policy-down', 'policy-down', 'policy-down', 'policy-down', 'policy-down'],
    absent: ['policy-down', 'policy-down', 'policy-down', 'policy-down', 'policy-down'],
  }

  it.each(Object.keys(expected))('answers each case as the table has it with the gate %s', async state => {
    const { door, mcp, search, pluginsManager, luoshu } = gated()
    // Both calls from the door land while the gate is on, the state changes under them
    const one = await handled(door, mcp, 'client#1')
    const two = await handled(door, mcp, 'client#2')
    pluginsManager.policyJobs.gate = state as never
    const answers = [
      await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, one.parent),
      await mcp.ask('luoshu.read', { path: 'private/b.md' }, one.parent),
      await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, two.parent),
      await mcp.ask('luoshu.read', { path: 'secret/c.md' }, one.parent),
      await search.ask('luoshu.read', { path: 'inbox/a.md' }),
    ]
    expect(Object.fromEntries(answers.map((answer, i) => [cases[i], code(answer)]))).toEqual(Object.fromEntries(cases.map((name, i) => [name, expected[state][i]])))
    // Nothing of an agent's reached the luoshu's perform but what the gate on let through
    const performed = luoshu.performed.filter(done => done.call.onBehalf !== undefined).map(done => done.prepared.scope.paths)
    expect(performed).toEqual(state === 'on' ? [['inbox/a.md']] : state === 'off' ? [['inbox/a.md'], ['private/b.md'], ['inbox/a.md'], ['secret/c.md']] : [])
  })

  it.each([
    ['on', 'not-granted'], ['off', null], ['failed', 'policy-down'], ['absent', 'policy-down'],
  ] as const)('tells a pair its items don\'t allow nothing of mcp\'s switched-off or asking items, raising no prompt, with the gate %s', async (state, expected) => {
    const { door, mcp, pluginsManager, asks, luoshu } = gated()
    luoshu.files.set('off/n.md', 'off')
    const two = await handled(door, mcp, 'client#2')
    pluginsManager.policyJobs.gate = state
    for (const path of ['off/n.md', 'asks/a.md', 'secret/c.md']) expect(code(await mcp.ask('luoshu.read', { path }, two.parent))).toBe(expected)
    expect(asks).toEqual([])
  })

  it('refuses mcp\'s call to another plugin for a pair holding no plugin.call item, mcp holding one', async () => {
    const { door, mcp, search } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    // mcp holds plugin.call on search and the agent doesn't
    expect(code(await mcp.ask('search.query', {}, parent))).toBe('not-granted')
    expect(search.inbox.filter(message => message.kind === 'call')).toEqual([])
  })
})

describe('what a pair may read and list through mcp', () => {
  const every = ['inbox/a.md', 'private/b.md', 'secret/c.md']

  it('filters for each pair on the door\'s own call the paths both mcp and that pair may read', async () => {
    const { door, mcp } = gated()
    const one = await handled(door, mcp, 'client#1')
    const two = await handled(door, mcp, 'client#2')
    expect((await mcp.ask('gate.filterReadable', { call: one.got.callId, paths: every })).result).toEqual(['inbox/a.md'])
    expect((await mcp.ask('gate.filterReadable', { call: two.got.callId, paths: every })).result).toEqual([])
    // The same asked under the door's call as its parent
    expect((await mcp.ask('gate.filterReadable', { call: one.got.callId, paths: every }, one.parent)).result).toEqual(['inbox/a.md'])
  })

  it('refuses a search behind mcp for a pair holding plugin.call, a type no pair\'s item may hold, and search hears nothing', async () => {
    const { door, mcp, search } = gated()
    for (const label of ['client#4', 'client#5']) {
      const { parent } = await handled(door, mcp, label)
      expect(code(await mcp.ask('search.query', { text: 'a' }, parent))).toBe('not-granted')
    }
    expect(search.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('keeps nothing for a call beta made to mcp with a field, the same field under beta a pair holding nothing', async () => {
    const { mcp, beta, pluginsManager } = gated()
    pluginsManager.sandboxed('mcp', { handle: { from: ['mcp-http-handler', 'beta'] } })
    beta.call('mcp.handle', {}, { onBehalf: 'client#1' })
    const got = await mcp.delivered('mcp.handle')
    // What mcp and beta may both read, of which beta reads nothing
    expect((await mcp.ask('gate.filterReadable', { call: got.callId, paths: every })).result).toEqual([])
  })

  it('lists for a pair the names both mcp and the pair may list', async () => {
    const { door, mcp } = gated()
    const one = await handled(door, mcp, 'client#1')
    const two = await handled(door, mcp, 'client#2')
    expect((await mcp.ask('luoshu.list', {}, one.parent)).result).toEqual({ paths: ['inbox/a.md'], next: null })
    expect((await mcp.ask('luoshu.list', {}, two.parent)).result).toEqual({ paths: [], next: null })
  })

  it('fails a listing whose provider hands a pair a name outside the pair\'s items', async () => {
    const { door, mcp, luoshu } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    // A luoshu that filters for mcp alone
    luoshu.perform_ = () => ({ paths: ['inbox/a.md', 'private/b.md'], next: null })
    expect(code(await mcp.ask('luoshu.list', {}, parent))).toBe('failed')
  })
})


type Judge = (paths: readonly string[]) => unknown

describe('the second ask for a call for a pair', () => {
  // A luoshu whose perform asks the call's judge again about each list of paths in turn, as the real one does when a
  // look at the disk reads a path otherwise than prepare did. before runs first, each time
  function again(parts: ReturnType<typeof gated>, asks: readonly string[][], before: () => void = () => {}) {
    const answers: unknown[] = []
    parts.luoshu.perform_ = (call: Call) => {
      before()
      for (const paths of asks) answers.push((call as Call & { judge?: Judge }).judge?.(paths))
      return null
    }
    return answers
  }

  it('judges the second ask for a pair against mcp\'s items and the pair\'s both, carrying the pair', async () => {
    const parts = gated()
    const { parent } = await handled(parts.door, parts.mcp, 'client#1')
    // inbox both hold, private mcp alone, secret the agent alone
    const answers = again(parts, [['inbox/b.md'], ['private/b.md'], ['secret/c.md']])
    expect((await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)).ok).toBe(true)
    expect(answers).toEqual([null, { code: 'not-granted' }, { code: 'not-granted' }])
    const canonical = parts.decided.filter(access => access.action === 'luoshu.read' && access.stage === 'canonical')
    expect(canonical.map(access => [access.scope.paths, access.caller, access.onBehalf, access.pair?.field])).toEqual(
      [['inbox/a.md'], ['inbox/b.md'], ['private/b.md'], ['secret/c.md']].map(paths => [paths, worker('mcp'), 'client#1', 'client#1']),
    )
  })

  it('refuses the second ask for a pair outside the pair\'s items or on mcp\'s item that asks at first use not-granted with no prompt', async () => {
    const parts = gated()
    // The item asks at first use: a first ask about it for agent #1 raises the prompt
    const first = await handled(parts.door, parts.mcp, 'client#1')
    expect(code(await parts.mcp.ask('luoshu.read', { path: 'asks/a.md' }, first.parent))).toBe('needs-confirm')
    expect(parts.asks).toHaveLength(1)
    // Agent #4 holds no asks, agent #1 does and mcp's own item there asks
    const four = await handled(parts.door, parts.mcp, 'client#4')
    const answers = again(parts, [['asks/a.md']])
    expect((await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, four.parent)).ok).toBe(true)
    expect((await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, first.parent)).ok).toBe(true)
    expect(answers).toEqual([{ code: 'not-granted' }, { code: 'not-granted' }])
    expect(parts.asks).toHaveLength(1)
  })

  it.each([
    ['failed', 'policy-down'],
  ] as const)('refuses the second ask for a pair with the gate %s as its first ask is refused', async (state, refused) => {
    const parts = gated()
    const { parent } = await handled(parts.door, parts.mcp, 'client#1')
    const answers = again(parts, [['inbox/b.md']], () => { parts.pluginsManager.policyJobs.gate = state })
    expect((await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)).ok).toBe(true)
    expect(answers).toEqual([{ code: refused }])
    // The first ask with the gate in that state
    expect(code(await parts.mcp.ask('luoshu.read', { path: 'inbox/b.md' }, parent))).toBe(refused)
  })
})
