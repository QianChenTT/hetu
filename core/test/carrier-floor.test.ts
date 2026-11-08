import { afterEach, describe, expect, it } from 'vitest'
import type { Call } from '../api/slots.ts'
import { cleanup, code, editor, harness, host, hostHalf, tick, trusted, windowWay, worker } from './carrier-fakes.ts'

afterEach(cleanup)

const MiB = 1024 * 1024

describe('shape', () => {
  it.each([
    ['an unknown field', { chain: [] }],
    ['an onBehalf with a control character', { onBehalf: 'agent\nadmin' }],
    ['a parent outside the token grammar', { parent: 'a b' }],
  ])('answers %s invalid with the caller\'s own id', async (_name, extra) => {
    const { connect, gate } = harness()
    const search = connect(worker('search'))
    const reply = await search.ask('luoshu.read', { path: 'a.md' }, extra)
    expect(reply.refusal).toEqual({ code: 'invalid', action: 'luoshu.read' })
    expect(gate.asked).toEqual([])
  })

  it('never echoes an action outside the grammar', async () => {
    const { connect } = harness()
    const search = connect(worker('search'))
    const reply = await search.ask('Luoshu.read\u202e', {})
    expect(reply.refusal).toEqual({ code: 'invalid', action: '' })
  })

  it.each([
    ['a core action with no schema', 'core.load', undefined],
    ['a plugin namespace action', 'plugin.call', { target: 'search' }],
    ['a provider action with no schema', 'luoshu.frobnicate', { path: 'a.md' }],
    ['a provider with no actions yet', 'history.read', { paths: ['a.md'] }],
    ['a provider action with a field outside its schema', 'luoshu.read', { path: 'a.md', follow: true }],
    ['a provider action with a field missing', 'luoshu.write', { path: 'a.md' }],
    ['a storage key outside the grammar', 'storage.get', { key: '../other/key' }],
  ])('refuses %s invalid', async (_name, action, args) => {
    const { connect, gate, luoshu } = harness()
    const search = connect(worker('search'))
    expect(code(await search.ask(action, args))).toBe('invalid')
    expect(gate.asked).toEqual([])
    expect(luoshu.prepared).toEqual([])
  })

  // A bad spelling answers invalid before precheck, so a caller holding the grant can tell it from a missing grant
  it.each([
    ['a backslash', 'secret\\a.md'],
    ['a colon', 'notes/a:b.md'],
    ['a control character', `notes/a${String.fromCharCode(7)}.md`],
    ['an empty segment', 'notes//a.md'],
    ['a dot segment', 'notes/../secret/a.md'],
    ['a leading slash', '/notes/a.md'],
    ['a drive letter', 'C:/notes/a.md'],
    ['a lone surrogate', `notes/${String.fromCharCode(0xd800)}.md`],
  ])('answers a path with %s invalid before precheck, a grant to every path held', async (_name, path) => {
    const { connect, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'luoshu.write', paths: ['**'] }]
    const search = connect(worker('search'))
    expect((await search.ask('luoshu.read', { path })).refusal).toEqual({ code: 'invalid', action: 'luoshu.read' })
    expect(code(await search.ask('luoshu.write', { path, text: 'x' }))).toBe('invalid')
    expect(code(await search.ask('leases.acquire', { paths: ['notes/a.md', path] }))).toBe('invalid')
    expect(gate.asked).toEqual([])
    expect(luoshu.prepared).toEqual([])
  })

  it('refuses a second call under an id still in flight', async () => {
    const { connect, loader, gate } = harness()
    loader.sandboxed('git', { log: {} })
    gate.grants.search = [{ type: 'plugin.call', targets: ['git'] }]
    const search = connect(worker('search'))
    const git = connect(worker('git'))
    search.post({ v: 1, kind: 'call', id: 7, action: 'git.log', args: {} })
    await git.delivered('git.log')
    // args and all, since the envelope refuses a call with no args key before the id is looked at
    search.post({ v: 1, kind: 'call', id: 7, action: 'core.self', args: {} })
    expect(code(await search.reply(7))).toBe('invalid')
  })

  it('takes an id again once its call was answered', async () => {
    const { connect } = harness()
    const search = connect(worker('search'))
    search.post({ v: 1, kind: 'call', id: 7, action: 'core.self', args: {} })
    await search.reply(7)
    search.post({ v: 1, kind: 'call', id: 7, action: 'core.self', args: {} })
    await tick(20)
    expect(search.repliesTo(7).map(reply => reply.ok)).toEqual([true, true])
  })

  it('answers a call refused at shape under id 0', async () => {
    const { connect } = harness()
    const search = connect(worker('search'))
    search.post({ v: 1, kind: 'call', id: 0, action: 'luoshu.read', args: { path: 'a.md' }, chain: [] })
    expect(code(await search.reply(0))).toBe('invalid')
  })

  it('measures args against the caller\'s own cap, raised by the human and lowered by the watchdog', async () => {
    const { carrier, connect, loader } = harness()
    loader.sandboxed('search')
    const search = connect(worker('search'))
    const big = 'x'.repeat(MiB + 10)
    expect((await search.ask('storage.set', { key: 'index', value: big })).refusal).toEqual({ code: 'invalid', action: 'storage.set', reason: 'too-large' })
    loader.human.plugins.search = { argumentBytes: 2 * MiB }
    expect((await search.ask('storage.set', { key: 'index', value: big })).ok).toBe(true)
    // Another plugin keeps the floor's cap
    expect(code(await connect(worker('git')).ask('storage.set', { key: 'index', value: big }))).toBe('invalid')
    const watchdog = hostHalf(carrier, host('watchdog'))
    expect((await watchdog.ask('watchdog.limit', { plugin: 'search', constant: 'argumentBytes', value: 100 })).ok).toBe(true)
    expect((await search.ask('storage.set', { key: 'index', value: 'y'.repeat(200) })).refusal).toMatchObject({ reason: 'too-large' })
  })
})

describe('the floor', () => {
  // The roadmap's proof for step 14: no plugin reaches security.* or the window lifecycle actions, whatever the gate
  const securityActions = [
    ['security.request', { change: { kind: 'plugin.on', plugin: 'search' } }],
    ['security.confirm', { requestId: 'req-1' }],
    ['security.cancel', { requestId: 'req-1' }],
    ['security.open', undefined],
    ['security.list', undefined],
    ['core.stop', { plugin: 'search' }],
    ['core.restart', { plugin: 'search' }],
    ['core.quit', undefined],
    ['core.relaunch', undefined],
  ] as const

  it.each(securityActions)('refuses %s for every plugin, MCP and host halves included, in every gate state, without asking the gate', async (action, args) => {
    const seen: Call[] = []
    const { carrier, connect, gate, loader } = harness({ core: async call => { seen.push(call); return null }, armed: () => true })
    const plugins = [
      ...['mcp', 'search', 'gate'].map(id => connect(worker(id))),
      ...['luoshu', 'gate', 'watchdog'].map(id => hostHalf(carrier, host(id))),
    ]
    for (const state of ['on', 'off', 'starting', 'failed', 'absent', 'tampered'] as const) {
      loader.slots.gate = state
      for (const plugin of plugins) expect(code(await plugin.ask(action, args))).toBe('not-granted')
    }
    expect(seen).toEqual([])
    expect(gate.asked).toEqual([])
  })

  it('takes the window lifecycle actions from the windows the core table names', async () => {
    const seen: string[] = []
    const { carrier } = harness({ core: async call => { seen.push(`${call.caller.kind === 'window' ? call.caller.role : '?'} ${call.action}`); return null }, armed: () => true })
    const way = windowWay(carrier, { 'editor-1': editor, trusted })
    for (const [action, args] of securityActions) {
      for (const sender of ['editor-1', 'trusted']) await way.ask(sender, action, args)
    }
    expect(seen).toEqual([
      'editor security.request', 'trusted security.request', 'trusted security.confirm', 'trusted security.cancel',
      'editor security.open', 'trusted security.open', 'trusted security.list', 'trusted core.stop',
      'editor core.restart', 'trusted core.restart', 'editor core.quit', 'trusted core.quit', 'trusted core.relaunch',
    ])
  })

  // The input delay: a Confirm that arrives before the trusted window armed counts for nothing, whatever the page did
  it('refuses a Confirm from the trusted window before it armed, and takes one after', async () => {
    const seen: Call[] = []
    let armed = false
    const { carrier } = harness({ core: async call => { seen.push(call); return null }, armed: caller => caller.kind === 'window' && armed })
    const way = windowWay(carrier, { trusted })
    expect(code(await way.ask('trusted', 'security.confirm', { requestId: 'req-1' }))).toBe('throttled')
    expect(seen).toEqual([])
    armed = true
    expect((await way.ask('trusted', 'security.confirm', { requestId: 'req-1' })).ok).toBe(true)
    expect(seen.map(call => call.action)).toEqual(['security.confirm'])
  })

  it('refuses every Confirm when nothing says the trusted window armed', async () => {
    const { carrier } = harness({ core: async () => null })
    const way = windowWay(carrier, { trusted })
    expect(code(await way.ask('trusted', 'security.confirm', { requestId: 'req-1' }))).toBe('throttled')
  })

  it('takes security.request from any window and security.confirm only from the trusted one, with the gate failed', async () => {
    const seen: Call[] = []
    const { carrier, loader, gate } = harness({ core: async call => { seen.push(call); return { held: true } }, armed: () => true })
    loader.slots.gate = 'failed'
    const way = windowWay(carrier, { 'editor-1': editor, trusted })
    const change = { kind: 'plugin.on', plugin: 'search' }
    expect((await way.ask('editor-1', 'security.request', { change })).result).toEqual({ held: true })
    expect((await way.ask('trusted', 'security.request', { change })).ok).toBe(true)
    expect(code(await way.ask('editor-1', 'security.confirm', { requestId: 'req-1' }))).toBe('not-granted')
    expect((await way.ask('trusted', 'security.confirm', { requestId: 'req-1' })).ok).toBe(true)
    expect(seen.map(call => [call.caller, call.action])).toEqual([
      [editor, 'security.request'], [trusted, 'security.request'], [trusted, 'security.confirm'],
    ])
    expect(seen[2].args).toEqual({ requestId: 'req-1' })
    expect(gate.asked).toEqual([])
  })

  it('answers a core action no later part serves yet unavailable', async () => {
    const { carrier } = harness()
    const way = windowWay(carrier, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'security.request', { change: { kind: 'plugin.on', plugin: 'search' } }))).toBe('unavailable')
  })

  it('fails a result from a part the core serves that is not plain data', async () => {
    const { carrier } = harness({ core: async () => ({ when: new Date(0) }) })
    const way = windowWay(carrier, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'security.request', { change: { kind: 'plugin.on', plugin: 'search' } }))).toBe('failed')
  })

  it('takes watchdog.* only from the watchdog\'s own handle, only on sandboxed plugins with no role', async () => {
    const seen: Call[] = []
    const { carrier, connect, loader, gate } = harness({
      core: async call => { seen.push(call); return null },
      guardsFor: () => ['guarding'],
    })
    loader.sandboxed('search')
    loader.sandboxed('guarding')
    // A slot id never names a sandboxed plugin, but the floor doesn't rely on that
    loader.sandboxed('capabilities')
    loader.installed('watchdog')
    const watchdog = hostHalf(carrier, host('watchdog'))
    expect((await watchdog.ask('watchdog.stop', { plugin: 'search' })).ok).toBe(true)
    expect((await watchdog.ask('watchdog.restart', { plugin: 'search' })).ok).toBe(true)
    for (const plugin of ['luoshu', 'gate', 'log', 'capabilities', 'guarding', 'ghost']) {
      expect(code(await watchdog.ask('watchdog.stop', { plugin }))).toBe('not-granted')
    }
    // The watchdog's id on a port, or on a worker half, is not the slot's holder
    expect(code(await connect(host('watchdog', 2)).ask('watchdog.stop', { plugin: 'search' }))).toBe('not-granted')
    expect(code(await hostHalf(carrier, worker('watchdog')).ask('watchdog.stop', { plugin: 'search' }))).toBe('not-granted')
    expect(code(await connect(worker('search')).ask('watchdog.stop', { plugin: 'search' }))).toBe('not-granted')
    const way = windowWay(carrier, { trusted })
    expect(code(await way.ask('trusted', 'watchdog.stop', { plugin: 'search' }))).toBe('not-granted')
    expect(seen.map(call => call.action)).toEqual(['watchdog.stop', 'watchdog.restart'])
    expect(gate.asked).toEqual([])
  })

  it('takes watchdog.* from no other plugin\'s host handle', async () => {
    const seen: Call[] = []
    const { carrier, loader } = harness({ core: async call => { seen.push(call); return null } })
    loader.sandboxed('search')
    for (const id of ['luoshu', 'history', 'exec']) {
      expect(code(await hostHalf(carrier, host(id)).ask('watchdog.stop', { plugin: 'search' }))).toBe('not-granted')
    }
    expect(seen).toEqual([])
  })

  // Starting, failed, absent and tampered act as off and off makes no restarts. The handle can outlive the slot,
  // minted before start and kept through a stop grace
  it.each(['off', 'starting', 'failed', 'absent', 'tampered'] as const)('takes no watchdog.* from the watchdog\'s handle while its slot is %s', async state => {
    const seen: Call[] = []
    const { carrier, connect, loader } = harness({ core: async call => { seen.push(call); return null } })
    loader.slots.gate = 'off'
    loader.slots.watchdog = state
    loader.sandboxed('search')
    loader.sandboxed('git', { log: {} })
    const watchdog = hostHalf(carrier, host('watchdog'))
    expect(code(await watchdog.ask('watchdog.stop', { plugin: 'search' }))).toBe('not-granted')
    expect(code(await watchdog.ask('watchdog.restart', { plugin: 'search' }))).toBe('not-granted')
    expect(code(await watchdog.ask('watchdog.limit', { plugin: 'search', constant: 'callsInFlight', value: 1 }))).toBe('not-granted')
    expect(seen).toEqual([])
    // The lowering never took, so search still has room for a second call
    const search = connect(worker('search'))
    connect(worker('git'))
    search.call('git.log')
    await tick(10)
    expect((await search.ask('core.self')).ok).toBe(true)
  })

  it('treats a plugin whose state is outside the list as absent', async () => {
    const seen: Call[] = []
    const { carrier, loader } = harness({ core: async call => { seen.push(call); return null } })
    loader.plugins.search = { state: 'READY' as never, place: 'sandboxed', incarnation: 1, serves: 'worker', actions: {}, topics: [] }
    expect(code(await hostHalf(carrier, host('watchdog')).ask('watchdog.stop', { plugin: 'search' }))).toBe('not-granted')
    expect(seen).toEqual([])
  })

  it('holds the trusted window to core actions, with the gate on or off', async () => {
    const { carrier, loader, luoshu } = harness()
    luoshu.files.set('notes/a.md', 'x')
    const way = windowWay(carrier, { trusted })
    for (const gate of ['on', 'off'] as const) {
      loader.slots.gate = gate
      expect(code(await way.ask('trusted', 'luoshu.read', { path: 'notes/a.md' }))).toBe('not-granted')
      expect(code(await way.ask('trusted', 'storage.get', { key: 'drafts' }))).toBe('not-granted')
    }
    expect(luoshu.prepared).toEqual([])
  })

  it('lets the free actions skip the gate, with the gate failed', async () => {
    const { connect, loader, gate } = harness()
    loader.slots.gate = 'failed'
    loader.sandboxed('search', { query: {} })
    const search = connect(worker('search'))
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    expect((await search.ask('storage.set', { key: 'index', value: 1 })).ok).toBe(true)
    expect((await search.ask('cache.get', { key: 'index' })).ok).toBe(true)
    expect((await search.ask('core.self')).ok).toBe(true)
    const id = panel.call('search.query', { text: 'x' })
    const delivered = await search.delivered('search.query')
    search.answer(delivered.callId, ['a.md'])
    expect((await panel.reply(id)).result).toEqual(['a.md'])
    expect(gate.asked).toEqual([])
  })

  it('lets a lease holder\'s own lease actions skip the gate while acquire asks it', async () => {
    const { connect, loader, gate, providers } = harness()
    loader.installed('leases')
    providers.leases = { prepare: async () => ({ scope: {} }), perform: async call => call.action }
    gate.grants.mcp = [{ type: 'luoshu.write', paths: ['notes/**'] }]
    const mcp = connect(worker('mcp'))
    expect((await mcp.ask('leases.renew')).result).toBe('leases.renew')
    expect((await mcp.ask('leases.release')).result).toBe('leases.release')
    expect((await mcp.ask('leases.list')).result).toBe('leases.list')
    expect(gate.asked).toEqual([])
    expect((await mcp.ask('leases.acquire', { paths: ['notes/a.md'] })).ok).toBe(true)
    expect(gate.asked.map(access => [access.stage, access.capability])).toEqual([['raw', 'luoshu.write'], ['canonical', 'luoshu.write']])
  })

  // Acquire takes the luoshu's per-path lock, so a path the grant doesn't cover must not reach prepare
  it('prechecks every path a lease names before prepare', async () => {
    const { connect, loader, gate, providers } = harness()
    loader.installed('leases')
    const prepared: Call[] = []
    providers.leases = {
      prepare: async call => {
        prepared.push(call)
        return { scope: { paths: (call.args as { paths: string[] }).paths } }
      },
      perform: async () => null,
    }
    gate.grants.mcp = [{ type: 'luoshu.write', paths: ['notes/**'] }]
    expect(code(await connect(worker('mcp')).ask('leases.acquire', { paths: ['notes/a.md', 'secret/b.md'] }))).toBe('not-granted')
    expect(prepared).toEqual([])
    expect(gate.asked[0].scope).toEqual({ paths: ['notes/a.md', 'secret/b.md'] })
  })
})

// events.* is the bus's, which bus.test.ts covers
describe('ui.*', () => {
  it('answers unavailable until the mount serves it', async () => {
    const { connect, gate } = harness()
    const search = connect(worker('search'))
    expect(code(await search.ask('ui.panel', {}))).toBe('unavailable')
    expect(gate.asked).toEqual([])
  })

  it('hands it to the part that serves it after the floor and the ceiling, which asks the gate itself', async () => {
    const seen: Call[] = []
    const ui = async (call: Call) => { seen.push(call); return 'mounted' }
    const { carrier, connect, loader, gate } = harness({ served: { ui } })
    loader.slots.gate = 'failed'
    const search = connect(worker('search'))
    expect((await search.ask('ui.panel', { title: 'x' })).result).toBe('mounted')
    expect(seen.map(call => [call.caller, call.action, call.args])).toEqual([[worker('search'), 'ui.panel', { title: 'x' }]])
    expect(gate.asked).toEqual([])
    const way = windowWay(carrier, { trusted })
    expect(code(await way.ask('trusted', 'ui.panel', {}))).toBe('not-granted')
    loader.human.plugins.search = { argumentBytes: 64 }
    expect(code(await search.ask('ui.panel', { title: 'x'.repeat(100) }))).toBe('invalid')
    expect(seen).toHaveLength(1)
  })
})

describe('the gate slot', () => {
  it.each(['failed', 'absent', 'tampered'] as const)('refuses calls with power policy-down while the gate is %s', async state => {
    const { carrier, connect, loader, gate, luoshu } = harness()
    loader.slots.gate = state
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    loader.sandboxed('git', { log: {} })
    const search = connect(worker('search'))
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    expect(code(await search.ask('git.log'))).toBe('policy-down')
    // Windows get no luoshu access
    const way = windowWay(carrier, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    expect(gate.asked).toEqual([])
    expect(luoshu.prepared).toEqual([])
  })

  it('answers starting while the gate starts, so the SDK retries', async () => {
    const { connect, loader, gate } = harness()
    loader.slots.gate = 'starting'
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('starting')
    expect(gate.asked).toEqual([])
  })

  it('treats a gate that is on with no holder to ask as down', async () => {
    const { connect } = harness({ gate: () => null })
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
  })

  // Read as off, the gate and every guard would pass everything
  it('refuses policy-down when the loader can not give the slot states', async () => {
    const { connect, loader, luoshu } = harness()
    luoshu.files.set('a.md', 'x')
    loader.slot = () => { throw new Error('no state') }
    const search = connect(worker('search'))
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    expect(code(await search.ask('luoshu.write', { path: 'a.md', text: 'y' }))).toBe('policy-down')
    expect(luoshu.prepared).toEqual([])
  })

  it.each([['on', false], ['off', true]] as const)('passes calls with power while the gate is off and recording is %s', async (_name, nothing) => {
    const { connect, loader, gate, luoshu } = harness()
    loader.slots.gate = 'off'
    loader.nothing = nothing
    loader.sandboxed('git', { log: {} })
    luoshu.files.set('secret/a.md', 'x')
    const search = connect(worker('search'))
    const git = connect(worker('git'))
    expect((await search.ask('luoshu.read', { path: 'secret/a.md' })).result).toEqual({ text: 'x' })
    const id = search.call('git.log')
    const delivered = await git.delivered('git.log')
    git.answer(delivered.callId, [])
    expect((await search.reply(id)).ok).toBe(true)
    expect(gate.asked).toEqual([])
  })

  // The log fails once a record waited logFailMs unwritten, timed on the carrier's clock
  it('refuses calls with power policy-down while the gate is off and the log has failed', async () => {
    let now = 0
    const { connect, loader, log, luoshu } = harness({ clock: () => now })
    loader.slots.gate = 'off'
    log.failing = true
    luoshu.files.set('a.md', 'x')
    const search = connect(worker('search'))
    expect((await search.ask('storage.get', { key: 'index' })).ok).toBe(true)
    now = 30_000
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    // Free calls have no power and still pass
    expect((await search.ask('storage.get', { key: 'index' })).ok).toBe(true)
    expect(luoshu.prepared).toEqual([])
  })

  it('passes calls with power while the gate is off and recording is off, the log failed', async () => {
    let now = 0
    const { connect, loader, log, luoshu } = harness({ clock: () => now })
    loader.slots.gate = 'off'
    log.failing = true
    luoshu.files.set('a.md', 'x')
    const search = connect(worker('search'))
    await search.ask('storage.get', { key: 'index' })
    now = 30_000
    loader.nothing = true
    expect((await search.ask('luoshu.read', { path: 'a.md' })).ok).toBe(true)
  })

  it('never lets recording off pass a call while the gate is failed', async () => {
    const { connect, loader } = harness()
    loader.slots.gate = 'failed'
    loader.nothing = true
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
  })

  it('reads the gate slot again after prepare, so a gate that failed meanwhile refuses', async () => {
    const { connect, loader, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('a.md', 'x')
    let open!: () => void
    luoshu.hold.prepare = new Promise<void>(resolve => { open = resolve })
    const search = connect(worker('search'))
    const id = search.call('luoshu.read', { path: 'a.md' })
    for (let i = 0; i < 100 && luoshu.prepared.length === 0; i++) await tick(2)
    loader.slots.gate = 'failed'
    open()
    expect(code(await search.reply(id))).toBe('policy-down')
    expect(luoshu.performed).toEqual([])
    expect(luoshu.released).toHaveLength(1)
  })
})

describe('precheck', () => {
  it.each([
    ['allow as 1', { allow: 1, view: 1 }],
    ['allow as text', { allow: 'true', view: 1 }],
    ['no allow', { view: 1 }],
    ['null', null],
    ['a promise', Promise.resolve({ allow: true, view: 1 })],
    ['an ask at the raw stage', { ask: 'luoshu.read **', view: 1 }],
  ])('counts only an exact allow: true, refusing %s', async (_name, decision) => {
    const { connect, gate, luoshu } = harness()
    gate.decision = () => decision
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('not-granted')
    expect(luoshu.prepared).toEqual([])
  })

  it('refuses one call policy-down when the gate throws and records the fault, the next call decided again', async () => {
    const { carrier, connect, gate, log, debug, luoshu } = harness()
    luoshu.files.set('a.md', 'x')
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    let throws = true
    gate.decision = access => {
      if (throws) throw new Error('grant table at /secret/path broke')
      return gate.granted(access)
    }
    const search = connect(worker('search'))
    const reply = await search.ask('luoshu.read', { path: 'a.md' })
    expect(reply.refusal).toEqual({ code: 'policy-down', action: 'luoshu.read' })
    throws = false
    expect((await search.ask('luoshu.read', { path: 'a.md' })).ok).toBe(true)
    await tick()
    expect(log.events('fault')).toEqual([{ event: 'fault', fields: { plugin: 'gate', step: 'precheck', count: 1 } }])
    // The gate's own text, for the gate's debug and not the caller's
    expect(debug.map(entry => [entry.plugin, entry.text])).toEqual([['gate', 'grant table at /secret/path broke']])
    carrier.close()
  })

  it('records a gate that throws at decide as a fault at decide', async () => {
    const { carrier, connect, gate, log } = harness()
    gate.decision = access => {
      if (access.stage === 'canonical') throw new Error('broken')
      return { allow: true, view: 1 }
    }
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'gate', step: 'decide', count: 1 }])
  })

  it('refuses policy-down when the StateView number can not be read, an allow included', async () => {
    const { connect, loader, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('a.md', 'x')
    loader.view = () => { throw new Error('no view') }
    const search = connect(worker('search'))
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    gate.decision = () => ({ allow: false, view: 1 })
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    expect(luoshu.performed).toEqual([])
  })

  it('refuses policy-down when the StateView number is not a whole number', async () => {
    const { connect, loader, gate } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    loader.view = () => '1' as never
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
  })

  it('refuses an answer made on an older StateView as stale', async () => {
    const { connect, loader, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('a.md', 'x')
    loader.current = 5
    gate.decision = () => ({ allow: true, view: 4 })
    const search = connect(worker('search'))
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('stale')
    gate.decision = () => ({ allow: true, view: 5 })
    expect((await search.ask('luoshu.read', { path: 'a.md' })).ok).toBe(true)
  })

  it('passes switched-off on and makes anything else a plain not-granted', async () => {
    const { connect, gate } = harness()
    const search = connect(worker('search'))
    gate.decision = () => ({ allow: false, code: 'switched-off', view: 1 })
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('switched-off')
    gate.decision = () => ({ allow: false, code: 'policy-down', view: 1 })
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('not-granted')
    // Only beside allow: false
    gate.decision = () => ({ code: 'switched-off', view: 1 })
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('not-granted')
  })

  it('gives a caller with no grant the same answer for a note that exists and one that does not, touching neither', async () => {
    const { connect, luoshu } = harness()
    luoshu.files.set('notes/there.md', 'secret')
    const search = connect(worker('search'))
    const there = await search.ask('luoshu.read', { path: 'notes/there.md' })
    const missing = await search.ask('luoshu.read', { path: 'notes/missing.md' })
    expect(there.refusal).toEqual({ code: 'not-granted', action: 'luoshu.read' })
    expect(missing.refusal).toEqual(there.refusal)
    expect(Object.keys(there).sort()).toEqual(Object.keys(missing).sort())
    expect(luoshu.prepared).toEqual([])
  })

  it('gives a caller with no grant the same answer for a declared action, an undeclared one and an absent plugin', async () => {
    const { connect, loader, gate } = harness()
    loader.sandboxed('git', { log: {} })
    const search = connect(worker('search'))
    connect(worker('git'))
    const answers = [
      await search.ask('git.log'), await search.ask('git.secretAction'), await search.ask('ghost.log'),
    ].map(reply => reply.refusal)
    expect(answers).toEqual([
      { code: 'not-granted', action: 'git.log' },
      { code: 'not-granted', action: 'git.secretAction' },
      { code: 'not-granted', action: 'ghost.log' },
    ])
    // With a grant the same calls learn what is there, only now
    gate.grants.search = [{ type: 'plugin.call', targets: ['git', 'ghost'] }]
    expect(code(await search.ask('git.secretAction'))).toBe('not-found')
    expect(code(await search.ask('ghost.log'))).toBe('unavailable')
  })
})
