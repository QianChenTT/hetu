import { afterEach, describe, expect, it } from 'vitest'
import { createGate } from '../../plugins/gate/src/gate.ts'
import type { Carrier } from '../backend/carrier/carrier.ts'
import type { CarrierOptions } from '../backend/carrier/seams.ts'
import { cleanup, code, editor, type FakeLog, harness, host, hostHalf, tick, windowWay, worker, type Side } from './carrier-fakes.ts'

afterEach(cleanup)

// http's host half is the door. mcp serves handle for http only, search serves query and calls on. Every plugin holds
// what the tests reach, so a refusal comes from the rule a test is about
function agents(over: Partial<CarrierOptions> = {}) {
  const parts = harness(over)
  const { loader, gate, connect } = parts
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

  it('marks no agent under an mcp.handle from http\'s worker half, from another plugin or from the door with no label', async () => {
    const { door, httpWorker, mcp, beta, loader, gate } = agents()
    loader.sandboxed('mcp', { handle: { from: ['http', 'beta'] } })
    for (const from of [httpWorker, beta]) {
      from.call('mcp.handle', {}, { onBehalf: 'client#1' })
      const got = await mcp.waitFor(message => message.kind === 'call' && message.action === 'mcp.handle' && !(message as { seen?: boolean }).seen)
      ;(got as { seen?: boolean }).seen = true
      expect(got.onBehalf).toBe('client#1')
      expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: got.callId as string }))).toBe('not-granted')
      mcp.call('search.query', {}, { parent: got.callId as string })
    }
    await until(() => asked(gate, 'search.query').length === 4)
    expect(asked(gate, 'search.query').map(access => [access.onBehalf, access.agent])).toEqual(Array(4).fill(['client#1', undefined]))
    const { parent } = await handled(door, mcp, null)
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent))).toBe('not-granted')
    expect(gate.asked.filter(access => access.agent !== undefined)).toEqual([])
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

  it('lets mcp reach the luoshu under a parent from a door on an in-process handle too', async () => {
    const parts = harness()
    parts.loader.sandboxed('mcp', { handle: { from: ['http'] } })
    parts.gate.grants.http = [{ type: 'plugin.call', targets: ['mcp'] }]
    parts.gate.grants.mcp = [{ type: 'luoshu.read', paths: ['**'] }]
    parts.luoshu.files.set('inbox/a.md', 'a')
    const mcp = parts.connect(worker('mcp'))
    const door = hostHalf(parts.carrier, host('http'))
    void door.ask('mcp.handle', {}, { onBehalf: 'client#1' })
    const got = await mcp.delivered('mcp.handle')
    expect((await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: got.callId as string })).ok).toBe(true)
    expect(parts.gate.asked.filter(access => access.action === 'luoshu.read').map(access => access.agent)).toEqual(['client#1', 'client#1'])
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

// The real gate on one StateView: mcp holds inbox and private, agent #1 inbox and secret, search everything
function gated() {
  const gate = createGate()
  const items = (...paths: string[]) => [{ capability: { type: 'luoshu.read' as const, paths }, off: false, firstUse: false }]
  const table = <T>(entries: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), entries)
  gate.stateChanged({
    n: 1, foldCase: false, execAny: [],
    plugins: table({
      http: [{ capability: { type: 'plugin.call', targets: ['mcp'] }, off: false, firstUse: false }],
      mcp: [...items('inbox/**', 'private/**'), { capability: { type: 'plugin.call', targets: ['search'] }, off: false, firstUse: false }, { capability: { type: 'storage' }, off: false, firstUse: false }],
      search: items('**'),
    }),
    agents: table({
      'client#1': [...items('inbox/**', 'secret/**'), { capability: { type: 'storage' }, off: false, firstUse: false }],
      // Two agents that reach search through mcp, one reading inbox and one private
      'client#4': [...items('inbox/**'), { capability: { type: 'plugin.call', targets: ['search'] }, off: false, firstUse: false }],
      'client#5': [...items('private/**'), { capability: { type: 'plugin.call', targets: ['search'] }, off: false, firstUse: false }],
    }),
  })
  const parts = agents({ gate: () => gate })
  for (const path of ['private/b.md', 'secret/c.md']) parts.luoshu.files.set(path, path)
  return parts
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
      expect(code(await mcp.ask('events.subscribe', { topics: ['luoshu.changed'] }, parent))).toBe(down)
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
    const { door, mcp, search, loader } = gated()
    const one = await handled(door, mcp, 'client#1')
    mcp.call('search.query', {})
    const plain = await search.delivered('search.query')
    loader.slots.gate = 'off'
    expect(code(await mcp.ask('core.filterReadable', { call: one.got.callId, paths: every }))).toBe('policy-down')
    expect((await search.ask('core.filterReadable', { call: plain.callId, paths: every })).result).toEqual(every)
    loader.slots.gate = 'failed'
    expect(code(await mcp.ask('core.filterReadable', { call: one.got.callId, paths: every }))).toBe('policy-down')
    loader.slots.gate = 'starting'
    expect(code(await mcp.ask('core.filterReadable', { call: one.got.callId, paths: every }))).toBe('starting')
  })

  it('still asks for the door\'s own caller when the door named no agent, which reads nothing', async () => {
    const { door, mcp } = gated()
    const { got } = await handled(door, mcp, null)
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
