import { afterEach, describe, expect, it } from 'vitest'
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

// The call mcp got for the door's mcp.handle on behalf of label
async function handled(door: Side, mcp: Side, label: string | undefined = 'client#1') {
  const id = door.call('mcp.handle', { body: '{}' }, label === undefined ? {} : { onBehalf: label })
  const got = await mcp.waitFor(message => message.kind === 'call' && message.action === 'mcp.handle' && message.onBehalf === label)
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

  it('refuses a sub-call that sets its own onBehalf as invalid, its parent\'s own text included, and delivers nothing', async () => {
    const { door, mcp, search, luoshu } = agents()
    const { parent } = await handled(door, mcp)
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { ...parent, onBehalf: 'client#2' }))).toBe('invalid')
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, { ...parent, onBehalf: 'client#1' }))).toBe('invalid')
    expect(code(await mcp.ask('search.query', {}, { ...parent, onBehalf: 'client#2' }))).toBe('invalid')
    expect(luoshu.prepared).toEqual([])
    expect(search.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('keeps the own onBehalf of a call with no parent, a window\'s and a plugin\'s, and treats neither as an agent\'s', async () => {
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
    const { parent } = await handled(door, mcp, undefined)
    expect(code(await mcp.ask('luoshu.read', { path: 'inbox/a.md' }, parent))).toBe('not-granted')
    expect(gate.asked.filter(access => access.agent !== undefined)).toEqual([])
  })
})

describe('mcp\'s reach into notes, history and leases', () => {
  it('refuses mcp\'s luoshu, history and leases calls with no parent, and lets its storage and its own view through', async () => {
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

describe('the audit record of an agent\'s call', () => {
  it('names the inherited label on a sub-call, and the parent\'s label, never its own, on one refused for setting its own', async () => {
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
