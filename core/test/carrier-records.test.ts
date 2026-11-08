import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventLog } from '../lib/event-log.ts'
import { AuditQueue, FloorLane } from '../backend/carrier/records.ts'
import type { Carrier } from '../backend/carrier/carrier.ts'
import type { CarrierOptions, CoreLog, FloorLog, Landing } from '../backend/carrier/seams.ts'
import { cleanup, code, editor, FakeLog, harness, host, hostHalf, tick, trusted, windowWay, worker } from './carrier-fakes.ts'

afterEach(cleanup)

// http reaches mcp and search, the two serving one action each
function plugins(over: Partial<CarrierOptions> = {}) {
  const parts = harness(over)
  const { loader, gate, connect } = parts
  loader.sandboxed('search', { query: {} })
  loader.sandboxed('mcp', { handle: {} })
  gate.grants.http = [{ type: 'plugin.call', targets: ['mcp', 'search'] }]
  return { ...parts, http: connect(worker('http')), mcp: connect(worker('mcp')), search: connect(worker('search')) }
}

// What the core's writer put in the log as audit.call lines, once the queue is flushed
async function written(carrier: Carrier, log: FakeLog) {
  await carrier.flush()
  return log.events('audit.call').map(record => record.fields)
}

describe('audit records', () => {
  it('writes one audit.call line per call with the caller, onBehalf, root, action, canonical scope, code and gate state, never args or results', async () => {
    const { carrier, connect, gate, loader, log } = harness()
    loader.sandboxed('mcp', { handle: {} })
    gate.grants.http = [{ type: 'plugin.call', targets: ['mcp'] }]
    gate.grants.mcp = [{ type: 'luoshu.write', paths: ['notes/**'] }]
    const http = connect(worker('http'))
    const mcp = connect(worker('mcp'))
    const id = http.call('mcp.handle', { prompt: 'secret prompt' }, { onBehalf: 'agent-a' })
    const parent = await mcp.delivered('mcp.handle')
    const write = await mcp.ask('luoshu.write', { path: 'notes/a.md', text: 'secret note text' }, { parent: parent.callId, onBehalf: 'agent-a' })
    expect(write.ok).toBe(true)
    mcp.answer(parent.callId, { said: 'secret result' })
    await http.reply(id)
    const records = await written(carrier, log)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      caller: 'mcp/worker#1', onBehalf: 'agent-a', root: 'http/worker#1', action: 'luoshu.write',
      paths: '["notes/a.md"]', pathCount: 1, code: null, gate: 'on', count: 1,
    })
    expect(records[1]).toMatchObject({ caller: 'http/worker#1', root: 'http/worker#1', action: 'mcp.handle', target: 'mcp', code: null })
    expect(typeof records[0].ms).toBe('number')
    const text = JSON.stringify(log.records)
    for (const secret of ['secret prompt', 'secret note text', 'secret result']) expect(text).not.toContain(secret)
  })

  it('records a refusal with its code and the gate\'s state', async () => {
    const { carrier, connect, loader, log } = harness()
    loader.slots.gate = 'failed'
    await connect(worker('search')).ask('luoshu.read', { path: 'a.md' })
    expect(await written(carrier, log)).toMatchObject([{ action: 'luoshu.read', code: 'policy-down', gate: 'failed', count: 1 }])
  })

  // The caller's own text is no canonical scope, so a call refused at precheck records no path
  it('records no path for a call refused before prepare and the canonical one once prepare ran', async () => {
    let clock = 1_000_000
    const { carrier, connect, gate, log } = harness({ now: () => clock })
    gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**'] }]
    const search = connect(worker('search'))
    expect(code(await search.ask('luoshu.read', { path: 'secret/a.md' }))).toBe('not-granted')
    clock += 1000
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    expect(code(await search.ask('luoshu.read', { path: 'GIT~1/config' }))).toBe('not-granted')
    const records = await written(carrier, log)
    expect(records.map(record => [record.code, record.paths])).toEqual([['not-granted', undefined], ['not-granted', '[".git/config"]']])
    expect('paths' in records[0]).toBe(false)
  })

  it('names onBehalf and the root of a live parent for a call refused before the ceiling took it', async () => {
    const { carrier, http, mcp, loader, log } = plugins()
    loader.human.plugins.http = { callsInFlight: 1 }
    http.call('mcp.handle', {}, { onBehalf: 'agent-a' })
    const parent = await mcp.delivered('mcp.handle')
    const under = { parent: parent.callId, onBehalf: 'agent-a' }
    expect(code(await mcp.ask('luoshu.read', { path: '' }, under))).toBe('invalid')
    expect(code(await mcp.ask('security.request', { change: { kind: 'plugin.on', plugin: 'search' } }, under))).toBe('not-granted')
    expect(code(await mcp.ask('core.self', undefined, under))).toBe('throttled')
    const refused = (await written(carrier, log)).filter(record => record.code !== null)
    expect(refused.map(record => [record.action, record.code, record.caller, record.root, record.onBehalf])).toEqual([
      ['luoshu.read', 'invalid', 'mcp/worker#1', 'http/worker#1', 'agent-a'],
      ['security.request', 'not-granted', 'mcp/worker#1', 'http/worker#1', 'agent-a'],
      ['core.self', 'throttled', 'mcp/worker#1', 'http/worker#1', 'agent-a'],
    ])
  })

  it('records the gate\'s state for a call without power and a state outside the list as failed', async () => {
    let clock = 1_000_000
    const { carrier, connect, loader, log } = harness({ now: () => clock })
    const search = connect(worker('search'))
    loader.slots.gate = 'failed'
    await search.ask('storage.get', { key: 'k' })
    clock += 1000
    loader.slots.gate = 'ON' as never
    await search.ask('storage.get', { key: 'k' })
    expect((await written(carrier, log)).map(record => [record.action, record.code, record.gate])).toEqual([
      ['storage.get', null, 'failed'], ['storage.get', null, 'failed'],
    ])
  })

  it('coalesces reads and refusals per caller per second, and keeps writes one record each', async () => {
    let clock = 1_000_000
    const { carrier, connect, gate, log, luoshu } = harness({ now: () => clock })
    gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'luoshu.write', paths: ['notes/**'] }]
    for (const name of ['a', 'b', 'c']) luoshu.files.set(`notes/${name}.md`, name)
    const search = connect(worker('search'))
    for (const name of ['a', 'b', 'c']) await search.ask('luoshu.read', { path: `notes/${name}.md` })
    for (let i = 0; i < 4; i++) await search.ask('luoshu.read', { path: 'secret/x.md' })
    await search.ask('luoshu.write', { path: 'notes/a.md', text: '1' })
    await search.ask('luoshu.write', { path: 'notes/a.md', text: '2' })
    await search.ask('storage.get', { key: 'index' })
    await search.ask('storage.get', { key: 'other' })
    clock += 1000
    await search.ask('luoshu.read', { path: 'notes/a.md' })
    const records = (await written(carrier, log)).map(record => [record.action, record.code, record.count])
    expect(records).toEqual([
      ['luoshu.read', null, 3],
      ['luoshu.read', 'not-granted', 4],
      ['luoshu.write', null, 1],
      ['luoshu.write', null, 1],
      ['storage.get', null, 2],
      ['luoshu.read', null, 1],
    ])
  })

  it('coalesces free calls between a plugin\'s own halves and keeps calls to other plugins one each', async () => {
    const clock = 1_000_000
    const { carrier, connect, loader, gate, log } = harness({ now: () => clock })
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
    expect((await written(carrier, log)).map(record => [record.action, record.count])).toEqual([
      ['search.query', 3], ['git.log', 1], ['git.log', 1],
    ])
  })

  it('stops coalescing into a record once the writer has taken it', async () => {
    const clock = 1_000_000
    const { carrier, connect, log } = harness({ now: () => clock })
    const search = connect(worker('search'))
    await search.ask('core.self')
    await carrier.flush()
    await search.ask('core.self')
    await search.ask('core.self')
    expect((await written(carrier, log)).map(record => record.count)).toEqual([1, 2])
  })

  // Only the interval is faked, so the ports and their timers run as they do
  it('writes the queue on its own every 100 ms, each record once and in order, as one batch', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const { connect, log } = harness({ auditEveryMs: undefined })
      const search = connect(worker('search'))
      for (let i = 0; i < 3; i++) await search.ask('storage.set', { key: `k${i}`, value: i })
      expect(log.events('audit.call')).toEqual([])
      vi.advanceTimersByTime(100)
      await tick()
      expect(log.events('audit.call').map(record => record.fields.record)).toEqual([1, 2, 3])
      expect(log.batches).toEqual([{ id: 'audit:1-3', size: 3 }])
      await search.ask('storage.set', { key: 'k3', value: 3 })
      vi.advanceTimersByTime(100)
      await tick()
      expect(log.events('audit.call').map(record => record.fields.record)).toEqual([1, 2, 3, 4])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a record past the bound, counts it in a floor record and still answers the call', async () => {
    const { carrier, connect, loader, log } = harness()
    loader.human.all = { auditQueue: 2 }
    const search = connect(worker('search'))
    for (let i = 0; i < 4; i++) expect((await search.ask('storage.set', { key: `k${i}`, value: i })).ok).toBe(true)
    expect(await written(carrier, log)).toHaveLength(2)
    carrier.close()
    await tick()
    expect(log.events('audit.dropped').map(record => record.fields)).toEqual([
      { why: 'full', count: 1 }, { why: 'full', count: 1 },
    ])
  })

  it('frees the bound once a batch is written', async () => {
    const { carrier, connect, loader, log } = harness()
    loader.human.all = { auditQueue: 2 }
    const search = connect(worker('search'))
    for (const key of ['a', 'b']) await search.ask('storage.set', { key, value: 1 })
    await carrier.flush()
    for (const key of ['c', 'd']) await search.ask('storage.set', { key, value: 1 })
    expect(await written(carrier, log)).toHaveLength(4)
    expect(log.events('audit.dropped')).toEqual([])
  })

  it('keeps a batch while the log can\'t write and writes it once, in order, when the log is back', async () => {
    const { carrier, connect, log } = harness()
    const search = connect(worker('search'))
    log.failing = true
    for (let i = 0; i < 3; i++) await search.ask('storage.set', { key: `k${i}`, value: i })
    await carrier.flush()
    expect(log.events('audit.call')).toEqual([])
    log.failing = false
    await search.ask('storage.set', { key: 'k3', value: 3 })
    expect((await written(carrier, log)).map(record => record.record)).toEqual([1, 2, 3, 4])
    expect(log.batches).toEqual([{ id: 'audit:1-3', size: 3 }, { id: 'audit:4-4', size: 1 }])
  })

  // A healthy log refused what the batch holds and trying it again would hold back every record after it
  it('lets go of a batch a healthy log refused and counts its records in audit.dropped', async () => {
    const { carrier, connect, log } = harness()
    const search = connect(worker('search'))
    log.refuses.add('audit.call')
    await search.ask('core.self')
    await search.ask('storage.get', { key: 'k' })
    await carrier.flush()
    expect(log.events('audit.call')).toEqual([])
    expect(log.events('audit.dropped').map(record => record.fields)).toEqual([{ why: 'refused', count: 2 }])
    log.refuses.clear()
    await search.ask('storage.get', { key: 'k' })
    expect((await written(carrier, log)).map(record => record.action)).toEqual(['storage.get'])
  })

  it('coalesces refused writes and calls refused at shape', async () => {
    const clock = 1_000_000
    const { carrier, connect, log } = harness({ now: () => clock })
    const search = connect(worker('search'))
    for (let i = 0; i < 3; i++) await search.ask('luoshu.write', { path: 'a.md', text: 'x' })
    for (let i = 0; i < 3; i++) await search.ask('luoshu.read', { path: '' })
    expect((await written(carrier, log)).map(record => [record.action, record.code, record.count])).toEqual([
      ['luoshu.write', 'not-granted', 3], ['luoshu.read', 'invalid', 3],
    ])
  })

  it('keeps each security request and each watchdog action one record', async () => {
    const clock = 1_000_000
    const { carrier, loader, log } = harness({ now: () => clock, core: async () => null })
    loader.sandboxed('search')
    const way = windowWay(carrier, { 'editor-1': editor })
    const change = { kind: 'plugin.on', plugin: 'search' }
    await way.ask('editor-1', 'security.request', { change })
    await way.ask('editor-1', 'security.request', { change })
    const watchdog = hostHalf(carrier, host('watchdog'))
    await watchdog.ask('watchdog.stop', { plugin: 'search' })
    await watchdog.ask('watchdog.stop', { plugin: 'search' })
    expect((await written(carrier, log)).map(record => [record.action, record.count])).toEqual([
      ['security.request', 1], ['security.request', 1], ['watchdog.stop', 1], ['watchdog.stop', 1],
    ])
  })

  // A record joins only calls that share every field it names, the A-05 case of two agents behind one MCP among them
  it('keeps two agents behind one caller apart', async () => {
    const clock = 1_000_000
    const { carrier, connect, gate, log, luoshu } = harness({ now: () => clock })
    gate.grants.mcp = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('a.md', 'x')
    const mcp = connect(worker('mcp'))
    await mcp.ask('luoshu.read', { path: 'a.md' }, { onBehalf: 'agent-a' })
    await mcp.ask('luoshu.read', { path: 'a.md' }, { onBehalf: 'agent-b' })
    expect((await written(carrier, log)).map(record => [record.onBehalf, record.count])).toEqual([['agent-a', 1], ['agent-b', 1]])
  })

  it('keeps calls with different roots apart', async () => {
    const clock = 1_000_000
    const { carrier, http, log, mcp } = plugins({ now: () => clock })
    http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    await mcp.ask('core.self', undefined, { parent: parent.callId })
    await mcp.ask('core.self')
    const selves = (await written(carrier, log)).filter(record => record.action === 'core.self')
    expect(selves.map(record => [record.root, record.count])).toEqual([['http/worker#1', 1], ['mcp/worker#1', 1]])
  })

  it('keeps calls under different gate states apart', async () => {
    const clock = 1_000_000
    const { carrier, connect, loader, log } = harness({ now: () => clock })
    const search = connect(worker('search'))
    await search.ask('storage.get', { key: 'k' })
    loader.slots.gate = 'failed'
    await search.ask('storage.get', { key: 'k' })
    expect((await written(carrier, log)).map(record => [record.gate, record.count])).toEqual([['on', 1], ['failed', 1]])
  })

  it('keeps two callers under one root apart', async () => {
    const clock = 1_000_000
    const { carrier, http, log, mcp, search } = plugins({ now: () => clock })
    http.call('mcp.handle')
    http.call('search.query')
    const one = await mcp.delivered('mcp.handle')
    const two = await search.delivered('search.query')
    await mcp.ask('core.self', undefined, { parent: one.callId })
    await search.ask('core.self', undefined, { parent: two.callId })
    const selves = (await written(carrier, log)).filter(record => record.action === 'core.self')
    expect(selves.map(record => [record.caller, record.count])).toEqual([['mcp/worker#1', 1], ['search/worker#1', 1]])
  })

  // Quit flushes, closes and flushes again, so the calls close stops still leave their records
  it('writes on the flush after close the records of the calls close stopped', async () => {
    const { carrier, http, log, mcp } = plugins()
    http.call('mcp.handle')
    await mcp.delivered('mcp.handle')
    await carrier.flush()
    carrier.stopping()
    carrier.close()
    await carrier.flush()
    expect(log.events('audit.call').map(record => [record.fields.action, record.fields.code])).toEqual([['mcp.handle', 'stopped']])
  })
})

describe('reading the log', () => {
  it('serves log.history and log.verify to every window from the log the core writes', async () => {
    const { carrier, log } = harness()
    const way = windowWay(carrier, { editor, trusted })
    expect(await way.ask('editor', 'log.history')).toMatchObject({ ok: true, result: log.segments })
    log.verification = { ok: false, seq: 7 }
    expect(await way.ask('trusted', 'log.verify')).toMatchObject({ ok: true, result: { ok: false, seq: 7 } })
  })

  // Reading the log is first-party work, which waits for the shipper
  it('refuses them to plugins, whatever the gate granted', async () => {
    const { connect, gate } = harness()
    gate.grants.search = [{ type: 'log.read' }]
    const search = connect(worker('search'))
    expect(code(await search.ask('log.history'))).toBe('not-granted')
    expect(code(await search.ask('log.verify'))).toBe('not-granted')
  })

  it('answers unavailable with no log', async () => {
    const { carrier } = harness({ log: null })
    const way = windowWay(carrier, { editor })
    expect(code(await way.ask('editor', 'log.history'))).toBe('unavailable')
  })
})

describe('the floor lane', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('writes floor records straight through the EventLog, one append each', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hetu-carrier-'))
    const log = new EventLog(dir)
    await log.open()
    const { carrier } = harness({ log })
    carrier.floor('plugin.found', { plugin: 'search' })
    carrier.floor('plugin.checked', { plugin: 'search', ok: true })
    await carrier.flush()
    const lines = (await readFile(path.join(dir, 'events', 'events-1.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => [line.event, line.plugin])).toEqual([['plugin.found', 'search'], ['plugin.checked', 'search']])
  })

  it('says once when the log stops writing and once when it writes again', async () => {
    const log = new FakeLog()
    let noticed = 0
    const lane = new FloorLane(log, { bound: () => 10, muted: () => false, retryMs: 60_000, noticed: () => { noticed++ } })
    log.failing = true
    void lane.write('plugin.found', { plugin: 'a' })
    void lane.write('plugin.found', { plugin: 'b' })
    await tick()
    expect(noticed).toBe(1)
    log.failing = false
    await lane.flush()
    expect(noticed).toBe(2)
    void lane.write('plugin.found', { plugin: 'c' })
    await lane.flush()
    expect(noticed).toBe(2)
    lane.close()
  })

  it('tells windows to read core.status again when the log stops writing and when it writes again', async () => {
    const log = new FakeLog()
    const { carrier } = harness({ log })
    const way = windowWay(carrier, { editor })
    await way.ask('editor', 'events.subscribe', { topics: ['core.status'] })
    log.failing = true
    carrier.floor('plugin.found', { plugin: 'a' })
    await tick()
    expect(way.events().map(event => event.topic)).toEqual(['core.status'])
    log.failing = false
    await carrier.flush()
    expect(way.events().map(event => event.topic)).toEqual(['core.status', 'core.status'])
  })

  it('keeps records in a backlog while the log can not write and lands them in order once an append works', async () => {
    const log = new FakeLog()
    const { carrier } = harness({ log })
    log.failing = true
    for (const plugin of ['a', 'b', 'c']) carrier.floor('plugin.found', { plugin })
    await tick()
    expect(log.records).toEqual([])
    log.failing = false
    await carrier.flush()
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
    await carrier.flush()
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
    await carrier.flush()
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
    await carrier.flush()
    expect(appends).toBe(2)
  })

  // seams.ts makes healthy optional. A log with no flag that fails is down, never one that refused the record
  it('keeps a record when a log with no health flag fails', async () => {
    let failing = true
    const records: string[] = []
    const log: CoreLog = {
      append: async event => {
        if (failing) throw new Error('down')
        records.push(event)
      },
      appendMany: async () => {},
      history: async () => [],
      verify: async () => ({ ok: true }),
    }
    const { carrier } = harness({ log })
    carrier.floor('plugin.found', { plugin: 'a' })
    await tick()
    failing = false
    await carrier.flush()
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
    await carrier.flush()
    expect(log.records.map(record => record.fields)).toEqual([{ plugin: 'a' }])
  })

  it('keeps the faults of different plugins and steps apart', async () => {
    const { carrier, connect, gate, luoshu, log } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    let throws = true
    gate.decision = access => {
      if (throws) throw new Error('broken')
      return gate.granted(access)
    }
    luoshu.perform_ = () => { throw new Error('disk') }
    const search = connect(worker('search'))
    await search.ask('luoshu.read', { path: 'a.md' })
    throws = false
    await search.ask('luoshu.read', { path: 'a.md' })
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([
      { plugin: 'gate', step: 'precheck', count: 1 }, { plugin: 'luoshu', step: 'perform', count: 1 },
    ])
  })

  it('coalesces faults a plugin can trigger, one record per second with a count', async () => {
    const { carrier, connect, gate, log } = harness()
    gate.decision = () => { throw new Error('broken') }
    const search = connect(worker('search'))
    for (let i = 0; i < 3; i++) expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
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
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    carrier.floor('plugin.found', { plugin: 'search' })
    await carrier.flush()
    carrier.close()
    await carrier.flush()
    expect(log.records).toEqual([])
  })

  // A coalesced record counts what follows its first, so a count made in the gap would land once recording is back on
  it('counts no fault made while recording is off, so none lands once it is back on', async () => {
    const log = new FakeLog()
    const { carrier, connect, loader, gate } = harness({ log })
    loader.nothing = true
    gate.decision = () => { throw new Error('broken') }
    const search = connect(worker('search'))
    for (let i = 0; i < 3; i++) expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    loader.nothing = false
    carrier.close()
    await tick()
    expect(log.events('fault')).toEqual([])
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
    await carrier.flush()
    expect(log.events('audit.call').map(record => record.fields.action)).toEqual(['storage.get'])
    expect(log.events('plugin.found').map(record => record.fields.plugin)).toEqual(['after'])
  })

  // Only the human's own switch mutes, so a loader that throws or answers something truthy keeps every record and the
  // log rule with the gate off
  it.each([
    ['throws', () => { throw new Error('no state') }],
    ['answers 1', () => 1],
  ])('keeps recording and the log rule when recordNothing %s', async (_name, nothing) => {
    let now = 0
    const { carrier, connect, loader, log } = harness({ clock: () => now })
    loader.recordNothing = nothing as unknown as () => boolean
    const search = connect(worker('search'))
    await search.ask('core.self')
    await carrier.flush()
    expect(log.events('audit.call')).toHaveLength(1)
    loader.slots.gate = 'off'
    await search.ask('core.self')
    now = 30_000
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
  })
})

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

  it('takes out a record its waiter gave up on during an append that then failed, so it never lands on a retry', async () => {
    const { log, appends } = heldLog()
    const lane = laneOf(log)
    const giveUp = new AbortController()
    let settled: Landing | null = null
    void Promise.resolve(lane.write('plugin.updated', { plugin: 'git' }, giveUp.signal)).then(landing => { settled = landing })
    await tick()
    giveUp.abort()
    log.healthy = false
    appends[0].reject(new Error('locked'))
    await tick()
    expect(settled).toBe('lost')
    expect(lane.waiting).toBe(0)
    log.healthy = true
    await lane.flush()
    expect(appends).toHaveLength(1)
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

describe('a failing log', () => {
  // A carrier on a clock the test moves, since the wait is timed on the carrier's own clock, with a log that can't write
  function failing(over: Partial<CarrierOptions> = {}) {
    let now = 0
    const parts = harness({ clock: () => now, ...over })
    parts.log.failing = true
    return { ...parts, at: (ms: number) => { now = ms } }
  }

  // Allow all, still logged: with the gate off a call with power passes only while its record can still land
  it('refuses a call with power with the gate off once the oldest record waited 30 s unwritten', async () => {
    const { at, connect, loader } = failing()
    loader.slots.gate = 'off'
    const search = connect(worker('search'))
    // Past the gate to the provider, which holds no such note
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('not-found')
    at(29_999)
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('not-found')
    at(30_000)
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('policy-down')
  })

  it('lets them pass again once the records are written', async () => {
    const { at, carrier, connect, loader, log } = failing()
    loader.slots.gate = 'off'
    const search = connect(worker('search'))
    await search.ask('luoshu.read', { path: 'notes/a.md' })
    at(30_000)
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('policy-down')
    log.failing = false
    await carrier.flush()
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('not-found')
  })

  it('starts the wait again from the oldest record still held once a batch is written', async () => {
    const { at, carrier, connect, loader, log } = failing()
    log.failing = false
    loader.slots.gate = 'off'
    const search = connect(worker('search'))
    await search.ask('storage.set', { key: 'a', value: 1 })
    at(20_000)
    await carrier.flush()
    at(25_000)
    await search.ask('storage.set', { key: 'b', value: 2 })
    at(54_999)
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('not-found')
    at(55_000)
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('policy-down')
  })

  // The human's switches: gate off and recording off pass calls with power unrecorded
  it('passes calls with power with the gate and recording off, however long the log has failed', async () => {
    const { at, connect, loader } = failing()
    loader.slots.gate = 'off'
    const search = connect(worker('search'))
    await search.ask('storage.set', { key: 'a', value: 1 })
    at(40_000)
    loader.nothing = true
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('not-found')
  })

  // Step 14 turns a log that fails into a quit. Until then the gate on decides as it did
  it('leaves the gate on deciding while the log fails', async () => {
    const { at, connect, gate, luoshu } = failing()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('a.md', 'x')
    const search = connect(worker('search'))
    await search.ask('storage.set', { key: 'a', value: 1 })
    at(40_000)
    expect((await search.ask('luoshu.read', { path: 'a.md' })).ok).toBe(true)
  })

  // Step 14: a log that fails stops hetu. The carrier tells the loader once, the loader quits and starts hetu again
  it('tells the loader once that the log failed, with the gate on as with it off', async () => {
    const told: number[] = []
    const { at, connect } = failing({ logFailed: () => { told.push(1) } })
    const search = connect(worker('search'))
    await search.ask('storage.set', { key: 'a', value: 1 })
    at(29_999)
    await search.ask('storage.set', { key: 'b', value: 2 })
    expect(told).toEqual([])
    at(30_000)
    await search.ask('storage.set', { key: 'c', value: 3 })
    await search.ask('storage.set', { key: 'd', value: 4 })
    expect(told).toEqual([1])
  })

  it('tells nothing while the human turned recording off', async () => {
    const told: number[] = []
    const { at, connect, loader } = failing({ logFailed: () => { told.push(1) } })
    const search = connect(worker('search'))
    await search.ask('storage.set', { key: 'a', value: 1 })
    loader.nothing = true
    at(40_000)
    await search.ask('storage.set', { key: 'b', value: 2 })
    expect(told).toEqual([])
  })

  it('takes the wait from logFailMs, which the human may set for all', async () => {
    const { at, connect, loader } = failing()
    loader.human.all = { logFailMs: 1000 }
    loader.slots.gate = 'off'
    const search = connect(worker('search'))
    await search.ask('storage.set', { key: 'a', value: 1 })
    at(1000)
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('policy-down')
  })

  it('times a record from when it was queued, not from when its call started', () => {
    let now = 40_000
    const queue = new AuditQueue(() => 10, () => now)
    queue.push({ at: 0, caller: worker('search'), root: worker('search'), action: 'a.b', code: null, ms: 40_000, gate: 'on' }, false, 0)
    expect(queue.oldest()).toBe(40_000)
    now = 41_000
    queue.ack(queue.next(1)[0].seq)
    expect(queue.oldest()).toBe(null)
  })

  it('tells windows to read core.status again when the log\'s health changes through a write the floor lane didn\'t make', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const log = new FakeLog()
      const { carrier } = harness({ log })
      const way = windowWay(carrier, { editor })
      await way.ask('editor', 'events.subscribe', { topics: ['core.status'] })
      vi.advanceTimersByTime(1000)
      expect(way.events()).toEqual([])
      log.healthy = false
      vi.advanceTimersByTime(1000)
      await tick()
      expect(way.events().map(event => event.topic)).toEqual(['core.status'])
      vi.advanceTimersByTime(1000)
      await tick()
      expect(way.events()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Record nothing's own record is the last one (S4-5): the loader drains what waits before it writes that record, and
// what still waits once recording is off is let go, counted in that record
describe('recording going off', () => {
  it('drains the audit queue and the floor backlog and says nothing still waits', async () => {
    const log = new FakeLog()
    const { carrier, connect } = harness({ log, auditEveryMs: 60_000 })
    const search = connect(worker('search'))
    await search.ask('storage.get', { key: 'k' })
    carrier.floor('plugin.found', { plugin: 'alpha' })
    expect(await carrier.drain(1000)).toBe(0)
    expect(log.events('audit.call')).toHaveLength(1)
    expect(log.events('plugin.found')).toHaveLength(1)
  })

  it('stops waiting at its deadline and counts what still waits on a log that can\'t write', async () => {
    const log = new FakeLog()
    const { carrier, connect } = harness({ log, auditEveryMs: 60_000 })
    const search = connect(worker('search'))
    log.failing = true
    await search.ask('storage.get', { key: 'k' })
    await search.ask('storage.set', { key: 'k', value: 1 })
    carrier.floor('plugin.found', { plugin: 'alpha' })
    const started = performance.now()
    expect(await carrier.drain(50)).toBe(3)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('lets go of audit records still queued once recording is off, so none lands after the switch', async () => {
    const log = new FakeLog()
    const { carrier, connect, loader } = harness({ log, auditEveryMs: 60_000 })
    const search = connect(worker('search'))
    await search.ask('storage.get', { key: 'k' })
    loader.nothing = true
    await carrier.flush()
    loader.nothing = false
    await carrier.flush()
    expect(log.events('audit.call')).toEqual([])
  })
})
