import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import { EventLog } from '../lib/event-log.ts'
import { FloorLane } from '../backend/carrier/records.ts'
import type { CarrierOptions, FloorLog, Landing } from '../backend/carrier/seams.ts'
import { cleanup, code, editor, FakeLog, harness, host, hostHalf, tick, windowWay, worker } from './carrier-fakes.ts'

afterEach(cleanup)

const idOf = (caller: Caller) => (caller as { id: string }).id

// http reaches mcp and search, the two serving one action each
function plugins(over: Partial<CarrierOptions> = {}) {
  const parts = harness(over)
  const { loader, gate, connect } = parts
  loader.sandboxed('search', { query: {} })
  loader.sandboxed('mcp', { handle: {} })
  gate.grants.http = [{ type: 'plugin.call', targets: ['mcp', 'search'] }]
  return { ...parts, http: connect(worker('http')), mcp: connect(worker('mcp')), search: connect(worker('search')) }
}

describe('the audit queue', () => {
  it('holds one record per call with the caller, onBehalf, root, action, canonical scope, code and gate state, never args or results', async () => {
    const { carrier, connect, gate, loader } = harness()
    loader.sandboxed('mcp', { handle: {} })
    gate.grants.http = [{ type: 'plugin.call', targets: ['mcp'] }]
    gate.grants.mcp = [{ type: 'vault.write', paths: ['notes/**'] }]
    const http = connect(worker('http'))
    const mcp = connect(worker('mcp'))
    const id = http.call('mcp.handle', { prompt: 'secret prompt' }, { onBehalf: 'agent-a' })
    const parent = await mcp.delivered('mcp.handle')
    const write = await mcp.ask('vault.write', { path: 'notes/a.md', text: 'secret note text' }, { parent: parent.callId, onBehalf: 'agent-a' })
    expect(write.ok).toBe(true)
    mcp.answer(parent.callId, { said: 'secret result' })
    await http.reply(id)
    const records = carrier.audit.next(10)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      caller: worker('mcp'), onBehalf: 'agent-a', root: worker('http'), action: 'vault.write',
      scope: { paths: ['notes/a.md'] }, code: null, gate: 'on', count: 1,
    })
    expect(records[1]).toMatchObject({ caller: worker('http'), root: worker('http'), action: 'mcp.handle', scope: { target: 'mcp' }, code: null })
    expect(typeof records[0].ms).toBe('number')
    const text = JSON.stringify(records)
    for (const secret of ['secret prompt', 'secret note text', 'secret result']) expect(text).not.toContain(secret)
  })

  it('records a refusal with its code and the gate\'s state', async () => {
    const { carrier, connect, loader } = harness()
    loader.slots.gate = 'failed'
    await connect(worker('search')).ask('vault.read', { path: 'a.md' })
    expect(carrier.audit.next(10)).toMatchObject([{ action: 'vault.read', code: 'policy-down', gate: 'failed', count: 1 }])
  })

  // The caller's own text is no canonical scope, so a call refused at precheck records no path
  it('records no path for a call refused before prepare and the canonical one once prepare ran', async () => {
    let clock = 1_000_000
    const { carrier, connect, gate } = harness({ now: () => clock })
    gate.grants.search = [{ type: 'vault.read', paths: ['notes/**'] }]
    const search = connect(worker('search'))
    expect(code(await search.ask('vault.read', { path: 'secret/a.md' }))).toBe('not-granted')
    clock += 1000
    gate.grants.search = [{ type: 'vault.read', paths: ['**'] }]
    expect(code(await search.ask('vault.read', { path: 'GIT~1/config' }))).toBe('not-granted')
    const records = carrier.audit.next(10)
    expect(records.map(record => [record.code, record.scope])).toEqual([['not-granted', undefined], ['not-granted', { paths: ['.git/config'] }]])
    expect('scope' in records[0]).toBe(false)
  })

  it('names onBehalf and the root of a live parent for a call refused before the ceiling took it', async () => {
    const { carrier, http, mcp, loader } = plugins()
    loader.human.plugins.http = { callsInFlight: 1 }
    http.call('mcp.handle', {}, { onBehalf: 'agent-a' })
    const parent = await mcp.delivered('mcp.handle')
    const under = { parent: parent.callId, onBehalf: 'agent-a' }
    expect(code(await mcp.ask('vault.read', { path: '' }, under))).toBe('invalid')
    expect(code(await mcp.ask('security.request', { change: { kind: 'plugin.on', plugin: 'search' } }, under))).toBe('not-granted')
    expect(code(await mcp.ask('core.self', undefined, under))).toBe('throttled')
    const refused = carrier.audit.next(10).filter(record => record.code !== null)
    expect(refused.map(record => [record.action, record.code, idOf(record.caller), idOf(record.root), record.onBehalf])).toEqual([
      ['vault.read', 'invalid', 'mcp', 'http', 'agent-a'],
      ['security.request', 'not-granted', 'mcp', 'http', 'agent-a'],
      ['core.self', 'throttled', 'mcp', 'http', 'agent-a'],
    ])
  })

  it('records the gate\'s state for a call without power and a state outside the list as failed', async () => {
    let clock = 1_000_000
    const { carrier, connect, loader } = harness({ now: () => clock })
    const search = connect(worker('search'))
    loader.slots.gate = 'failed'
    await search.ask('storage.get', { key: 'k' })
    clock += 1000
    loader.slots.gate = 'ON' as never
    await search.ask('storage.get', { key: 'k' })
    expect(carrier.audit.next(10).map(record => [record.action, record.code, record.gate])).toEqual([
      ['storage.get', null, 'failed'], ['storage.get', null, 'failed'],
    ])
  })

  it('coalesces reads and refusals per caller per second, and keeps writes one record each', async () => {
    let clock = 1_000_000
    const { carrier, connect, gate, vault } = harness({ now: () => clock })
    gate.grants.search = [{ type: 'vault.read', paths: ['notes/**'] }, { type: 'vault.write', paths: ['notes/**'] }]
    for (const name of ['a', 'b', 'c']) vault.files.set(`notes/${name}.md`, name)
    const search = connect(worker('search'))
    for (const name of ['a', 'b', 'c']) await search.ask('vault.read', { path: `notes/${name}.md` })
    for (let i = 0; i < 4; i++) await search.ask('vault.read', { path: 'secret/x.md' })
    await search.ask('vault.write', { path: 'notes/a.md', text: '1' })
    await search.ask('vault.write', { path: 'notes/a.md', text: '2' })
    await search.ask('storage.get', { key: 'index' })
    await search.ask('storage.get', { key: 'other' })
    clock += 1000
    await search.ask('vault.read', { path: 'notes/a.md' })
    const records = carrier.audit.next(100).map(record => [record.action, record.code, record.count])
    expect(records).toEqual([
      ['vault.read', null, 3],
      ['vault.read', 'not-granted', 4],
      ['vault.write', null, 1],
      ['vault.write', null, 1],
      ['storage.get', null, 2],
      ['vault.read', null, 1],
    ])
  })

  it('coalesces free calls between a plugin\'s own halves and keeps calls to other plugins one each', async () => {
    const clock = 1_000_000
    const { carrier, connect, loader, gate } = harness({ now: () => clock })
    loader.sandboxed('search', { query: {} })
    loader.sandboxed('git', { log: {} })
    gate.grants.search = [{ type: 'plugin.call', targets: ['git'] }]
    const search = connect(worker('search'))
    const git = connect(worker('git'))
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    for (let i = 0; i < 3; i++) {
      const id = panel.call('search.query')
      await tick(5)
      const calls = search.inbox.filter(message => message.kind === 'call')
      search.answer(calls.at(-1)!.callId, i)
      await panel.reply(id)
    }
    for (let i = 0; i < 2; i++) {
      const id = search.call('git.log')
      await tick(5)
      const calls = git.inbox.filter(message => message.kind === 'call')
      git.answer(calls.at(-1)!.callId, i)
      await search.reply(id)
    }
    expect(carrier.audit.next(100).map(record => [record.action, record.count])).toEqual([
      ['search.query', 3], ['git.log', 1], ['git.log', 1],
    ])
  })

  it('stops coalescing into a record once the log has taken it', async () => {
    const clock = 1_000_000
    const { carrier, connect } = harness({ now: () => clock })
    const search = connect(worker('search'))
    await search.ask('core.self')
    expect(carrier.audit.next(10).map(record => record.count)).toEqual([1])
    await search.ask('core.self')
    await search.ask('core.self')
    expect(carrier.audit.next(10).map(record => record.count)).toEqual([2])
  })

  it('hands records out with next and lets go of them with ack', async () => {
    const { carrier, connect } = harness()
    const search = connect(worker('search'))
    for (let i = 0; i < 3; i++) await search.ask('storage.set', { key: `k${i}`, value: i })
    const first = carrier.audit.next(2)
    expect(first).toHaveLength(2)
    expect(carrier.audit.next(5)).toHaveLength(1)
    carrier.audit.ack(first[1].seq)
    // Acknowledged records are gone, the one taken after them stays until its own ack
    expect(carrier.audit.next(5)).toEqual([])
    await search.ask('storage.set', { key: 'k3', value: 3 })
    const later = carrier.audit.next(5)
    expect(later.map(record => record.seq)).toEqual([first[1].seq + 2])
  })

  it('drops a record past the bound, counts it in a floor record and still answers the call', async () => {
    const { carrier, connect, loader, log } = harness()
    loader.human.all = { auditQueue: 2 }
    const search = connect(worker('search'))
    for (let i = 0; i < 4; i++) expect((await search.ask('storage.set', { key: `k${i}`, value: i })).ok).toBe(true)
    const taken = carrier.audit.next(10)
    expect(taken).toHaveLength(2)
    // Acknowledged, so close has nothing left to count as lost to shutdown
    carrier.audit.ack(taken[1].seq)
    carrier.close()
    await tick()
    expect(log.events('audit.dropped').map(record => record.fields)).toEqual([
      { why: 'full', count: 1 }, { why: 'full', count: 1 },
    ])
  })

  it('queues records while the log starts and keeps none while it is off by the human', async () => {
    const { carrier, connect, loader } = harness()
    const search = connect(worker('search'))
    loader.slots.log = 'starting'
    await search.ask('core.self')
    expect(carrier.audit.next(10)).toHaveLength(1)
    loader.slots.log = 'off'
    await search.ask('core.self')
    expect(carrier.audit.next(10)).toEqual([])
  })

  it.each(['failed', 'absent', 'tampered'] as const)('counts what it held in audit.dropped when the log is %s', async state => {
    const { carrier, connect, loader, log } = harness()
    const search = connect(worker('search'))
    for (let i = 0; i < 3; i++) await search.ask('storage.set', { key: `k${i}`, value: i })
    carrier.audit.next(1)
    loader.slots.log = state
    await search.ask('core.self')
    await tick()
    expect(log.events('audit.dropped').map(record => record.fields)).toEqual([{ count: 3, why: 'log-down' }])
    loader.slots.log = 'on'
    expect(carrier.audit.next(10)).toEqual([])
  })

  it('writes audit.dropped only when the queue held something', async () => {
    const { carrier, connect, loader, log } = harness()
    loader.slots.log = 'off'
    const search = connect(worker('search'))
    await search.ask('core.self')
    await search.ask('core.self')
    await carrier.flushFloor()
    expect(log.events('audit.dropped')).toEqual([])
  })

  it('starts coalescing afresh once the log came back', async () => {
    const clock = 1_000_000
    const { carrier, connect, loader } = harness({ now: () => clock })
    const search = connect(worker('search'))
    await search.ask('core.self')
    loader.slots.log = 'failed'
    await search.ask('core.self')
    loader.slots.log = 'on'
    await search.ask('core.self')
    expect(carrier.audit.next(10).map(record => record.count)).toEqual([1])
  })

  it('coalesces refused writes and calls refused at shape', async () => {
    const clock = 1_000_000
    const { carrier, connect } = harness({ now: () => clock })
    const search = connect(worker('search'))
    for (let i = 0; i < 3; i++) await search.ask('vault.write', { path: 'a.md', text: 'x' })
    for (let i = 0; i < 3; i++) await search.ask('vault.read', { path: '' })
    expect(carrier.audit.next(10).map(record => [record.action, record.code, record.count])).toEqual([
      ['vault.write', 'not-granted', 3], ['vault.read', 'invalid', 3],
    ])
  })

  it('keeps each security request and each watchdog action one record', async () => {
    const clock = 1_000_000
    const { carrier, loader } = harness({ now: () => clock, core: async () => null })
    loader.sandboxed('search')
    const way = windowWay(carrier, { 'editor-1': editor })
    const change = { kind: 'plugin.on', plugin: 'search' }
    await way.ask('editor-1', 'security.request', { change })
    await way.ask('editor-1', 'security.request', { change })
    const watchdog = hostHalf(carrier, host('watchdog'))
    await watchdog.ask('watchdog.stop', { plugin: 'search' })
    await watchdog.ask('watchdog.stop', { plugin: 'search' })
    expect(carrier.audit.next(10).map(record => [record.action, record.count])).toEqual([
      ['security.request', 1], ['security.request', 1], ['watchdog.stop', 1], ['watchdog.stop', 1],
    ])
  })

  // A record joins only calls that share every field it names, the A-05 case of two agents behind one MCP among them
  it('keeps two agents behind one caller apart', async () => {
    const clock = 1_000_000
    const { carrier, connect, gate, vault } = harness({ now: () => clock })
    gate.grants.mcp = [{ type: 'vault.read', paths: ['**'] }]
    vault.files.set('a.md', 'x')
    const mcp = connect(worker('mcp'))
    await mcp.ask('vault.read', { path: 'a.md' }, { onBehalf: 'agent-a' })
    await mcp.ask('vault.read', { path: 'a.md' }, { onBehalf: 'agent-b' })
    expect(carrier.audit.next(10).map(record => [record.onBehalf, record.count])).toEqual([['agent-a', 1], ['agent-b', 1]])
  })

  it('keeps calls with different roots apart', async () => {
    const clock = 1_000_000
    const { carrier, http, mcp } = plugins({ now: () => clock })
    http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    await mcp.ask('core.self', undefined, { parent: parent.callId })
    await mcp.ask('core.self')
    const selves = carrier.audit.next(10).filter(record => record.action === 'core.self')
    expect(selves.map(record => [idOf(record.root), record.count])).toEqual([['http', 1], ['mcp', 1]])
  })

  it('keeps calls under different gate states apart', async () => {
    const clock = 1_000_000
    const { carrier, connect, loader } = harness({ now: () => clock })
    const search = connect(worker('search'))
    await search.ask('storage.get', { key: 'k' })
    loader.slots.gate = 'failed'
    await search.ask('storage.get', { key: 'k' })
    expect(carrier.audit.next(10).map(record => [record.gate, record.count])).toEqual([['on', 1], ['failed', 1]])
  })

  it('keeps two callers under one root apart', async () => {
    const clock = 1_000_000
    const { carrier, http, mcp, search } = plugins({ now: () => clock })
    http.call('mcp.handle')
    http.call('search.query')
    const one = await mcp.delivered('mcp.handle')
    const two = await search.delivered('search.query')
    await mcp.ask('core.self', undefined, { parent: one.callId })
    await search.ask('core.self', undefined, { parent: two.callId })
    const selves = carrier.audit.next(10).filter(record => record.action === 'core.self')
    expect(selves.map(record => [idOf(record.caller), record.count])).toEqual([['mcp', 1], ['search', 1]])
  })

  it('lets go of the record ack names, so the bound frees up', async () => {
    const { carrier, connect, loader } = harness()
    loader.human.all = { auditQueue: 2 }
    const search = connect(worker('search'))
    for (const key of ['a', 'b']) await search.ask('storage.set', { key, value: 1 })
    const taken = carrier.audit.next(2)
    carrier.audit.ack(taken[1].seq)
    for (const key of ['c', 'd']) await search.ask('storage.set', { key, value: 1 })
    expect(carrier.audit.next(10)).toHaveLength(2)
  })

  it('keeps the records the log has not taken, whatever seq ack names', async () => {
    const { carrier, connect } = harness()
    const search = connect(worker('search'))
    for (const key of ['a', 'b', 'c']) await search.ask('storage.set', { key, value: 1 })
    carrier.audit.next(1)
    carrier.audit.ack(1000)
    expect(carrier.audit.next(10)).toHaveLength(2)
  })
})

describe('the floor lane', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('writes floor records straight through the EventLog with the log plugin off', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hetu-carrier-'))
    const log = new EventLog(dir)
    await log.open()
    const { carrier, loader } = harness({ log })
    loader.slots.log = 'off'
    carrier.floor('plugin.found', { plugin: 'search' })
    carrier.floor('plugin.checked', { plugin: 'search', ok: true })
    await carrier.flushFloor()
    const lines = (await readFile(path.join(dir, 'events', 'events-1.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => [line.event, line.plugin])).toEqual([['plugin.found', 'search'], ['plugin.checked', 'search']])
  })

  it('keeps records in a backlog while the log can not write and lands them in order once an append works', async () => {
    const log = new FakeLog()
    const { carrier } = harness({ log })
    log.failing = true
    for (const plugin of ['a', 'b', 'c']) carrier.floor('plugin.found', { plugin })
    await tick()
    expect(log.records).toEqual([])
    log.failing = false
    await carrier.flushFloor()
    expect(log.records.map(record => record.fields.plugin)).toEqual(['a', 'b', 'c'])
  })

  it('bounds the backlog, counts what it dropped and writes the count once the backlog has landed', async () => {
    const log = new FakeLog()
    const { carrier, loader } = harness({ log })
    loader.human.all = { floorBacklog: 3 }
    log.failing = true
    for (const plugin of ['a', 'b', 'c', 'd', 'e']) carrier.floor('plugin.found', { plugin })
    await tick()
    log.failing = false
    await carrier.flushFloor()
    expect(log.records.map(record => [record.event, record.fields.plugin ?? record.fields.count])).toEqual([
      ['plugin.found', 'a'], ['plugin.found', 'b'], ['plugin.found', 'c'], ['floor.dropped', 2],
    ])
  })

  it('tries the backlog again on its own once the log comes back', async () => {
    const log = new FakeLog()
    const { carrier } = harness({ log, floorRetryMs: 20 })
    log.failing = true
    carrier.floor('plugin.found', { plugin: 'a' })
    await tick()
    log.failing = false
    for (let i = 0; i < 50 && log.records.length === 0; i++) await tick(5)
    expect(log.records.map(record => record.fields.plugin)).toEqual(['a'])
  })

  it('skips and counts a record a healthy log refuses, so it can not hold back the ones after it', async () => {
    const log = new FakeLog()
    const { carrier } = harness({ log })
    log.refuses.add('bad')
    carrier.floor('bad', {})
    carrier.floor('plugin.found', { plugin: 'a' })
    await carrier.flushFloor()
    await tick()
    expect(log.records.map(record => record.event)).toEqual(['plugin.found', 'floor.dropped'])
  })

  // The count's own record must not count itself, or the drain loops on microtasks and main freezes
  it('settles when a healthy log refuses the drop count too', async () => {
    const log = new FakeLog()
    log.refuses.add('bad')
    log.refuses.add('floor.dropped')
    let appends = 0
    const append = log.append.bind(log)
    log.append = async (event, fields) => {
      // Breaks a drain that would loop for good, so the test fails where it would hang
      if (++appends > 10) {
        log.healthy = false
        throw new Error('stop')
      }
      return append(event, fields)
    }
    const { carrier } = harness({ log })
    carrier.floor('bad', {})
    await carrier.flushFloor()
    expect(appends).toBe(2)
  })

  // seams.ts makes healthy optional. A log with no flag that fails is down, never one that refused the record
  it('keeps a record when a log with no health flag fails', async () => {
    let failing = true
    const records: string[] = []
    const log: FloorLog = {
      append: async event => {
        if (failing) throw new Error('down')
        records.push(event)
      },
    }
    const { carrier } = harness({ log })
    carrier.floor('plugin.found', { plugin: 'a' })
    await tick()
    failing = false
    await carrier.flushFloor()
    expect(records).toEqual(['plugin.found'])
  })

  it('keeps the floor fields as they were when written', async () => {
    const log = new FakeLog()
    log.failing = true
    const { carrier } = harness({ log })
    const fields = { plugin: 'a' }
    carrier.floor('plugin.found', fields)
    await tick()
    fields.plugin = 'b'
    log.failing = false
    await carrier.flushFloor()
    expect(log.records.map(record => record.fields)).toEqual([{ plugin: 'a' }])
  })

  it('keeps the faults of different plugins and steps apart', async () => {
    const { carrier, connect, gate, vault, log } = harness()
    gate.grants.search = [{ type: 'vault.read', paths: ['**'] }]
    let throws = true
    gate.decision = access => {
      if (throws) throw new Error('broken')
      return gate.granted(access)
    }
    vault.perform_ = () => { throw new Error('disk') }
    const search = connect(worker('search'))
    await search.ask('vault.read', { path: 'a.md' })
    throws = false
    await search.ask('vault.read', { path: 'a.md' })
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([
      { plugin: 'gate', step: 'precheck', count: 1 }, { plugin: 'vault', step: 'perform', count: 1 },
    ])
  })

  it('coalesces faults a plugin can trigger, one record per second with a count', async () => {
    const { carrier, connect, gate, log } = harness()
    gate.decision = () => { throw new Error('broken') }
    const search = connect(worker('search'))
    for (let i = 0; i < 3; i++) expect(code(await search.ask('vault.read', { path: 'a.md' }))).toBe('policy-down')
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'gate', step: 'precheck', count: 1 }])
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([
      { plugin: 'gate', step: 'precheck', count: 1 }, { plugin: 'gate', step: 'precheck', count: 2 },
    ])
  })
})

describe('record nothing', () => {
  it('writes no floor record and no audit record while the human turned recording off', async () => {
    const log = new FakeLog()
    const { carrier, connect, loader, gate } = harness({ log })
    loader.nothing = true
    gate.decision = () => { throw new Error('broken') }
    const search = connect(worker('search'))
    expect(code(await search.ask('vault.read', { path: 'a.md' }))).toBe('policy-down')
    carrier.floor('plugin.found', { plugin: 'search' })
    await carrier.flushFloor()
    carrier.close()
    await tick()
    expect(log.records).toEqual([])
    expect(carrier.audit.next(10)).toEqual([])
  })

  // A coalesced record counts what follows its first, so a count made in the gap would land once recording is back on
  it('counts no fault made while recording is off, so none lands once it is back on', async () => {
    const log = new FakeLog()
    const { carrier, connect, loader, gate } = harness({ log })
    loader.nothing = true
    gate.decision = () => { throw new Error('broken') }
    const search = connect(worker('search'))
    for (let i = 0; i < 3; i++) expect(code(await search.ask('vault.read', { path: 'a.md' }))).toBe('policy-down')
    loader.nothing = false
    carrier.close()
    await tick()
    expect(log.records).toEqual([])
  })

  it('records again once recording is back on, with nothing from the gap', async () => {
    const log = new FakeLog()
    const { carrier, connect, loader } = harness({ log })
    const search = connect(worker('search'))
    loader.nothing = true
    await search.ask('core.self')
    carrier.floor('plugin.found', { plugin: 'during' })
    loader.nothing = false
    await search.ask('storage.get', { key: 'k' })
    carrier.floor('plugin.found', { plugin: 'after' })
    await carrier.flushFloor()
    expect(carrier.audit.next(10).map(record => record.action)).toEqual(['storage.get'])
    expect(log.records.map(record => record.fields.plugin)).toEqual(['after'])
  })

  // Only the human's own switch mutes, so a loader that throws or answers something truthy keeps every record and the
  // log rule with the gate off
  it.each([
    ['throws', () => { throw new Error('no state') }],
    ['answers 1', () => 1],
  ])('keeps recording and the log rule when recordNothing %s', async (_name, nothing) => {
    const { carrier, connect, loader } = harness()
    loader.recordNothing = nothing as unknown as () => boolean
    const search = connect(worker('search'))
    await search.ask('core.self')
    expect(carrier.audit.next(10)).toHaveLength(1)
    loader.slots.gate = 'off'
    loader.slots.log = 'failed'
    expect(code(await search.ask('vault.read', { path: 'a.md' }))).toBe('policy-down')
  })
})

// The loader applies a copy, a restore or an update only once its record is on disk, so each record says where it went
describe('a floor record\'s landing', () => {
  const laneOf = (log: FloorLog, options: { bound?: number, muted?: boolean } = {}) =>
    new FloorLane(log, { bound: () => options.bound ?? 10, muted: () => options.muted ?? false, retryMs: 60_000 })

  it('settles landed once the log appended it', async () => {
    let append: () => void = () => {}
    const log: FloorLog = { append: () => new Promise<void>(resolve => { append = resolve }), healthy: true }
    let landing: Landing | 'waiting' = 'waiting'
    const written = laneOf(log).write('plugin.copied', { plugin: 'git' })
    void Promise.resolve(written).then(result => { landing = result })
    await tick()
    expect(landing).toBe('waiting')
    append()
    expect(await written).toBe('landed')
  })

  it('settles muted at once while the human turned recording off', async () => {
    const log = new FakeLog()
    expect(await laneOf(log, { muted: true }).write('plugin.copied', { plugin: 'git' })).toBe('muted')
    expect(log.records).toEqual([])
  })

  it('settles lost when the backlog is full', async () => {
    const log = new FakeLog()
    log.failing = true
    const lane = laneOf(log, { bound: 1 })
    const first = lane.write('plugin.copied', { plugin: 'git' })
    const second = lane.write('plugin.copied', { plugin: 'mcp' })
    expect(await second).toBe('lost')
    log.failing = false
    await lane.flush()
    expect(await first).toBe('landed')
  })

  it('settles lost when a healthy log refuses the record', async () => {
    const log = new FakeLog()
    log.refuses.add('plugin.copied')
    const lane = laneOf(log)
    const refused = lane.write('plugin.copied', { plugin: 'git' })
    const after = lane.write('plugin.found', { plugin: 'search' })
    expect(await refused).toBe('lost')
    expect(await after).toBe('landed')
  })

  it('settles lost for records still waiting when the lane closes', async () => {
    const log = new FakeLog()
    log.failing = true
    const lane = laneOf(log)
    const waiting = lane.write('plugin.copied', { plugin: 'git' })
    await tick()
    lane.close()
    expect(await waiting).toBe('lost')
    expect(await lane.write('plugin.copied', { plugin: 'mcp' })).toBe('lost')
  })

  // A log whose appends wait until the test settles them, healthy until the test says otherwise
  function heldLog() {
    const appends: { resolve: () => void, reject: (error: Error) => void }[] = []
    const log = {
      healthy: true,
      append: () => new Promise<void>((resolve, reject) => { appends.push({ resolve, reject }) }),
    }
    return { log, appends }
  }

  it('lands what a drain under way holds when the lane closes', async () => {
    const { log, appends } = heldLog()
    const lane = laneOf(log)
    const first = lane.write('plugin.copied', { plugin: 'git' })
    const second = lane.write('plugin.copied', { plugin: 'mcp' })
    await tick()
    lane.close()
    appends[0].resolve()
    await tick()
    appends[1].resolve()
    expect(await Promise.all([first, second])).toEqual(['landed', 'landed'])
  })

  it('settles lost for all it holds once a drain under way meets a log that went down after the close', async () => {
    const { log, appends } = heldLog()
    const lane = laneOf(log)
    const settled: Landing[] = []
    for (const plugin of ['git', 'mcp']) void Promise.resolve(lane.write('plugin.copied', { plugin })).then(result => { settled.push(result) })
    await tick()
    lane.close()
    log.healthy = false
    appends[0].reject(new Error('disk gone'))
    await tick(30)
    // Never held for a retry the closed lane would not make
    expect(settled).toEqual(['lost', 'lost'])
  })

  it('settles in the order the records were written', async () => {
    const log = new FakeLog()
    log.failing = true
    const lane = laneOf(log)
    const settled: string[] = []
    const all = ['git', 'mcp', 'search'].map(plugin => Promise.resolve(lane.write('plugin.copied', { plugin })).then(result => {
      settled.push(plugin)
      return result
    }))
    await tick()
    log.failing = false
    await lane.flush()
    expect(await Promise.all(all)).toEqual(['landed', 'landed', 'landed'])
    expect(settled).toEqual(['git', 'mcp', 'search'])
  })

  it('takes out a record its waiter gave up on while the log can\'t write, so it never lands, and keeps the rest', async () => {
    const log = new FakeLog()
    log.failing = true
    const lane = laneOf(log)
    const giveUp = new AbortController()
    const withdrawn = lane.write('plugin.updated', { plugin: 'git' }, giveUp.signal)
    const after = lane.write('plugin.found', { plugin: 'search' })
    await tick()
    giveUp.abort()
    expect(await withdrawn).toBe('lost')
    expect(lane.waiting).toBe(1)
    log.failing = false
    await lane.flush()
    expect(await after).toBe('landed')
    expect(log.records.map(record => record.event)).toEqual(['plugin.found'])
  })

  it('settles lost at once for a waiter that gave up before the write', async () => {
    const log = new FakeLog()
    const giveUp = new AbortController()
    giveUp.abort()
    expect(await laneOf(log).write('plugin.updated', { plugin: 'git' }, giveUp.signal)).toBe('lost')
    expect(log.records).toEqual([])
  })

  // An append under way can't be called back, so its record may still land after the waiter gave up
  it('lands a record already being written when its waiter gives up', async () => {
    const { log, appends } = heldLog()
    const lane = laneOf(log)
    const giveUp = new AbortController()
    const writing = lane.write('plugin.updated', { plugin: 'git' }, giveUp.signal)
    await tick()
    giveUp.abort()
    appends[0].resolve()
    expect(await writing).toBe('landed')
  })
})
