import { afterEach, describe, expect, it } from 'vitest'
import { createGate } from '../backend/policy/gate/gate.ts'
import type { Access, Call, Gate } from '../api/policy-jobs.ts'
import type { Carrier } from '../backend/carrier/carrier.ts'
import type { CarrierOptions } from '../backend/carrier/seams.ts'
import { cleanup, code, editor, type FakeLog, harness, host, hostHalf, tick, windowWay, worker, type Side } from './carrier-fakes.ts'

afterEach(cleanup)

// http's host half on its utility port is the door. mcp serves handle for http only, search serves query and calls on.
// Every plugin holds what the tests reach, so a refusal comes from the rule a test is about
function agents(over: Partial<CarrierOptions> = {}) {
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
    await search.waitFor(message => message.kind === 'call' && message.caller !== undefined && (message.caller as { id: string }).id === 'mcp-http-handler')
    expect(gate.asked.filter(access => access.onBehalf === 'client#1').map(access => access.agent)).toEqual(Array(6).fill(undefined))
    // A sub-call under a call the door made to another plugin carries the label as nobody's agent
    const fromDoor = search.inbox.find(message => message.kind === 'call' && (message.caller as { id: string }).id === 'mcp-http-handler')!
    expect((await search.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: fromDoor.callId })).ok).toBe(true)
    expect(asked(gate, 'luoshu.read').at(-1)).toEqual({ stage: 'canonical', onBehalf: 'client#1', agent: undefined })
  })

  it('marks no agent under an mcp.handle from http\'s worker half or from another plugin', async () => {
    const { httpWorker, mcp, beta, pluginsManager, gate } = agents()
    pluginsManager.sandboxed('mcp', { handle: { from: ['mcp-http-handler', 'beta'] } })
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
    const { door, mcp, pluginsManager, gate, carrier, log } = agents()
    for (const state of ['on', 'off', 'failed'] as const) {
      pluginsManager.policyJobs.gate = state
      expect(code(await door.ask('mcp.handle', { body: '{}' }))).toBe('invalid')
    }
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
    expect(asked(gate, 'mcp.handle')).toEqual([])
    const records = (await written(carrier, log)).filter(record => record.action === 'mcp.handle')
    expect(records.map(record => record.code)).toEqual(['invalid', 'invalid', 'invalid'])
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

  it('refuses the door\'s mcp.handle for a label the plugins manager says is revoked as not-granted in every gate state and delivers nothing to mcp', async () => {
    const { door, mcp, pluginsManager, gate, carrier, log } = agents()
    pluginsManager.revokedLabels.add('client#1')
    for (const state of ['on', 'off', 'failed'] as const) {
      pluginsManager.policyJobs.gate = state
      expect(code(await door.ask('mcp.handle', { body: '{}' }, { onBehalf: 'client#1' }))).toBe('not-granted')
    }
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
    expect(asked(gate, 'mcp.handle')).toEqual([])
    const records = (await written(carrier, log)).filter(record => record.action === 'mcp.handle')
    expect(records.map(record => record.code)).toEqual(['not-granted', 'not-granted', 'not-granted'])
    pluginsManager.policyJobs.gate = 'on'
    // A label the first begins with is another agent
    const { got } = await handled(door, mcp, 'client#10')
    expect(got.onBehalf).toBe('client#10')
  })

  it('refuses the door\'s mcp.handle with a label as not-granted while the plugins manager\'s view of revoked labels throws or answers anything but false', async () => {
    const { door, mcp, pluginsManager } = agents()
    pluginsManager.revoked = () => { throw new Error('no view') }
    expect(code(await door.ask('mcp.handle', { body: '{}' }, { onBehalf: 'client#1' }))).toBe('not-granted')
    // An answer that is not plainly false refuses too
    pluginsManager.revoked = () => undefined as unknown as boolean
    expect(code(await door.ask('mcp.handle', { body: '{}' }, { onBehalf: 'client#1' }))).toBe('not-granted')
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('asks the plugins manager about the door\'s mcp.handle alone, a revoked label on any other call kept as text', async () => {
    const { door, httpWorker, search, pluginsManager } = agents()
    const seen: string[] = []
    pluginsManager.revoked = label => {
      seen.push(label)
      return true
    }
    door.call('search.query', {}, { onBehalf: 'client#1' })
    expect((await search.delivered('search.query')).onBehalf).toBe('client#1')
    httpWorker.call('mcp.handle', {}, { onBehalf: 'client#1' })
    await tick(30)
    expect(seen).toEqual([])
  })

  it('marks an agent whose client id is a metadata document\'s address', async () => {
    const { door, mcp, gate } = agents()
    const label = 'https://claude.ai/oauth/claude-code-client-metadata#3'
    const { parent } = await handled(door, mcp, label)
    expect((await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)).ok).toBe(true)
    expect(asked(gate, 'luoshu.read').map(access => access.agent)).toEqual([label, label])
  })

  it('still delivers an mcp.handle with no label that is not the door\'s and the door\'s other calls with no label', async () => {
    const { door, httpWorker, mcp, search, pluginsManager } = agents()
    pluginsManager.sandboxed('mcp', { handle: { from: ['mcp-http-handler', 'beta'] } })
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
    const { mcp, search, beta, pluginsManager, gate } = agents()
    pluginsManager.plugins.mcp.topics = ['seen']
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
    const { beta, mcp, search, httpWorker, pluginsManager } = agents()
    pluginsManager.sandboxed('mcp', { handle: { from: ['mcp-http-handler', 'beta', 'search'] } })
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
    const { door, mcp, search, pluginsManager, luoshu } = agents()
    pluginsManager.human.plugins['mcp-http-handler'] = { callDeadlineMs: 4000 }
    pluginsManager.human.plugins.mcp = { callDeadlineMs: 60000 }
    pluginsManager.human.plugins.search = { callDeadlineMs: 60000 }
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
    parts.pluginsManager.utility('mcp-http-handler')
    parts.pluginsManager.sandboxed('mcp', { handle: { from: ['mcp-http-handler'] } })
    parts.gate.grants['mcp-http-handler'] = [{ type: 'plugin.call', targets: ['mcp'] }]
    parts.gate.grants.mcp = [{ type: 'luoshu.read', paths: ['**'] }]
    parts.luoshu.files.set('inbox/a.md', 'a')
    const mcp = parts.connect(worker('mcp'))
    const door = hostHalf(parts.carrier, host('mcp-http-handler'))
    void door.ask('mcp.handle', {}, { onBehalf: 'client#1' })
    const got = await mcp.delivered('mcp.handle')
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { parent: got.callId as string }))).toBe('not-granted')
    expect(parts.gate.asked.filter(access => access.agent !== undefined)).toEqual([])
  })

  it.each([
    ['on the host', (pluginsManager: ReturnType<typeof agents>['pluginsManager']) => pluginsManager.installed('mcp-http-handler')],
    ['in the sandbox, as a plugin named http from the plugin folder', (pluginsManager: ReturnType<typeof agents>['pluginsManager']) => pluginsManager.sandboxed('mcp-http-handler')],
  ])('marks no agent under the same call from http\'s host half on its port with http placed %s', async (_place, place) => {
    const parts = agents()
    place(parts.pluginsManager)
    expect(await under(parts, label => parts.door.call('mcp.handle', {}, { onBehalf: label }))).toEqual({ code: 'not-granted', agents: [] })
    // The same half once the plugins manager reads http placed utility again
    parts.pluginsManager.utility('mcp-http-handler')
    const again = await under(parts, label => parts.door.call('mcp.handle', {}, { onBehalf: label }))
    expect(again).toEqual({ code: null, agents: ['client#1', 'client#1'] })
  })

  it('marks no agent under an mcp.handle the door made under a call another plugin sent it with its own label', async () => {
    const parts = agents()
    parts.pluginsManager.plugins['mcp-http-handler'].actions = { go: {} }
    parts.gate.grants.beta.push({ type: 'plugin.call', targets: ['mcp-http-handler'] })
    parts.beta.call('mcp-http-handler.go', {}, { onBehalf: 'client#1' })
    const atDoor = await parts.door.delivered('mcp-http-handler.go')
    expect(atDoor.onBehalf).toBe('client#1')
    expect(await under(parts, () => parts.door.call('mcp.handle', {}, { parent: atDoor.callId as string }))).toEqual({ code: 'not-granted', agents: [] })
  })

  it('marks no agent under mcp.handle from a worker of a plugin named http from the plugin folder', async () => {
    const parts = agents()
    parts.pluginsManager.sandboxed('mcp-http-handler')
    expect(await under(parts, label => parts.httpWorker.call('mcp.handle', {}, { onBehalf: label }))).toEqual({ code: 'not-granted', agents: [] })
  })
})

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
    expect(performed).toEqual(state === 'on' ? [['inbox/a.md']] : [])
  })

  it('refuses an agent\'s free call, its listing and a core action while the gate isn\'t on and serves them while it is', async () => {
    const { door, mcp, pluginsManager } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    for (const state of ['off', 'failed'] as const) {
      pluginsManager.policyJobs.gate = state
      expect(code(await mcp.ask('storage.set', { key: 'k', value: 1 }, parent))).toBe('policy-down')
      expect(code(await mcp.ask('luoshu.list', {}, parent))).toBe('policy-down')
      expect(code(await mcp.ask('core.self', undefined, parent))).toBe('policy-down')
      // A subscribe of mcp's to another plugin's topic is refused at the floor before the gate's state is read
      expect(code(await mcp.ask('events.subscribe', { topics: ['luoshu.changed'] }, parent))).toBe('not-granted')
      // mcp's own free call with no parent is its own and free whatever the gate's state, as any plugin's
      expect((await mcp.ask('storage.set', { key: 'k', value: 1 })).ok).toBe(true)
    }
    pluginsManager.policyJobs.gate = 'on'
    expect((await mcp.ask('storage.set', { key: 'k', value: 1 }, parent)).ok).toBe(true)
    expect((await mcp.ask('core.self', undefined, parent)).ok).toBe(true)
  })

  it('refuses an agent\'s call at the canonical judgement when the human switched the gate off while the luoshu prepared it', async () => {
    const { door, mcp, pluginsManager, luoshu, search } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    let open!: () => void
    luoshu.hold.prepare = new Promise<void>(resolve => { open = resolve })
    const id = mcp.call('luoshu.read', { path: 'inbox/a.md' }, parent)
    const plain = search.call('luoshu.read', { path: 'inbox/a.md' })
    for (let i = 0; i < 200 && luoshu.prepared.length < 2; i++) await tick(2)
    pluginsManager.policyJobs.gate = 'off'
    open()
    expect(code(await mcp.reply(id))).toBe('policy-down')
    expect((await search.reply(plain)).ok).toBe(true)
    expect(luoshu.performed.map(done => done.call.caller)).toEqual([worker('search')])
  })

  it.each([
    ['on', null], ['off', 'policy-down'], ['failed', 'policy-down'], ['absent', 'policy-down'],
  ] as const)('answers the door\'s mcp.handle with a label with the gate %s before mcp sees it, a plugin\'s own call beside it as before', async (state, expected) => {
    const { door, mcp, search, pluginsManager, luoshu } = gated()
    pluginsManager.policyJobs.gate = state
    const id = door.call('mcp.handle', { body: '{}' }, { onBehalf: 'client#1' })
    if (expected === null) {
      expect((await mcp.delivered('mcp.handle')).onBehalf).toBe('client#1')
    } else {
      expect(code(await door.reply(id))).toBe(expected)
      expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
    }
    // The door's call with no label is refused for its form in every state. A plugin's own call is judged as before
    expect(code(await door.ask('mcp.handle', { body: '{}' }))).toBe('invalid')
    const own = await search.ask('luoshu.read', { path: 'inbox/a.md' })
    expect(code(own)).toBe(state === 'on' || state === 'off' ? null : 'policy-down')
    expect(luoshu.performed.filter(done => done.call.caller.kind === 'plugin' && done.call.caller.id === 'mcp')).toEqual([])
  })

  it.each([
    ['on', 'not-granted'], ['off', 'policy-down'], ['failed', 'policy-down'], ['absent', 'policy-down'],
  ] as const)('tells an agent its items don\'t allow nothing of mcp\'s switched-off or asking items, raising no prompt, with the gate %s', async (state, expected) => {
    const { door, mcp, pluginsManager, asks, luoshu } = gated()
    luoshu.files.set('off/n.md', 'off')
    const two = await handled(door, mcp, 'client#2')
    pluginsManager.policyJobs.gate = state
    for (const path of ['off/n.md', 'asks/a.md', 'secret/c.md']) expect(code(await mcp.ask('luoshu.read', { path }, two.parent))).toBe(expected)
    expect(asks).toEqual([])
  })

  it('answers stopped for the door\'s mcp.handle with the gate off once shutdown began', async () => {
    const { carrier, door, mcp, pluginsManager } = gated()
    pluginsManager.policyJobs.gate = 'off'
    carrier.stopping()
    expect(code(await door.ask('mcp.handle', {}, { onBehalf: 'client#1' }))).toBe('stopped')
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('answers stopped for the door\'s mcp.handle with the gate still on once shutdown began, as with the gate off', async () => {
    const { carrier, door, mcp } = gated()
    carrier.stopping()
    expect(code(await door.ask('mcp.handle', {}, { onBehalf: 'client#1' }))).toBe('stopped')
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('answers stopped for an agent\'s call with the gate still on once shutdown began and judges a plugin\'s own call as before', async () => {
    const { carrier, door, mcp, search } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    carrier.stopping()
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent))).toBe('stopped')
    expect((await search.ask('luoshu.read', { path: 'inbox/a.md' })).ok).toBe(true)
  })

  it('answers stopped for an agent\'s call with the gate off once shutdown began', async () => {
    const { carrier, door, mcp, pluginsManager } = gated()
    const { parent } = await handled(door, mcp, 'client#1')
    pluginsManager.policyJobs.gate = 'off'
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
    const { door, mcp, search, beta, pluginsManager } = gated()
    const one = await handled(door, mcp, 'client#1')
    beta.call('search.query', {})
    const plain = await search.delivered('search.query')
    pluginsManager.policyJobs.gate = 'off'
    expect(code(await mcp.ask('core.filterReadable', { call: one.got.callId, paths: every }))).toBe('policy-down')
    expect((await search.ask('core.filterReadable', { call: plain.callId, paths: every })).result).toEqual(every)
    pluginsManager.policyJobs.gate = 'failed'
    expect(code(await mcp.ask('core.filterReadable', { call: one.got.callId, paths: every }))).toBe('policy-down')
  })

  it('keeps nothing for a call another plugin made to mcp with a label, which the door did not make', async () => {
    const { mcp, beta, pluginsManager } = gated()
    pluginsManager.sandboxed('mcp', { handle: { from: ['mcp-http-handler', 'beta'] } })
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
    parts.pluginsManager.sandboxed('mcp', { handle: { from: ['mcp-http-handler', 'beta'] } })
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

  it('refuses it under a door call that ended, with a label in its arguments, past eight items, with a scope a screen hides and with an item with no scope', async () => {
    const { door, mcp, seen } = asking()
    const one = await handled(door, mcp, 'client#1')
    const two = await handled(door, mcp, 'client#2')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [inbox], agent: 'client#2' }, two.parent))).toBe('invalid')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [] }, two.parent))).toBe('invalid')
    const nine = Array.from({ length: 9 }, (_, i) => ({ type: 'luoshu.read', paths: [`n${i}/**`] }))
    expect(code(await mcp.ask('core.agentAsk', { capabilities: nine }, two.parent))).toBe('invalid')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [{ type: 'luoshu.read', paths: ['in\nbox/**'] }] }, two.parent))).toBe('invalid')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [{ type: 'luoshu.read', paths: [`in${String.fromCharCode(0x202e)}box/**`] }] }, two.parent))).toBe('invalid')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [inbox, { type: 'luoshu.read', paths: [] }] }, two.parent))).toBe('invalid')
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [{ type: 'plugin.call', targets: [] }] }, two.parent))).toBe('invalid')
    mcp.answer(one.got.callId, null)
    await door.reply(one.id)
    expect(code(await mcp.ask('core.agentAsk', { capabilities: [inbox] }, one.parent))).toBe('invalid')
    expect(seen).toEqual([])
    expect(code(await mcp.ask('core.agentAsk', { capabilities: Array.from({ length: 8 }, (_, i) => ({ type: 'luoshu.read', paths: [`n${i}/**`] })) }, two.parent))).toBe(null)
  })

  it('refuses it while the gate is not on, as any call for an agent', async () => {
    const { door, mcp, pluginsManager, seen } = asking()
    const { parent } = await handled(door, mcp, 'client#1')
    for (const state of ['off', 'failed'] as const) {
      pluginsManager.policyJobs.gate = state
      expect(code(await mcp.ask('core.agentAsk', { capabilities: [inbox] }, parent))).toBe('policy-down')
    }
    expect(seen).toEqual([])
  })
})

describe('core.agents, what http asks about its agents', () => {
  it('takes it from the door\'s half alone, never from mcp, http\'s worker, another plugin or a window', async () => {
    const seen: Call[] = []
    const { carrier, door, httpWorker, mcp, search } = agents({ core: async call => { seen.push(call); return [] } })
    const args = { agents: ['client#1'] }
    expect((await door.ask('core.agents', args)).ok).toBe(true)
    for (const side of [httpWorker, mcp, search]) expect(code(await side.ask('core.agents', args))).toBe('not-granted')
    const way = windowWay(carrier, { trusted: { kind: 'window', role: 'trusted', n: 1 } })
    expect(code(await way.ask('trusted', 'core.agents', args))).toBe('not-granted')
    expect(code(await door.ask('core.agents', { agents: ['client'] }))).toBe('invalid')
    expect(code(await door.ask('core.agents', { agents: [] }))).toBe('invalid')
    expect(seen.map(call => call.caller)).toEqual([host('mcp-http-handler')])
  })
})

describe('core.agentConnect and core.agentConnected, the connect http asks the core', () => {
  const connect = { client: 'https://claude.ai/oauth/claude-code-client-metadata', name: 'Claude Code', redirect: 'http://localhost:33418/callback', number: 3 }
  const collect = { handle: 'A'.repeat(32) }

  it('takes both from the door\'s half alone, never from mcp, http\'s worker, another plugin or a window', async () => {
    const seen: Call[] = []
    const { carrier, door, httpWorker, mcp, search } = agents({ core: async call => { seen.push(call); return null } })
    const way = windowWay(carrier, { trusted: { kind: 'window', role: 'trusted', n: 1 }, editor: { kind: 'window', role: 'editor', n: 2 } })
    for (const [action, args] of [['core.agentConnect', connect], ['core.agentConnected', collect]] as const) {
      expect((await door.ask(action, args)).ok).toBe(true)
      for (const side of [httpWorker, mcp, search]) expect(code(await side.ask(action, args))).toBe('not-granted')
      for (const role of ['trusted', 'editor']) expect(code(await way.ask(role, action, args))).toBe('not-granted')
    }
    expect(seen.map(call => [call.action, call.caller])).toEqual([['core.agentConnect', host('mcp-http-handler')], ['core.agentConnected', host('mcp-http-handler')]])
  })

  it.each([
    ['on the host', (pluginsManager: ReturnType<typeof agents>['pluginsManager']) => pluginsManager.installed('mcp-http-handler')],
    ['in the sandbox, as a plugin named http from the plugin folder', (pluginsManager: ReturnType<typeof agents>['pluginsManager']) => pluginsManager.sandboxed('mcp-http-handler')],
  ])('refuses both from http\'s host half with http placed %s', async (_place, place) => {
    const seen: Call[] = []
    const parts = agents({ core: async call => { seen.push(call); return null } })
    place(parts.pluginsManager)
    expect(code(await parts.door.ask('core.agentConnect', connect))).toBe('not-granted')
    expect(code(await parts.door.ask('core.agentConnected', collect))).toBe('not-granted')
    expect(seen).toEqual([])
  })

  it('takes no handle from http and no label, a handle only in a token\'s form', async () => {
    const seen: Call[] = []
    const { door } = agents({ core: async call => { seen.push(call); return null } })
    expect(code(await door.ask('core.agentConnect', { ...connect, handle: collect.handle }))).toBe('invalid')
    expect(code(await door.ask('core.agentConnect', { ...connect, agent: 'client#3' }))).toBe('invalid')
    expect(code(await door.ask('core.agentConnected', { handle: 'not a token' }))).toBe('invalid')
    expect(code(await door.ask('core.agentConnected', {}))).toBe('invalid')
    expect(seen).toEqual([])
  })

  it('serves both while the gate is not on, since a connect gives the agent nothing', async () => {
    const seen: Call[] = []
    const { door, pluginsManager } = agents({ core: async call => { seen.push(call); return null } })
    for (const state of ['off', 'failed', 'absent'] as const) {
      pluginsManager.policyJobs.gate = state
      expect((await door.ask('core.agentConnect', connect)).ok).toBe(true)
      expect((await door.ask('core.agentConnected', collect)).ok).toBe(true)
    }
    expect(seen).toHaveLength(6)
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
  ] as const)('refuses an agent\'s second ask with the gate %s as its first ask is refused', async (state, refused) => {
    const parts = gated()
    const { parent } = await handled(parts.door, parts.mcp, 'client#1')
    const answers = again(parts, [['inbox/b.md']], () => { parts.pluginsManager.policyJobs.gate = state })
    expect((await parts.mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent)).ok).toBe(true)
    expect(answers).toEqual([{ code: refused }])
    // The first ask with the gate in that state
    expect(code(await parts.mcp.ask('luoshu.read', { path: 'inbox/b.md' }, parent))).toBe(refused)
    // A plugin's own second ask passes with the gate off by the human, as its first does
    if (state !== 'off') return
    parts.pluginsManager.policyJobs.gate = 'on'
    const plain = again(parts, [['inbox/b.md']], () => { parts.pluginsManager.policyJobs.gate = state })
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
      ['luoshu.read', null, 'mcp/worker#1', 'mcp-http-handler/host#1', 'client#1'],
      ['luoshu.read', 'invalid', 'mcp/worker#1', 'mcp-http-handler/host#1', 'client#1'],
      ['mcp.handle', null, 'mcp-http-handler/host#1', 'mcp-http-handler/host#1', 'client#1'],
    ])
    expect(JSON.stringify(log.records)).not.toContain('client#2')
  })
})

// The real gate on one grants snapshot where mcp, search and agent #1 each hold an item for every provider action the tests
// reach, so a refusal comes from the table and never from a missing item. history, exec and leases are providers that
// note what reached them and act on nothing
function tabled() {
  const real = createGate()
  const decided: Access[] = []
  const gate: Gate = {
    ...real,
    decide: access => {
      decided.push(access)
      return real.decide(access)
    },
  }
  const held = (...capabilities: object[]) => capabilities.map(capability => ({ capability, off: false, firstUse: false }))
  const every = held(
    { type: 'luoshu.read', paths: ['**'] }, { type: 'luoshu.write', paths: ['**'] }, { type: 'history', access: 'read', paths: ['**'] },
    { type: 'history', access: 'commit', paths: ['**'] }, { type: 'exec', commands: [['cat', 'inbox/a.md']], env: [] }, { type: 'storage' },
  )
  const table = <T>(entries: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), entries)
  gate.stateChanged({
    n: 1, foldCase: false, execAny: [],
    plugins: table({
      'mcp-http-handler': held({ type: 'plugin.call', targets: ['mcp'] }),
      mcp: [...every, ...held({ type: 'plugin.call', targets: ['search'] })],
      search: every,
    }),
    agents: table({ 'client#1': [...every, ...held({ type: 'plugin.call', targets: ['search'] })] }),
  } as never)
  const parts = agents({ gate: () => gate })
  const reached: Record<string, string[]> = { history: [], exec: [], leases: [] }
  for (const id of Object.keys(reached)) {
    parts.providers[id] = {
      prepare: async (call: Call) => {
        reached[id].push(call.action)
        const args = call.args as { path?: string, paths?: string[] } | undefined
        const paths = args?.path !== undefined ? [args.path] : args?.paths
        return { scope: paths === undefined ? {} : { paths } }
      },
      perform: async () => ({ done: true }),
    }
  }
  return { ...parts, decided, reached }
}

const SHA = '0'.repeat(64)
// Every provider action no tool marks that an agent's item could cover, each with arguments its schema takes
const closed: [string, unknown][] = [
  ['luoshu.move', { from: 'inbox/a.md', to: 'inbox/b.md' }],
  ['luoshu.remove', { path: 'inbox/a.md', baseVersion: SHA }],
  ['exec.run', { command: ['cat', 'inbox/a.md'] }],
  ['history.commit', { paths: ['inbox/a.md'], message: 'm' }],
  ['history.read', { path: 'inbox/a.md', commit: '0'.repeat(40) }],
  ['leases.acquire', { paths: ['inbox/a.md'] }],
  ['leases.renew', undefined],
  ['leases.release', undefined],
  ['leases.list', undefined],
]

describe('the tool table at the floor, for a call under an agent\'s chain', () => {
  // What reached a provider or the gate for the actions named
  const touched = (parts: ReturnType<typeof tabled>, actions: string[]) => ({
    luoshu: parts.luoshu.prepared.filter(call => actions.includes(call.action)).map(call => call.action),
    others: Object.values(parts.reached).flat().filter(action => actions.includes(action)),
    gate: parts.decided.filter(access => actions.includes(access.action)).map(access => access.action),
  })
  const names = closed.map(([action]) => action)

  it.each(['on', 'off', 'failed', 'absent'] as const)('refuses each action no tool marks as not-granted before the gate and the provider, the agent holding an item for it, with the gate %s', async state => {
    const parts = tabled()
    const { parent } = await handled(parts.door, parts.mcp, 'client#1')
    parts.pluginsManager.policyJobs.gate = state
    const answers: [string, string | null][] = []
    for (const [action, args] of closed) answers.push([action, code(await parts.mcp.ask(action, args, parent))])
    expect(answers).toEqual(closed.map(([action]) => [action, 'not-granted']))
    expect(touched(parts, names)).toEqual({ luoshu: [], others: [], gate: [] })
    expect(parts.luoshu.files.get('inbox/a.md')).toBe('a')
  })

  it('lets the four marked actions on to the gate and their providers, then answers each as the gate\'s state has it', async () => {
    const parts = tabled()
    const { parent } = await handled(parts.door, parts.mcp, 'client#1')
    const marked: [string, unknown][] = [
      ['luoshu.read', { path: 'inbox/a.md' }], ['luoshu.list', {}], ['luoshu.write', { path: 'inbox/n.md', text: 'n' }],
      ['history.log', { path: 'inbox/a.md' }],
    ]
    for (const [action, args] of marked) expect([action, code(await parts.mcp.ask(action, args, parent))]).toEqual([action, null])
    expect(touched(parts, marked.map(([action]) => action))).toEqual({
      luoshu: ['luoshu.read', 'luoshu.list', 'luoshu.write'], others: ['history.log'], gate: ['luoshu.read', 'luoshu.read', 'luoshu.write', 'luoshu.write', 'history.log', 'history.log'],
    })
    // With the gate not on, a marked action is refused for the gate's state and never for the table
    for (const state of ['off', 'failed'] as const) {
      parts.pluginsManager.policyJobs.gate = state
      for (const [action, args] of marked) expect([action, code(await parts.mcp.ask(action, args, parent))]).toEqual([action, 'policy-down'])
    }
  })

  it('holds a plugin\'s call three calls deep to the table as it holds mcp, its own storage and cache left to it', async () => {
    const parts = tabled()
    const { parent } = await handled(parts.door, parts.mcp, 'client#1')
    parts.mcp.call('search.query', {}, parent)
    const under = { parent: (await parts.search.delivered('search.query')).callId as string }
    for (const [action, args] of closed) expect([action, code(await parts.search.ask(action, args, under))]).toEqual([action, 'not-granted'])
    expect(touched(parts, names)).toEqual({ luoshu: [], others: [], gate: [] })
    expect(code(await parts.search.ask('luoshu.read', { path: 'inbox/a.md' }, under))).toBe(null)
    for (const action of ['storage.set', 'cache.set']) {
      expect(code(await parts.search.ask(action, { key: 'k', value: 1 }, under))).toBe(null)
      expect(code(await parts.mcp.ask(action, { key: 'k', value: 1 }, parent))).toBe(null)
    }
  })

  it('leaves the same calls with no agent as before: mcp with no parent refused, another plugin\'s own judged by its own items', async () => {
    const parts = tabled()
    for (const [action, args] of closed) expect([action, code(await parts.mcp.ask(action, args))]).toEqual([action, 'not-granted'])
    expect(touched(parts, names)).toEqual({ luoshu: [], others: [], gate: [] })
    for (const [action, args] of closed) await parts.search.ask(action, args)
    expect(touched(parts, names)).toEqual({
      luoshu: ['luoshu.move', 'luoshu.remove'],
      others: ['history.commit', 'history.read', 'exec.run', 'leases.acquire', 'leases.renew', 'leases.release', 'leases.list'],
      gate: ['luoshu.move', 'luoshu.move', 'luoshu.move', 'luoshu.move', 'luoshu.remove', 'luoshu.remove', 'exec.run', 'exec.run', 'history.commit', 'history.commit', 'history.read', 'history.read', 'leases.acquire', 'leases.acquire'],
    })
    // A label a plugin sends on its own call is text and marks no agent, so the table holds nothing to it
    parts.luoshu.files.set('inbox/l.md', 'l')
    expect(code(await parts.search.ask('luoshu.move', { from: 'inbox/l.md', to: 'inbox/c.md' }, { onBehalf: 'client#1' }))).toBe(null)
    expect(parts.luoshu.files.has('inbox/c.md')).toBe(true)
  })

  it('writes the refusal\'s record with the agent\'s label, the door at its root', async () => {
    const { carrier, door, mcp, log } = tabled()
    const { parent } = await handled(door, mcp, 'client#1')
    expect(code(await mcp.ask('luoshu.move', { from: 'inbox/a.md', to: 'inbox/b.md' }, parent))).toBe('not-granted')
    const records = (await written(carrier, log)).filter(record => record.action === 'luoshu.move')
    expect(records.map(record => [record.code, record.caller, record.root, record.onBehalf])).toEqual([['not-granted', 'mcp/worker#1', 'mcp-http-handler/host#1', 'client#1']])
  })
})
