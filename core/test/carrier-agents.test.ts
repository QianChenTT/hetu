import { afterEach, describe, expect, it } from 'vitest'
import { createGate } from '../../plugins/gate/src/gate.ts'
import type { Access, Call, Gate } from '../api/slots.ts'
import type { Carrier } from '../backend/carrier/carrier.ts'
import type { CarrierOptions } from '../backend/carrier/seams.ts'
import { cleanup, code, editor, type FakeLog, harness, host, hostHalf, tick, windowWay, worker, type Side } from './carrier-fakes.ts'

afterEach(cleanup)

// http's host half on its utility port is the door. mcp serves handle for http only, search serves query and calls on.
// Every plugin holds what the tests reach, so a refusal comes from the rule a test is about
function agents(over: Partial<CarrierOptions> = {}) {
  const parts = harness(over)
  const { loader, gate, connect } = parts
  loader.utility('http')
  loader.sandboxed('mcp', { handle: { from: ['http'] } })
  loader.sandboxed('search', { query: {} })
  loader.sandboxed('beta', { go: {} })
  gate.grants.http = [{ type: 'plugin.call', targets: ['mcp', 'search'] }]
  gate.grants.mcp = [
    { type: 'plugin.call', targets: ['search', 'beta'] }, { type: 'luoshu.read', paths: ['**'] }, { type: 'luoshu.write', paths: ['**'] },
    { type: 'history', access: 'read', paths: ['**'] }, { type: 'storage' },
  ]
  gate.grants.search = [{ type: 'plugin.call', targets: ['mcp'] }, { type: 'luoshu.read', paths: ['**'] }]
  gate.grants.beta = [{ type: 'plugin.call', targets: ['mcp'] }, { type: 'luoshu.read', paths: ['**'] }]
  parts.luoshu.files.set('inbox/a.md', 'a')
  return {
    ...parts,
    door: connect(host('http')), httpWorker: connect(worker('http')), mcp: connect(worker('mcp')), search: connect(worker('search')),
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
  gate.asked.filter(access => access.action === action).map(access => ({ stage: access.stage, onBehalf: access.onBehalf, agent: access.agent }))

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(5)
  }
}

async function written(carrier: Carrier, log: FakeLog) {
  await carrier.flush()
  return log.events('audit.call').map(record => record.fields)
}

describe('an agent\'s label down a chain of calls', () => {
  it('hands a sub-call the parent\'s onBehalf, judged as the agent\'s when the chain starts at the door', async () => {
    const { door, mcp, search, gate } = agents()
    const { parent } = await handled(door, mcp)
    expect((await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)).ok).toBe(true)
    expect(asked(gate, 'luoshu.read')).toEqual([
      { stage: 'raw', onBehalf: 'client#1', agent: 'client#1' }, { stage: 'canonical', onBehalf: 'client#1', agent: 'client#1' },
    ])
    mcp.call('search.query', {}, parent)
    const atSearch = await search.delivered('search.query')
    expect(atSearch.onBehalf).toBe('client#1')
    expect(asked(gate, 'search.query').every(access => access.agent === 'client#1')).toBe(true)
  })

  it('judges the door\'s own mcp.handle as http\'s call, the label not yet an agent\'s', async () => {
    const { door, mcp, gate } = agents()
    await handled(door, mcp)
    expect(asked(gate, 'mcp.handle')).toEqual([
      { stage: 'raw', onBehalf: 'client#1', agent: undefined }, { stage: 'canonical', onBehalf: 'client#1', agent: undefined },
    ])
  })

  it('carries the label three calls deep, each judged as the agent\'s', async () => {
    const { door, mcp, search, gate, luoshu } = agents()
    const { parent } = await handled(door, mcp)
    mcp.call('search.query', {}, parent)
    const atSearch = await search.delivered('search.query')
    const read = await search.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: atSearch.callId })
    expect(read.ok).toBe(true)
    expect(luoshu.prepared.at(-1)).toMatchObject({ caller: worker('search'), onBehalf: 'client#1', parent: atSearch.callId })
    expect(asked(gate, 'luoshu.read')).toEqual([
      { stage: 'raw', onBehalf: 'client#1', agent: 'client#1' }, { stage: 'canonical', onBehalf: 'client#1', agent: 'client#1' },
    ])
  })

  it('refuses a sub-call that sets its own onBehalf as invalid and delivers nothing, its parent\'s own text included', async () => {
    const { door, mcp, search, luoshu } = agents()
    const { parent } = await handled(door, mcp)
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { ...parent, onBehalf: 'client#2' }))).toBe('invalid')
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { ...parent, onBehalf: 'client#1' }))).toBe('invalid')
    expect(code(await mcp.ask('search.query', {}, { ...parent, onBehalf: 'client#2' }))).toBe('invalid')
    expect(luoshu.prepared).toEqual([])
    expect(search.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('keeps the own onBehalf of a call with no parent from a window or a plugin and treats neither as an agent\'s', async () => {
    const { carrier, door, search, gate, beta } = agents()
    gate.grants.beta.push({ type: 'plugin.call', targets: ['search'] })
    const way = windowWay(carrier, { editor })
    expect((await way.ask('editor', 'luoshu.read', { path: 'inbox/a.md' }, { onBehalf: 'client#1' })).ok).toBe(true)
    beta.call('search.query', {}, { onBehalf: 'client#1' })
    const atSearch = await search.delivered('search.query')
    expect(atSearch.onBehalf).toBe('client#1')
    door.call('search.query', {}, { onBehalf: 'client#1' })
    await search.waitFor(message => message.kind === 'call' && message.caller !== undefined && (message.caller as { id: string }).id === 'http')
    expect(gate.asked.filter(access => access.onBehalf === 'client#1').map(access => access.agent)).toEqual(Array(6).fill(undefined))
    // A sub-call under a call the door made to another plugin carries the label as nobody's agent
    const fromDoor = search.inbox.find(message => message.kind === 'call' && (message.caller as { id: string }).id === 'http')!
    expect((await search.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: fromDoor.callId })).ok).toBe(true)
    expect(asked(gate, 'luoshu.read').at(-1)).toEqual({ stage: 'canonical', onBehalf: 'client#1', agent: undefined })
  })

  it('marks no agent under an mcp.handle from http\'s worker half or from another plugin', async () => {
    const { httpWorker, mcp, beta, loader, gate } = agents()
    loader.sandboxed('mcp', { handle: { from: ['http', 'beta'] } })
    for (const from of [httpWorker, beta]) {
      from.call('mcp.handle', {}, { onBehalf: 'client#1' })
      const got = await mcp.waitFor(message => message.kind === 'call' && message.action === 'mcp.handle' && !(message as { seen?: boolean }).seen)
      ;(got as { seen?: boolean }).seen = true
      expect(got.onBehalf).toBe('client#1')
      expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: got.callId as string }))).toBe('not-granted')
      expect(code(await mcp.ask('search.query', {}, { parent: got.callId as string }))).toBe('not-granted')
    }
    expect(asked(gate, 'search.query')).toEqual([])
    expect(gate.asked.filter(access => access.agent !== undefined)).toEqual([])
  })

  it('refuses the door\'s mcp.handle with no label as invalid in every gate state and delivers nothing to mcp', async () => {
    const { door, mcp, loader, gate, carrier, log } = agents()
    for (const state of ['on', 'off', 'starting', 'failed'] as const) {
      loader.slots.gate = state
      expect(code(await door.ask('mcp.handle', { body: '{}' }))).toBe('invalid')
    }
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
    expect(asked(gate, 'mcp.handle')).toEqual([])
    const records = (await written(carrier, log)).filter(record => record.action === 'mcp.handle')
    expect(records.map(record => record.code)).toEqual(['invalid', 'invalid', 'invalid', 'invalid'])
  })

  it('refuses the door\'s mcp.handle with a label out of the <client id>#<n> form as invalid and delivers nothing to mcp', async () => {
    const { door, mcp } = agents()
    const cp = (...points: number[]) => String.fromCodePoint(...points)
    const labels = [
      `client${cp(0x200b)}#1`, `client${cp(0x2028)}#1`, `${cp(0x441)}lient#1`, `client#1${cp(0x2060)}`, ' ', 'client', 'client#01', 'a#1#1',
      `${'a'.repeat(256)}#1`, 'client "x"#1',
    ]
    for (const label of labels) expect(code(await door.ask('mcp.handle', {}, { onBehalf: label }))).toBe('invalid')
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('marks an agent whose client id is a metadata document\'s address', async () => {
    const { door, mcp, gate } = agents()
    const label = 'https://claude.ai/oauth/claude-code-client-metadata#3'
    const { parent } = await handled(door, mcp, label)
    expect((await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)).ok).toBe(true)
    expect(asked(gate, 'luoshu.read').map(access => access.agent)).toEqual([label, label])
  })

  it('still delivers an mcp.handle with no label that is not the door\'s and the door\'s other calls with no label', async () => {
    const { door, httpWorker, mcp, search, loader } = agents()
    loader.sandboxed('mcp', { handle: { from: ['http', 'beta'] } })
    httpWorker.call('mcp.handle', {})
    expect((await mcp.delivered('mcp.handle')).onBehalf).toBeUndefined()
    door.call('search.query', {})
    expect((await search.delivered('search.query')).onBehalf).toBeUndefined()
  })
})

describe('mcp\'s reach into notes, history and leases', () => {
  it('refuses mcp\'s luoshu, history and leases calls with no parent and lets its storage and its own view through', async () => {
    const { mcp, luoshu } = agents()
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }))).toBe('not-granted')
    expect(code(await mcp.ask('luoshu.write', { path: 'inbox/a.md', text: 'x' }))).toBe('not-granted')
    expect(code(await mcp.ask('luoshu.list', {}))).toBe('not-granted')
    expect(code(await mcp.ask('history.log', { path: 'inbox/a.md' }))).toBe('not-granted')
    expect(code(await mcp.ask('leases.acquire', { paths: ['inbox/a.md'] }))).toBe('not-granted')
    expect(luoshu.prepared).toEqual([])
    expect((await mcp.ask('storage.set', { key: 'k', value: 1 })).ok).toBe(true)
    expect((await mcp.ask('core.self')).result).toEqual(worker('mcp'))
  })

  it('refuses mcp\'s call to another plugin, to exec and its subscribe to another plugin\'s topic with no parent and delivers nothing', async () => {
    const { mcp, search, beta, loader, gate } = agents()
    loader.installed('exec')
    loader.plugins.mcp.topics = ['seen']
    gate.grants.mcp.push({ type: 'exec', commands: [['cat', 'private/b.md']], env: [] }, { type: 'events.subscribe', topics: ['luoshu.changed', 'search.found'] })
    expect(code(await mcp.ask('search.query', {}))).toBe('not-granted')
    expect(code(await mcp.ask('beta.go', {}))).toBe('not-granted')
    expect(code(await mcp.ask('exec.run', { command: ['cat', 'private/b.md'] }))).toBe('not-granted')
    expect(code(await mcp.ask('events.subscribe', { topics: ['luoshu.changed'] }))).toBe('not-granted')
    expect(code(await mcp.ask('events.subscribe', { topics: ['mcp.seen', 'search.found'] }))).toBe('not-granted')
    for (const side of [search, beta]) expect(side.inbox.filter(message => message.kind === 'call')).toEqual([])
    // Its own space, its own view and its own topic stay its own. Nothing of it reached the gate
    expect((await mcp.ask('cache.set', { key: 'k', value: 1 })).ok).toBe(true)
    expect((await mcp.ask('core.self')).ok).toBe(true)
    expect((await mcp.ask('events.subscribe', { topics: ['mcp.seen'] })).ok).toBe(true)
    expect((await mcp.ask('events.unsubscribe', { topics: ['luoshu.changed'] })).ok).toBe(true)
    expect(gate.asked.filter(access => access.caller.kind === 'plugin' && access.caller.id === 'mcp')).toEqual([])
  })

  it('refuses mcp\'s call to another plugin with the parent left out while an agent\'s call from the door is live', async () => {
    const { door, mcp, search } = agents()
    const { parent } = await handled(door, mcp, 'client#1')
    expect(code(await mcp.ask('search.query', {}))).toBe('not-granted')
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }))).toBe('not-granted')
    expect(search.inbox.filter(message => message.kind === 'call')).toEqual([])
    // The same under the chain is the agent's and goes on
    mcp.call('search.query', {}, parent)
    expect((await search.delivered('search.query')).onBehalf).toBe('client#1')
  })

  it('refuses mcp\'s subscribe to another plugin\'s topic under an agent\'s call, since a subscription outlives the call', async () => {
    const { door, mcp, gate } = agents()
    gate.grants.mcp.push({ type: 'events.subscribe', topics: ['luoshu.changed'] })
    const { parent } = await handled(door, mcp, 'client#1')
    expect(code(await mcp.ask('events.subscribe', { topics: ['luoshu.changed'] }, parent))).toBe('not-granted')
    expect(gate.asked.filter(access => access.action === 'events.subscribe')).toEqual([])
  })

  it('refuses mcp\'s luoshu call under a parent from another plugin than http\'s host half', async () => {
    const { beta, mcp, search, httpWorker, loader } = agents()
    loader.sandboxed('mcp', { handle: { from: ['http', 'beta', 'search'] } })
    for (const from of [beta, search, httpWorker]) {
      const id = from.call('mcp.handle', {})
      const got = await mcp.waitFor(message => message.kind === 'call' && message.action === 'mcp.handle' && !(message as { seen?: boolean }).seen)
      ;(got as { seen?: boolean }).seen = true
      expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: got.callId as string }))).toBe('not-granted')
      mcp.answer(got.callId, null)
      await from.reply(id)
    }
  })

  it('refuses mcp\'s luoshu call under a parent from the door that already ended', async () => {
    const { door, mcp } = agents()
    const { id, got, parent } = await handled(door, mcp)
    expect((await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)).ok).toBe(true)
    mcp.answer(got.callId, null)
    await door.reply(id)
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent))).toBe('invalid')
  })

  it('holds mcp\'s sub-call to the door\'s deadline, mcp\'s own longer one notwithstanding', async () => {
    const { door, mcp, search, loader, luoshu } = agents()
    loader.human.plugins.http = { callDeadlineMs: 4000 }
    loader.human.plugins.mcp = { callDeadlineMs: 60000 }
    loader.human.plugins.search = { callDeadlineMs: 60000 }
    const { got, parent } = await handled(door, mcp)
    expect(got.deadline as number).toBeLessThan(Date.now() + 4001)
    await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)
    expect(luoshu.prepared.at(-1)!.deadline).toBe(got.deadline)
    mcp.call('search.query', {}, parent)
    const atSearch = await search.delivered('search.query')
    expect(atSearch.deadline).toBe(got.deadline)
    await search.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: atSearch.callId as string })
    expect(luoshu.prepared.at(-1)!.deadline).toBe(got.deadline)
  })
})

describe('the door an agent\'s label comes through', () => {
  // mcp's read under an mcp.handle the half sent on behalf of client#1, and the agents the gate was asked about
  async function under(parts: ReturnType<typeof agents>, send: (label: string) => void) {
    send('client#1')
    const got = await parts.mcp.waitFor(message => message.kind === 'call' && message.action === 'mcp.handle' && !taken.has(message))
    taken.add(got)
    const read = await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: got.callId as string })
    return { code: code(read), agents: asked(parts.gate, 'luoshu.read').map(access => access.agent) }
  }

  it('marks an agent under mcp.handle from http\'s host half on its port with http placed utility', async () => {
    const parts = agents()
    expect(await under(parts, label => parts.door.call('mcp.handle', {}, { onBehalf: label }))).toEqual({ code: null, agents: ['client#1', 'client#1'] })
  })

  it('marks no agent under the same call from http\'s host half on an in-process handle, http placed utility', async () => {
    const parts = harness()
    parts.loader.utility('http')
    parts.loader.sandboxed('mcp', { handle: { from: ['http'] } })
    parts.gate.grants.http = [{ type: 'plugin.call', targets: ['mcp'] }]
    parts.gate.grants.mcp = [{ type: 'luoshu.read', paths: ['**'] }]
    parts.luoshu.files.set('inbox/a.md', 'a')
    const mcp = parts.connect(worker('mcp'))
    const door = hostHalf(parts.carrier, host('http'))
    void door.ask('mcp.handle', {}, { onBehalf: 'client#1' })
    const got = await mcp.delivered('mcp.handle')
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: got.callId as string }))).toBe('not-granted')
    expect(parts.gate.asked.filter(access => access.agent !== undefined)).toEqual([])
  })

  it.each([
    ['on the host', (loader: ReturnType<typeof agents>['loader']) => loader.installed('http')],
    ['in the sandbox, as a plugin named http from the plugin folder', (loader: ReturnType<typeof agents>['loader']) => loader.sandboxed('http')],
  ])('marks no agent under the same call from http\'s host half on its port with http placed %s', async (_place, place) => {
    const parts = agents()
    place(parts.loader)
    expect(await under(parts, label => parts.door.call('mcp.handle', {}, { onBehalf: label }))).toEqual({ code: 'not-granted', agents: [] })
    // The same half once the loader reads http placed utility again
    parts.loader.utility('http')
    const again = await under(parts, label => parts.door.call('mcp.handle', {}, { onBehalf: label }))
    expect(again).toEqual({ code: null, agents: ['client#1', 'client#1'] })
  })

  it('marks no agent under an mcp.handle the door made under a call another plugin sent it with its own label', async () => {
    const parts = agents()
    parts.loader.plugins.http.actions = { go: {} }
    parts.gate.grants.beta.push({ type: 'plugin.call', targets: ['http'] })
    parts.beta.call('http.go', {}, { onBehalf: 'client#1' })
    const atDoor = await parts.door.delivered('http.go')
    expect(atDoor.onBehalf).toBe('client#1')
    expect(await under(parts, () => parts.door.call('mcp.handle', {}, { parent: atDoor.callId as string }))).toEqual({ code: 'not-granted', agents: [] })
  })

  it('marks no agent under mcp.handle from a worker of a plugin named http from the plugin folder', async () => {
    const parts = agents()
    parts.loader.sandboxed('http')
    expect(await under(parts, label => parts.httpWorker.call('mcp.handle', {}, { onBehalf: label }))).toEqual({ code: 'not-granted', agents: [] })
  })
})

// The real gate on one StateView: mcp holds inbox and private and asks at first use for asks, agent #1 inbox, secret
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
      http: [{ capability: { type: 'plugin.call', targets: ['mcp'] }, off: false, firstUse: false }],
      mcp: [
        ...items('inbox/**', 'private/**'), { capability: { type: 'luoshu.read', paths: ['asks/**'] }, off: false, firstUse: true },
        { capability: { type: 'plugin.call', targets: ['search'] }, off: false, firstUse: false }, { capability: { type: 'storage' }, off: false, firstUse: false },
      ],
      search: items('**'),
      beta: [{ capability: { type: 'plugin.call', targets: ['search', 'mcp'] }, off: false, firstUse: false }],
    }),
    agents: table({
      'client#1': [...items('inbox/**', 'secret/**', 'asks/**'), { capability: { type: 'storage' }, off: false, firstUse: false }],
      // Two agents that reach search through mcp, one reading inbox and one private
      'client#4': [...items('inbox/**'), { capability: { type: 'plugin.call', targets: ['search'] }, off: false, firstUse: false }],
      'client#5': [...items('private/**'), { capability: { type: 'plugin.call', targets: ['search'] }, off: false, firstUse: false }],
    }),
  })
  const parts = agents({ gate: () => gate })
  for (const path of ['private/b.md', 'secret/c.md', 'asks/a.md']) parts.luoshu.files.set(path, path)
  return { ...parts, decided }
}

describe('the gate over an agent\'s call, in every gate state', () => {
  const cases = ['agent inside', 'agent outside', 'agent with no item', 'mcp outside its own', 'a plugin\'s own call'] as const
  const expected: Record<string, (string | null)[]> = {
    on: [null, 'not-granted', 'not-granted', 'not-granted', null],
    off: ['policy-down', 'policy-down', 'policy-down', 'policy-down', null],
    failed: ['policy-down', 'policy-down', 'policy-down', 'policy-down', 'policy-down'],
    absent: ['policy-down', 'policy-down', 'policy-down', 'policy-down', 'policy-down'],
    tampered: ['policy-down', 'policy-down', 'policy-down', 'policy-down', 'policy-down'],
    starting: ['starting', 'starting', 'starting', 'starting', 'starting'],
  }

  it.each(Object.keys(expected))('answers each case as the table has it with the gate %s', async state => {
    const { door, mcp, search, loader, luoshu } = gated()
    // Both calls from the door land while the gate is on, the state changes under them
    const one = await handled(door, mcp, 'client#1')
    const two = await handled(door, mcp, 'client#2')
    loader.slots.gate = state as never
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
    expect(performed).toEqual(state === 'on' ? [['inbox/a.md']] : [])
  })

  it('refuses an agent\'s free call, its listing and a core action while the gate isn\'t on and serves them while it is', async () => {
    const { door, mcp, loader } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    for (const state of ['off', 'failed', 'starting'] as const) {
      loader.slots.gate = state
      const down = state === 'starting' ? 'starting' : 'policy-down'
      expect(code(await mcp.ask('storage.set', { key: 'k', value: 1 }, parent))).toBe(down)
      expect(code(await mcp.ask('luoshu.list', {}, parent))).toBe(down)
      expect(code(await mcp.ask('core.self', undefined, parent))).toBe(down)
      // A subscribe of mcp's to another plugin's topic is refused at the floor before the gate's state is read
      expect(code(await mcp.ask('events.subscribe', { topics: ['luoshu.changed'] }, parent))).toBe('not-granted')
      // mcp's own free call with no parent is its own and free whatever the gate's state, as any plugin's
      expect((await mcp.ask('storage.set', { key: 'k', value: 1 })).ok).toBe(true)
    }
    loader.slots.gate = 'on'
    expect((await mcp.ask('storage.set', { key: 'k', value: 1 }, parent)).ok).toBe(true)
    expect((await mcp.ask('core.self', undefined, parent)).ok).toBe(true)
  })

  it('refuses an agent\'s call at the canonical judgement when the human switched the gate off while the luoshu prepared it', async () => {
    const { door, mcp, loader, luoshu, search } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    let open!: () => void
    luoshu.hold.prepare = new Promise<void>(resolve => { open = resolve })
    const id = mcp.call('luoshu.read', { path: 'inbox/a.md' }, parent)
    const plain = search.call('luoshu.read', { path: 'inbox/a.md' })
    for (let i = 0; i < 200 && luoshu.prepared.length < 2; i++) await tick(2)
    loader.slots.gate = 'off'
    open()
    expect(code(await mcp.reply(id))).toBe('policy-down')
    expect((await search.reply(plain)).ok).toBe(true)
    expect(luoshu.performed.map(done => done.call.caller)).toEqual([worker('search')])
  })

  it.each([
    ['on', null], ['off', 'policy-down'], ['failed', 'policy-down'], ['absent', 'policy-down'], ['tampered', 'policy-down'], ['starting', 'starting'],
  ] as const)('answers the door\'s mcp.handle with a label with the gate %s before mcp sees it, a plugin\'s own call beside it as before', async (state, expected) => {
    const { door, mcp, search, loader, luoshu } = gated()
    loader.slots.gate = state
    const id = door.call('mcp.handle', { body: '{}' }, { onBehalf: 'client#1' })
    if (expected === null) {
      expect((await mcp.delivered('mcp.handle')).onBehalf).toBe('client#1')
    } else {
      expect(code(await door.reply(id))).toBe(expected)
      expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
    }
    // The door's call with no label is refused for its form in every state, and a plugin's own call is judged as before
    expect(code(await door.ask('mcp.handle', { body: '{}' }))).toBe('invalid')
    const own = await search.ask('luoshu.read', { path: 'inbox/a.md' })
    expect(code(own)).toBe(state === 'on' || state === 'off' ? null : state === 'starting' ? 'starting' : 'policy-down')
    expect(luoshu.performed.filter(done => done.call.caller.kind === 'plugin' && done.call.caller.id === 'mcp')).toEqual([])
  })

  it('answers stopped for the door\'s mcp.handle with the gate off once shutdown began', async () => {
    const { carrier, door, mcp, loader } = gated()
    loader.slots.gate = 'off'
    carrier.stopping()
    expect(code(await door.ask('mcp.handle', {}, { onBehalf: 'client#1' }))).toBe('stopped')
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('answers stopped for an agent\'s call with the gate off once shutdown began', async () => {
    const { carrier, door, mcp, loader } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    loader.slots.gate = 'off'
    carrier.stopping()
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent))).toBe('stopped')
  })

  it('holds mcp\'s call to another plugin for an agent to the agent\'s own plugin.call items', async () => {
    const { door, mcp, search } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    // mcp holds plugin.call on search and the agent doesn't
    expect(code(await mcp.ask('search.query', {}, parent))).toBe('not-granted')
    expect(search.inbox.filter(message => message.kind === 'call')).toEqual([])
  })
})

describe('what an agent may read and list through mcp', () => {
  const every = ['inbox/a.md', 'private/b.md', 'secret/c.md']

  it('filters for each agent on the door\'s own call the paths both mcp and that agent may read', async () => {
    const { door, mcp } = gated()
    const one = await handled(door, mcp, 'client#1')
    const two = await handled(door, mcp, 'client#2')
    expect((await mcp.ask('core.filterReadable', { call: one.got.callId, paths: every })).result).toEqual(['inbox/a.md'])
    expect((await mcp.ask('core.filterReadable', { call: two.got.callId, paths: every })).result).toEqual([])
    // The same asked under the door's call as its parent
    expect((await mcp.ask('core.filterReadable', { call: one.got.callId, paths: every }, one.parent)).result).toEqual(['inbox/a.md'])
  })

  it('filters what a search behind mcp found for the agent the chain is for, one agent apart from the other', async () => {
    const { door, mcp, search } = gated()
    // A search_notes that hands back what core.filterReadable kept of every note it holds
    const searchNotes = async (label: string) => {
      const { parent } = await handled(door, mcp, label)
      const id = mcp.call('search.query', { text: 'a' }, parent)
      const atSearch = await search.waitFor(message => message.kind === 'call' && message.action === 'search.query' && message.onBehalf === label)
      const kept = await search.ask('core.filterReadable', { call: atSearch.callId, paths: every })
      search.answer(atSearch.callId, kept.result)
      return (await mcp.reply(id)).result
    }
    expect(await searchNotes('client#4')).toEqual(['inbox/a.md'])
    expect(await searchNotes('client#5')).toEqual(['private/b.md'])
  })

  it('keeps filtering for a plugin\'s own call as before, every path with the gate off, while an agent\'s answers policy-down', async () => {
    const { door, mcp, search, beta, loader } = gated()
    const one = await handled(door, mcp, 'client#1')
    beta.call('search.query', {})
    const plain = await search.delivered('search.query')
    loader.slots.gate = 'off'
    expect(code(await mcp.ask('core.filterReadable', { call: one.got.callId, paths: every }))).toBe('policy-down')
    expect((await search.ask('core.filterReadable', { call: plain.callId, paths: every })).result).toEqual(every)
    loader.slots.gate = 'failed'
    expect(code(await mcp.ask('core.filterReadable', { call: one.got.callId, paths: every }))).toBe('policy-down')
    loader.slots.gate = 'starting'
    expect(code(await mcp.ask('core.filterReadable', { call: one.got.callId, paths: every }))).toBe('starting')
  })

  it('keeps nothing for a call another plugin made to mcp with a label, which the door did not make', async () => {
    const { mcp, beta, loader } = gated()
    loader.sandboxed('mcp', { handle: { from: ['http', 'beta'] } })
    beta.call('mcp.handle', {}, { onBehalf: 'client#1' })
    const got = await mcp.delivered('mcp.handle')
    // What mcp and beta may both read, of which beta reads nothing
    expect((await mcp.ask('core.filterReadable', { call: got.callId, paths: every })).result).toEqual([])
  })

  it('lists for an agent the names both mcp and the agent may list', async () => {
    const { door, mcp } = gated()
    const one = await handled(door, mcp, 'client#1')
    const two = await handled(door, mcp, 'client#2')
    expect((await mcp.ask('luoshu.list', {}, one.parent)).result).toEqual({ paths: ['inbox/a.md'], next: null })
    expect((await mcp.ask('luoshu.list', {}, two.parent)).result).toEqual({ paths: [], next: null })
  })

  it('fails a listing whose provider hands an agent a name outside the agent\'s grant', async () => {
    const { door, mcp, luoshu } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    // A luoshu that filters for mcp alone
    luoshu.perform_ = () => ({ paths: ['inbox/a.md', 'private/b.md'], next: null })
    expect(code(await mcp.ask('luoshu.list', {}, parent))).toBe('failed')
  })
})

type Judge = (paths: readonly string[]) => unknown

describe('core.agentAsk, an agent\'s ask for items through mcp', () => {
  const inbox = { type: 'luoshu.read', paths: ['inbox/**'] }
  function asking() {
    const seen: Call[] = []
    const parts = agents({ core: async call => { seen.push(call); return { asked: 'waiting' } } })
    parts.loader.sandboxed('mcp', { handle: { from: ['http', 'beta'] } })
    return { ...parts, seen }
  }

  it('reaches the core from mcp under a live call from the door, named by the chain\'s label', async () => {
    const { door, mcp, seen } = asking()
    const { parent } = await handled(door, mcp, 'client#1')
    expect((await mcp.ask('core.agentAsk', { capabilities: [inbox] }, parent)).result).toEqual({ asked: 'waiting' })
    expect(seen.map(call => [call.caller, call.onBehalf, call.args])).toEqual([[worker('mcp'), 'client#1', { capabilities: [inbox] }]])
  })

  it('refuses it from mcp with no door call, under another plugin\'s call, from another plugin and from a window', async () => {
    const { carrier, mcp, beta, search, seen } = asking()
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [inbox] }))).toBe('not-granted')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [inbox] }, { onBehalf: 'client#1' }))).toBe('not-granted')
    beta.call('mcp.handle', {}, { onBehalf: 'client#1' })
    const fromBeta = await mcp.delivered('mcp.handle')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [inbox] }, { parent: fromBeta.callId as string }))).toBe('not-granted')
    expect(code(await search.ask('core.agentAsk', { capabilities: [inbox] }))).toBe('not-granted')
    const way = windowWay(carrier, { editor, trusted: { kind: 'window', role: 'trusted', n: 1 } })
    expect(code(await way.ask('editor', 'core.agentAsk', { capabilities: [inbox] }))).toBe('not-granted')
    expect(code(await way.ask('trusted', 'core.agentAsk', { capabilities: [inbox] }))).toBe('not-granted')
    expect(seen).toEqual([])
  })

  it('refuses it under a door call that ended, with a label in its arguments, past eight items and with a scope a screen hides', async () => {
    const { door, mcp, seen } = asking()
    const one = await handled(door, mcp, 'client#1')
    const two = await handled(door, mcp, 'client#2')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [inbox], agent: 'client#2' }, two.parent))).toBe('invalid')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [] }, two.parent))).toBe('invalid')
    const nine = Array.from({ length: 9 }, (_, i) => ({ type: 'luoshu.read', paths: [`n${i}/**`] }))
    expect(code(await mcp.ask('core.agentAsk', { capabilities: nine }, two.parent))).toBe('invalid')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [{ type: 'luoshu.read', paths: ['in\nbox/**'] }] }, two.parent))).toBe('invalid')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [{ type: 'luoshu.read', paths: [`in${String.fromCharCode(0x202e)}box/**`] }] }, two.parent))).toBe('invalid')
    mcp.answer(one.got.callId, null)
    await door.reply(one.id)
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [inbox] }, one.parent))).toBe('invalid')
    expect(seen).toEqual([])
    expect(code(await mcp.ask('core.agentAsk', { capabilities: Array.from({ length: 8 }, (_, i) => ({ type: 'luoshu.read', paths: [`n${i}/**`] })) }, two.parent))).toBe(null)
  })

  it('refuses it while the gate is not on, as any call for an agent', async () => {
    const { door, mcp, loader, seen } = asking()
    const { parent } = await handled(door, mcp, 'client#1')
    for (const [state, expected] of [['off', 'policy-down'], ['failed', 'policy-down'], ['starting', 'starting']] as const) {
      loader.slots.gate = state
      expect(code(await mcp.ask('core.agentAsk', { capabilities: [inbox] }, parent))).toBe(expected)
    }
    expect(seen).toEqual([])
  })
})

describe('the second ask for an agent\'s call', () => {
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

  it('judges an agent\'s second ask against mcp\'s grant and the agent\'s both, carrying the agent\'s label', async () => {
    const parts = gated()
    const { parent } = await handled(parts.door, parts.mcp, 'client#1')
    // inbox both hold, private mcp alone, secret the agent alone
    const answers = again(parts, [['inbox/b.md'], ['private/b.md'], ['secret/c.md']])
    expect((await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)).ok).toBe(true)
    expect(answers).toEqual([null, { code: 'not-granted' }, { code: 'not-granted' }])
    const canonical = parts.decided.filter(access => access.action === 'luoshu.read' && access.stage === 'canonical')
    expect(canonical.map(access => [access.scope.paths, access.caller, access.onBehalf, access.agent])).toEqual(
      [['inbox/a.md'], ['inbox/b.md'], ['private/b.md'], ['secret/c.md']].map(paths => [paths, worker('mcp'), 'client#1', 'client#1']),
    )
  })

  it('refuses an agent\'s second ask outside the agent\'s grant or on mcp\'s item that asks at first use not-granted with no prompt', async () => {
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
    ['off', 'policy-down'],
    ['failed', 'policy-down'],
    ['starting', 'starting'],
  ] as const)('refuses an agent\'s second ask with the gate %s as its first ask is refused', async (state, refused) => {
    const parts = gated()
    const { parent } = await handled(parts.door, parts.mcp, 'client#1')
    const answers = again(parts, [['inbox/b.md']], () => { parts.loader.slots.gate = state })
    expect((await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)).ok).toBe(true)
    expect(answers).toEqual([{ code: refused }])
    // The first ask with the gate in that state
    expect(code(await parts.mcp.ask('luoshu.read', { path: 'inbox/b.md' }, parent))).toBe(refused)
    // A plugin's own second ask passes with the gate off by the human, as its first does
    if (state !== 'off') return
    parts.loader.slots.gate = 'on'
    const plain = again(parts, [['inbox/b.md']], () => { parts.loader.slots.gate = state })
    expect((await parts.search.ask('luoshu.read', { path: 'inbox/a.md' })).ok).toBe(true)
    expect(plain).toEqual([null])
  })
})

describe('the audit record of an agent\'s call', () => {
  it('names the inherited label on a sub-call and the parent\'s label, never its own, on one refused for setting its own', async () => {
    const { carrier, door, mcp, log } = agents()
    const { id, got, parent } = await handled(door, mcp)
    expect((await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)).ok).toBe(true)
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { ...parent, onBehalf: 'client#2' }))).toBe('invalid')
    mcp.answer(got.callId, null)
    await door.reply(id)
    const records = (await written(carrier, log)).map(record => [record.action, record.code, record.caller, record.root, record.onBehalf])
    expect(records).toEqual([
      ['luoshu.read', null, 'mcp/worker#1', 'http/host#1', 'client#1'],
      ['luoshu.read', 'invalid', 'mcp/worker#1', 'http/host#1', 'client#1'],
      ['mcp.handle', null, 'http/host#1', 'http/host#1', 'client#1'],
    ])
    expect(JSON.stringify(log.records)).not.toContain('client#2')
  })
})
