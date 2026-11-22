import { afterEach, describe, expect, it } from 'vitest'
import type { Recording } from '../backend/recording/header.ts'
import { cleanup, code, editor, type FakeLog, harness, host, hostHalf, trusted, windowWay, worker } from './router-fakes.ts'

afterEach(cleanup)

// The door's utility half and a plugin holding door.handle, which declares no action of its own
function door(over: Parameters<typeof harness>[0] = {}) {
  const parts = harness(over)
  const { pluginsManager, connect } = parts
  pluginsManager.utility('mcp-http-handler')
  pluginsManager.sandboxed('mcp')
  pluginsManager.roles['door.handle'] = 'mcp'
  return { ...parts, http: connect(host('mcp-http-handler')), mcp: connect(worker('mcp')) }
}

const request = { body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers: { 'mcp-protocol-version': '2026-07-28' } }
// The label the door names on every call
const as = { onBehalf: 'claude-code#1' }

async function written(recording: Recording, log: FakeLog) {
  await recording.flush()
  return log.events('audit.call').map(record => record.fields)
}

describe('door.handle', () => {
  it('reaches the plugin the table names as its own action, with the caller and onBehalf, and hands its answer back', async () => {
    const { http, mcp } = door()
    const id = http.call('door.handle', request, { onBehalf: 'claude-code#1' })
    const delivered = await mcp.delivered('door.handle')
    expect(delivered).toMatchObject({
      action: 'door.handle', args: request, onBehalf: 'claude-code#1',
      caller: host('mcp-http-handler'), root: host('mcp-http-handler'),
    })
    mcp.answer(delivered.callId, { status: 200, body: '{}' })
    expect(await http.reply(id)).toMatchObject({ ok: true, result: { status: 200, body: '{}' } })
  })

  it('answers unavailable while no plugin holds the role', async () => {
    const { http, pluginsManager, mcp } = door()
    delete pluginsManager.roles['door.handle']
    expect(code(await http.ask('door.handle', request, as))).toBe('unavailable')
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it.each([
    ['starting', 'starting'],
    ['unresponsive', 'timeout'],
    ['off', 'unavailable'],
    ['crashed', 'unavailable'],
  ] as const)('answers a holder that is %s with %s', async (state, answer) => {
    const { http, pluginsManager } = door()
    pluginsManager.sandboxed('mcp', {}, state)
    expect(code(await http.ask('door.handle', request, as))).toBe(answer)
  })

  it('answers unavailable when the table names a plugin it has no row for, or its way is gone', async () => {
    const { http, pluginsManager } = door()
    pluginsManager.roles['door.handle'] = 'ghost'
    expect(code(await http.ask('door.handle', request, as))).toBe('unavailable')
    pluginsManager.sandboxed('quiet')
    pluginsManager.roles['door.handle'] = 'quiet'
    expect(code(await http.ask('door.handle', request, as))).toBe('unavailable')
  })

  // The floor decides who calls it, as for a core action, so a grant names no way in
  it('refuses every caller but a utility half, whatever it holds', async () => {
    const { connect, gate, pluginsManager, router, mcp } = door()
    gate.grants.search = [{ type: 'plugin.call', targets: ['mcp'] }, { type: 'door.handle' }]
    pluginsManager.sandboxed('search')
    expect(code(await connect(worker('search')).ask('door.handle', request, as))).toBe('not-granted')
    // The holder itself, which would answer its own call
    expect(code(await mcp.ask('door.handle', request, as))).toBe('not-granted')
    // A host half on a handle in main is no utility half
    pluginsManager.installed('watcher')
    expect(code(await hostHalf(router, host('watcher')).ask('door.handle', request, as))).toBe('not-granted')
    const windows = windowWay(router, { editor, trusted })
    expect(code(await windows.ask('editor', 'door.handle', request, as))).toBe('not-granted')
    expect(code(await windows.ask('trusted', 'door.handle', request, as))).toBe('not-granted')
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  // With no label the holder's calls under it would carry no pair and be judged on its own items alone
  it('refuses a call naming no onBehalf as invalid before anything is asked', async () => {
    const { http, gate, mcp } = door()
    expect(code(await http.ask('door.handle', request))).toBe('invalid')
    expect(gate.asked).toEqual([])
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('refuses arguments outside the contract as invalid before anything is asked', async () => {
    const { http, gate, mcp } = door()
    expect(code(await http.ask('door.handle', { body: 1, headers: {} }, as))).toBe('invalid')
    expect(code(await http.ask('door.handle', { ...request, extra: true }, as))).toBe('invalid')
    expect(code(await http.ask('door.handle.other', request, as))).toBe('invalid')
    expect(code(await http.ask('door.other', request, as))).toBe('invalid')
    expect(gate.asked).toEqual([])
    expect(mcp.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  // No gate step judges the door's call, so a gate that is down or switched off changes nothing for it. What the
  // holder does under it is judged as any call is
  it.each(['on', 'off', 'failed', 'starting'] as const)('asks the gate nothing about the call with the gate %s', async state => {
    const { http, mcp, gate, pluginsManager } = door()
    pluginsManager.policyJobs.gate = state
    const id = http.call('door.handle', request, { onBehalf: 'claude-code#1' })
    const delivered = await mcp.delivered('door.handle')
    expect(gate.asked).toEqual([])
    mcp.answer(delivered.callId, { status: 202, body: null })
    expect((await http.reply(id)).ok).toBe(true)
  })

  it('judges the holder\'s calls under it for the pair the door named, beside the holder\'s own items', async () => {
    const { http, mcp, gate, luoshu } = door()
    gate.grants.mcp = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('notes/a.md', 'text')
    const id = http.call('door.handle', request, { onBehalf: 'claude-code#1' })
    const delivered = await mcp.delivered('door.handle')
    await mcp.ask('luoshu.read', { path: 'notes/a.md' }, { parent: delivered.callId })
    expect(gate.asked.map(access => [access.caller, access.pair, access.onBehalf])).toContainEqual([
      worker('mcp'), { plugin: 'mcp-http-handler', field: 'claude-code' }, 'claude-code#1',
    ])
    mcp.answer(delivered.callId, { status: 200, body: '' })
    await http.reply(id)
  })

  it('passes on a refusal the holder may give and fails one it may not', async () => {
    const { http, mcp } = door()
    const first = http.call('door.handle', request, as)
    const one = await mcp.delivered('door.handle')
    mcp.post({ v: 1, kind: 'reply', callId: one.callId, ok: false, refusal: { code: 'not-found', action: 'door.handle' } })
    expect(code(await http.reply(first))).toBe('not-found')
    const second = http.call('door.handle', request, as)
    const two = await mcp.waitFor(message => message.kind === 'call' && message.callId !== one.callId)
    mcp.post({ v: 1, kind: 'reply', callId: two.callId, ok: false, refusal: { code: 'policy-down', action: 'door.handle' } })
    expect(code(await http.reply(second))).toBe('failed')
  })

  it('records one audit line for the call, naming the holder as its target and never the request', async () => {
    const { http, mcp, recording, log } = door()
    const id = http.call('door.handle', { body: 'secret request', headers: {} }, { onBehalf: 'claude-code#1' })
    const delivered = await mcp.delivered('door.handle')
    mcp.answer(delivered.callId, { status: 200, body: 'secret answer' })
    await http.reply(id)
    expect(await written(recording, log)).toMatchObject([
      { caller: 'mcp-http-handler/host#1', onBehalf: 'claude-code#1', action: 'door.handle', target: 'mcp', code: null, count: 1 },
    ])
    const text = JSON.stringify(log.records)
    for (const secret of ['secret request', 'secret answer']) expect(text).not.toContain(secret)
  })

  // As a narrowed grant stops what follows (D-606): the holder hears the cancel and the door stale, gate on or off
  it.each(['on', 'off'] as const)('ends an open call stale with its sub-calls once the table names another holder or none, gate %s', async state => {
    const { http, mcp, router, pluginsManager, gate, luoshu } = door()
    pluginsManager.policyJobs.gate = state
    gate.grants.mcp = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('notes/a.md', 'text')
    // The first grants snapshot the router reads, so the change below moves the holder and no grants snapshot
    router.changed()
    const id = http.call('door.handle', request, { onBehalf: 'claude-code#1' })
    const delivered = await mcp.delivered('door.handle')
    let letGo = () => {}
    luoshu.hold = { prepare: new Promise<void>(resolve => { letGo = resolve }) }
    const read = mcp.call('luoshu.read', { path: 'notes/a.md' }, { parent: delivered.callId })
    await new Promise(resolve => setTimeout(resolve, 20))
    delete pluginsManager.roles['door.handle']
    router.changed()
    expect(code(await http.reply(id))).toBe('stale')
    expect(code(await mcp.reply(read))).toBe('stale')
    await mcp.waitFor(message => message.kind === 'cancel' && message.callId === delivered.callId)
    // A second call finds no holder
    expect(code(await http.ask('door.handle', request, as))).toBe('unavailable')
    letGo()
  })

  it('leaves an open call running while the table still names its holder', async () => {
    const { http, mcp, router, pluginsManager } = door()
    const id = http.call('door.handle', request, as)
    const delivered = await mcp.delivered('door.handle')
    pluginsManager.current++
    router.changed()
    router.changed()
    mcp.answer(delivered.callId, { status: 200, body: '' })
    expect((await http.reply(id)).ok).toBe(true)
  })

  it('ends an open call stale once the table throws, fail-safe', async () => {
    const { http, mcp, router, pluginsManager } = door()
    router.changed()
    const id = http.call('door.handle', request, as)
    await mcp.delivered('door.handle')
    pluginsManager.role = () => { throw new Error('table down') }
    router.changed()
    expect(code(await http.reply(id))).toBe('stale')
  })

  it('answers unavailable when the table throws, as for a plugin it can\'t read', async () => {
    const { http, pluginsManager } = door()
    pluginsManager.role = () => { throw new Error('table down') }
    expect(code(await http.ask('door.handle', request, as))).toBe('unavailable')
  })
})
