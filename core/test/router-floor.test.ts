import { afterEach, describe, expect, it } from 'vitest'
import type { Call } from '../api/policy-jobs.ts'
import { cleanup, code, editor, harness, host, hostHalf, tick, trusted, windowWay, worker } from './router-fakes.ts'

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
    // The spellings Windows treats apart on disk never reach the storage plugin as a key
    ['a storage key with a backslash', 'storage.set', { key: 'a\b', value: 1 }],
    ['a storage key naming a stream', 'storage.get', { key: 'a:stream' }],
    ['a storage key ending in a dot', 'storage.get', { key: 'con.' }],
    ['a storage key ending in a space', 'cache.get', { key: 'nul ' }],
    ['a storage key with an extension', 'storage.get', { key: 'con.txt' }],
    ['a storage key spelled as an 8.3 alias', 'storage.get', { key: 'keyabc~1' }],
    ['a storage key starting with a capital', 'storage.get', { key: 'Con' }],
    ['a storage key past 64 characters', 'cache.set', { key: `a${'b'.repeat(64)}`, value: 1 }],
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
    const { connect, pluginsManager, gate } = harness()
    pluginsManager.sandboxed('git', { log: {} })
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

  it('measures args against the caller\'s own cap, raised or lowered by the human', async () => {
    const { connect, pluginsManager } = harness()
    pluginsManager.sandboxed('search')
    const search = connect(worker('search'))
    const big = 'x'.repeat(MiB + 10)
    expect((await search.ask('storage.set', { key: 'index', value: big })).refusal).toEqual({ code: 'invalid', action: 'storage.set', reason: 'too-large' })
    pluginsManager.human.plugins.search = { argumentBytes: 2 * MiB }
    expect((await search.ask('storage.set', { key: 'index', value: big })).ok).toBe(true)
    // Another plugin keeps the fixed cap
    expect(code(await connect(worker('git')).ask('storage.set', { key: 'index', value: big }))).toBe('invalid')
    pluginsManager.human.plugins.search = { argumentBytes: 100 }
    expect((await search.ask('storage.set', { key: 'index', value: 'y'.repeat(200) })).refusal).toMatchObject({ reason: 'too-large' })
  })
})

describe('the floor', () => {
  // The roadmap's proof for step 14: no plugin reaches security.* or the window lifecycle actions, whatever the gate
  const securityActions = [
    ['security.request', { change: { kind: 'plugin.on', plugin: 'search' } }],
    ['security.confirm', { requestId: 'req-1' }],
    ['security.cancel', { requestId: 'req-1' }],
    ['app.openSecurity', undefined],
    ['security.list', undefined],
    ['core.stop', { plugin: 'search' }],
    ['core.restart', { plugin: 'search' }],
    ['app.quit', undefined],
    ['app.relaunch', undefined],
  ] as const

  it.each(securityActions)('refuses %s for every plugin, MCP and host halves included, in every gate state, without asking the gate', async (action, args) => {
    const seen: Call[] = []
    const { router, connect, gate, pluginsManager } = harness({ core: async call => { seen.push(call); return null }, armed: () => true })
    const plugins = [
      ...['mcp', 'search', 'gate'].map(id => connect(worker(id))),
      ...['luoshu', 'gate', 'exec'].map(id => hostHalf(router, host(id))),
    ]
    for (const state of ['on', 'off', 'failed', 'absent'] as const) {
      pluginsManager.policyJobs.gate = state
      for (const plugin of plugins) expect(code(await plugin.ask(action, args))).toBe('not-granted')
    }
    expect(seen).toEqual([])
    expect(gate.asked).toEqual([])
  })

  it('takes the window lifecycle actions from the windows the core table names', async () => {
    const seen: string[] = []
    const { router } = harness({ core: async call => { seen.push(`${call.caller.kind === 'window' ? call.caller.role : '?'} ${call.action}`); return null }, armed: () => true })
    const way = windowWay(router, { 'editor-1': editor, trusted })
    for (const [action, args] of securityActions) {
      for (const sender of ['editor-1', 'trusted']) await way.ask(sender, action, args)
    }
    expect(seen).toEqual([
      'editor security.request', 'trusted security.request', 'trusted security.confirm', 'trusted security.cancel',
      'editor app.openSecurity', 'trusted app.openSecurity', 'trusted security.list', 'trusted core.stop',
      'editor core.restart', 'trusted core.restart', 'editor app.quit', 'trusted app.quit', 'trusted app.relaunch',
    ])
  })

  // The input delay: a Confirm that arrives before the trusted window armed counts for nothing, whatever the page did
  it('refuses a Confirm from the trusted window before it armed, and takes one after', async () => {
    const seen: Call[] = []
    let armed = false
    const { router } = harness({ core: async call => { seen.push(call); return null }, armed: caller => caller.kind === 'window' && armed })
    const way = windowWay(router, { trusted })
    expect(code(await way.ask('trusted', 'security.confirm', { requestId: 'req-1' }))).toBe('throttled')
    expect(seen).toEqual([])
    armed = true
    expect((await way.ask('trusted', 'security.confirm', { requestId: 'req-1' })).ok).toBe(true)
    expect(seen.map(call => call.action)).toEqual(['security.confirm'])
  })

  // With confirmOff on a request from the trusted window applies at once, so every action it sends that
  // changes something waits for the delay like a Confirm. Reads don't
  it('refuses the trusted window’s other actions before it armed, and answers its reads', async () => {
    const seen: string[] = []
    let armed = false
    const { router } = harness({ core: async call => { seen.push(call.action); return null }, armed: () => armed })
    const way = windowWay(router, { trusted, 'editor-1': editor })
    for (const [action, args] of securityActions) {
      if (action === 'security.list') continue
      expect(code(await way.ask('trusted', action, args))).toBe('throttled')
    }
    expect((await way.ask('trusted', 'security.list')).ok).toBe(true)
    expect((await way.ask('trusted', 'core.status')).ok).toBe(true)
    // The editor has no delay of its own
    expect((await way.ask('editor-1', 'security.request', { change: { kind: 'plugin.on', plugin: 'search' } })).ok).toBe(true)
    armed = true
    expect((await way.ask('trusted', 'security.request', { change: { kind: 'plugin.on', plugin: 'search' } })).ok).toBe(true)
  })

  it('refuses every Confirm when nothing says the trusted window armed', async () => {
    const { router } = harness({ core: async () => null })
    const way = windowWay(router, { trusted })
    expect(code(await way.ask('trusted', 'security.confirm', { requestId: 'req-1' }))).toBe('throttled')
  })

  it('takes security.request from any window and security.confirm only from the trusted one, with the gate failed', async () => {
    const seen: Call[] = []
    const { router, pluginsManager, gate } = harness({ core: async call => { seen.push(call); return { held: true } }, armed: () => true })
    pluginsManager.policyJobs.gate = 'failed'
    const way = windowWay(router, { 'editor-1': editor, trusted })
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
    const { router } = harness()
    const way = windowWay(router, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'security.request', { change: { kind: 'plugin.on', plugin: 'search' } }))).toBe('unavailable')
  })

  it('fails a result from a part the core serves that is not plain data', async () => {
    const { router } = harness({ core: async () => ({ when: new Date(0) }) })
    const way = windowWay(router, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'security.request', { change: { kind: 'plugin.on', plugin: 'search' } }))).toBe('failed')
  })

  // No part of the core serves watchdog.*, so it is a call to a plugin of that id like any other
  it('routes watchdog.* to a plugin of that id and never to the core', async () => {
    const seen: Call[] = []
    const { router, connect, pluginsManager } = harness({ core: async call => { seen.push(call); return null } })
    pluginsManager.policyJobs.gate = 'off'
    pluginsManager.sandboxed('search')
    expect(code(await connect(worker('search')).ask('watchdog.stop', { plugin: 'search' }))).toBe('unavailable')
    expect(code(await hostHalf(router, host('luoshu')).ask('watchdog.limit', { plugin: 'search' }))).toBe('unavailable')
    expect(code(await windowWay(router, { trusted }).ask('trusted', 'watchdog.restart', { plugin: 'search' }))).toBe('not-granted')
    expect(seen).toEqual([])
  })

  it('treats a plugin whose state is outside the list as absent', async () => {
    const { connect, pluginsManager } = harness()
    pluginsManager.policyJobs.gate = 'off'
    pluginsManager.plugins.git = { state: 'READY' as never, place: 'sandboxed', incarnation: 1, serves: 'worker', actions: { log: {} }, topics: [] }
    expect(code(await connect(worker('search')).ask('git.log'))).toBe('unavailable')
  })

  it.each(['on', 'off', 'failed'] as const)('takes core.refused from http\'s host half on its utility port with the gate %s, asking no gate', async state => {
    const { router, connect, pluginsManager, gate, log } = harness()
    pluginsManager.policyJobs.gate = state
    pluginsManager.utility('mcp-http-handler')
    const http = connect(host('mcp-http-handler'))
    expect(await http.ask('core.refused', { reason: 'host', count: 3 })).toMatchObject({ ok: true, result: null })
    expect(gate.asked).toEqual([])
    router.close()
    await tick()
    expect(log.events('mcp-http-handler.refused').map(record => record.fields)).toEqual([{ reason: 'host', count: 3 }])
  })

  it.each(['on', 'off', 'failed'] as const)('hands core.bindFailed from http\'s host half on its utility port to the plugins manager with the gate %s, asking no gate', async state => {
    const seen: Call[] = []
    const { connect, pluginsManager, gate } = harness({ core: async call => { seen.push(call); return null } })
    pluginsManager.policyJobs.gate = state
    pluginsManager.utility('mcp-http-handler')
    expect(await connect(host('mcp-http-handler')).ask('core.bindFailed', { reason: 'port-taken' })).toMatchObject({ ok: true, result: null })
    expect(seen).toMatchObject([{ action: 'core.bindFailed', caller: host('mcp-http-handler'), args: { reason: 'port-taken' } }])
    expect(gate.asked).toEqual([])
  })

  // The two actions only http's utility half may call
  const doorActions = [['core.refused', { reason: 'host', count: 1 }], ['core.bindFailed', { reason: 'port-taken' }]] as const

  it.each(['on', 'off', 'failed'] as const)('refuses the door\'s two core actions to every other caller with the gate %s', async state => {
    const seen: Call[] = []
    const { router, connect, pluginsManager, gate, log } = harness({ core: async call => { seen.push(call); return null } })
    pluginsManager.policyJobs.gate = state
    pluginsManager.utility('mcp-http-handler')
    pluginsManager.sandboxed('search')
    const way = windowWay(router, { 'editor-1': editor, trusted })
    const callers = [
      // A sandboxed worker and a worker half of http itself, which matches on its id, its way and its place
      connect(worker('search')),
      connect(worker('mcp-http-handler')),
      // Another plugin's host half, on a port and on an in-process handle
      connect(host('exec')),
      hostHalf(router, host('exec', 2)),
      // http's host half on a handle, which no utility half is ever given
      hostHalf(router, host('mcp-http-handler')),
    ]
    for (const [action, args] of doorActions) {
      const refused = [
        ...await Promise.all(callers.map(caller => caller.ask(action, args))),
        await way.ask('editor-1', action, args),
        await way.ask('trusted', action, args),
      ]
      expect(refused.map(code)).toEqual(Array(refused.length).fill('not-granted'))
    }
    expect(gate.asked).toEqual([])
    expect(seen).toEqual([])
    router.close()
    await tick()
    expect(log.events('mcp-http-handler.refused')).toEqual([])
  })

  it('refuses the door\'s two core actions to http\'s host half on a port when http is not placed in a utility process', async () => {
    const seen: Call[] = []
    const { router, connect, pluginsManager, log } = harness({ core: async call => { seen.push(call); return null } })
    pluginsManager.installed('mcp-http-handler')
    const placedHost = connect(host('mcp-http-handler'))
    for (const [action, args] of doorActions) expect(code(await placedHost.ask(action, args))).toBe('not-granted')
    delete pluginsManager.plugins['mcp-http-handler']
    const unknown = connect(host('mcp-http-handler', 2))
    for (const [action, args] of doorActions) expect(code(await unknown.ask(action, args))).toBe('not-granted')
    expect(seen).toEqual([])
    router.close()
    await tick()
    expect(log.events('mcp-http-handler.refused')).toEqual([])
  })

  it('holds the trusted window to core actions, with the gate on or off', async () => {
    const { router, pluginsManager, luoshu } = harness()
    luoshu.files.set('notes/a.md', 'x')
    const way = windowWay(router, { trusted })
    for (const gate of ['on', 'off'] as const) {
      pluginsManager.policyJobs.gate = gate
      expect(code(await way.ask('trusted', 'luoshu.read', { path: 'notes/a.md' }))).toBe('not-granted')
      expect(code(await way.ask('trusted', 'storage.get', { key: 'drafts' }))).toBe('not-granted')
    }
    expect(luoshu.prepared).toEqual([])
  })

  it('lets the free actions skip the gate, with the gate failed', async () => {
    const { connect, pluginsManager, gate } = harness()
    pluginsManager.policyJobs.gate = 'failed'
    pluginsManager.sandboxed('search', { query: {} })
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
    const { connect, pluginsManager, gate, providers } = harness()
    pluginsManager.installed('leases')
    providers.leases = { prepare: async () => ({ scope: {} }), perform: async call => call.action }
    gate.grants.scribe = [{ type: 'luoshu.write', paths: ['notes/**'] }]
    const scribe = connect(worker('scribe'))
    expect((await scribe.ask('leases.renew')).result).toBe('leases.renew')
    expect((await scribe.ask('leases.release')).result).toBe('leases.release')
    expect((await scribe.ask('leases.list')).result).toBe('leases.list')
    expect(gate.asked).toEqual([])
    expect((await scribe.ask('leases.acquire', { paths: ['notes/a.md'] })).ok).toBe(true)
    expect(gate.asked.map(access => [access.stage, access.capability])).toEqual([['raw', 'luoshu.write'], ['canonical', 'luoshu.write']])
  })

  // Acquire takes the luoshu's latch on a path, so a path the grant doesn't cover must not reach prepare
  it('prechecks every path a lease names before prepare', async () => {
    const { connect, pluginsManager, gate, providers } = harness()
    pluginsManager.installed('leases')
    const prepared: Call[] = []
    providers.leases = {
      prepare: async call => {
        prepared.push(call)
        return { scope: { paths: (call.args as { paths: string[] }).paths } }
      },
      perform: async () => null,
    }
    gate.grants.scribe = [{ type: 'luoshu.write', paths: ['notes/**'] }]
    expect(code(await connect(worker('scribe')).ask('leases.acquire', { paths: ['notes/a.md', 'secret/b.md'] }))).toBe('not-granted')
    expect(prepared).toEqual([])
    expect(gate.asked[0].scope).toEqual({ paths: ['notes/a.md', 'secret/b.md'] })
  })
})

// events.* is the bus's, which bus.test.ts covers
describe('ui.*', () => {
  it('answers unavailable until the drawer serves it', async () => {
    const { connect, gate } = harness()
    const search = connect(worker('search'))
    expect(code(await search.ask('ui.view', {}))).toBe('unavailable')
    expect(gate.asked).toEqual([])
  })

  it('hands it to the part that serves it after the floor and the ceiling, which asks the gate itself', async () => {
    const seen: Call[] = []
    const ui = async (call: Call) => { seen.push(call); return 'mounted' }
    const { router, connect, pluginsManager, gate } = harness({ drawer: ui })
    pluginsManager.policyJobs.gate = 'failed'
    const search = connect(worker('search'))
    expect((await search.ask('ui.view', { title: 'x' })).result).toBe('mounted')
    expect(seen.map(call => [call.caller, call.action, call.args])).toEqual([[worker('search'), 'ui.view', { title: 'x' }]])
    expect(gate.asked).toEqual([])
    const way = windowWay(router, { trusted })
    expect(code(await way.ask('trusted', 'ui.view', {}))).toBe('not-granted')
    pluginsManager.human.plugins.search = { argumentBytes: 64 }
    expect(code(await search.ask('ui.view', { title: 'x'.repeat(100) }))).toBe('invalid')
    expect(seen).toHaveLength(1)
  })
})

describe('the gate policy job', () => {
  it.each(['failed', 'absent'] as const)('refuses calls with power policy-down while the gate is %s', async state => {
    const { router, connect, pluginsManager, gate, luoshu } = harness()
    pluginsManager.policyJobs.gate = state
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    pluginsManager.sandboxed('git', { log: {} })
    const search = connect(worker('search'))
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    expect(code(await search.ask('git.log'))).toBe('policy-down')
    // Windows get no luoshu access
    const way = windowWay(router, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    expect(gate.asked).toEqual([])
    expect(luoshu.prepared).toEqual([])
  })

  it('treats a gate that is on with no holder to ask as down', async () => {
    const { connect } = harness({ gate: () => null })
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
  })

  // Read as off, the gate and every guard would pass everything
  it('refuses policy-down when the plugins manager can not give the policy job states', async () => {
    const { connect, pluginsManager, luoshu } = harness()
    luoshu.files.set('a.md', 'x')
    pluginsManager.policyJob = () => { throw new Error('no state') }
    const search = connect(worker('search'))
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    expect(code(await search.ask('luoshu.write', { path: 'a.md', text: 'y' }))).toBe('policy-down')
    expect(luoshu.prepared).toEqual([])
  })

  it.each([['on', false], ['off', true]] as const)('passes calls with power while the gate is off and recording is %s', async (_name, nothing) => {
    const { connect, pluginsManager, gate, luoshu } = harness()
    pluginsManager.policyJobs.gate = 'off'
    pluginsManager.nothing = nothing
    pluginsManager.sandboxed('git', { log: {} })
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

  // The log fails once a record waited logFailMs unwritten, timed on the router's clock. It decides nothing of a call
  it('passes calls with power while the gate is off and the log has failed', async () => {
    let now = 0
    const { connect, pluginsManager, log, luoshu, recording } = harness({ clock: () => now })
    pluginsManager.policyJobs.gate = 'off'
    log.failing = true
    luoshu.files.set('a.md', 'x')
    const search = connect(worker('search'))
    expect((await search.ask('storage.get', { key: 'index' })).ok).toBe(true)
    now = 30_000
    expect(recording.failing()).toBe(true)
    expect((await search.ask('luoshu.read', { path: 'a.md' })).result).toEqual({ text: 'x' })
    expect((await search.ask('storage.get', { key: 'index' })).ok).toBe(true)
  })

  it('passes calls with power while the gate is off and recording is off, the log failed', async () => {
    let now = 0
    const { connect, pluginsManager, log, luoshu } = harness({ clock: () => now })
    pluginsManager.policyJobs.gate = 'off'
    log.failing = true
    luoshu.files.set('a.md', 'x')
    const search = connect(worker('search'))
    await search.ask('storage.get', { key: 'index' })
    now = 30_000
    pluginsManager.nothing = true
    expect((await search.ask('luoshu.read', { path: 'a.md' })).ok).toBe(true)
  })

  it('never lets recording off pass a call while the gate is failed', async () => {
    const { connect, pluginsManager } = harness()
    pluginsManager.policyJobs.gate = 'failed'
    pluginsManager.nothing = true
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
  })

  it('reads the gate policy job again after prepare, so a gate that failed meanwhile refuses', async () => {
    const { connect, pluginsManager, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('a.md', 'x')
    let open!: () => void
    luoshu.hold.prepare = new Promise<void>(resolve => { open = resolve })
    const search = connect(worker('search'))
    const id = search.call('luoshu.read', { path: 'a.md' })
    for (let i = 0; i < 100 && luoshu.prepared.length === 0; i++) await tick(2)
    pluginsManager.policyJobs.gate = 'failed'
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
    const { router, connect, gate, log, debug, luoshu } = harness()
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
    router.close()
  })

  it('records a gate that throws at decide as a fault at decide', async () => {
    const { router, connect, gate, log } = harness()
    gate.decision = access => {
      if (access.stage === 'canonical') throw new Error('broken')
      return { allow: true, view: 1 }
    }
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    router.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'gate', step: 'decide', count: 1 }])
  })

  it('refuses policy-down when the grants snapshot number can not be read, an allow included', async () => {
    const { connect, pluginsManager, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('a.md', 'x')
    pluginsManager.view = () => { throw new Error('no view') }
    const search = connect(worker('search'))
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    gate.decision = () => ({ allow: false, view: 1 })
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
    expect(luoshu.performed).toEqual([])
  })

  it('refuses policy-down when the grants snapshot number is not a whole number', async () => {
    const { connect, pluginsManager, gate } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    pluginsManager.view = () => '1' as never
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('policy-down')
  })

  it('refuses an answer made on an older grants snapshot as stale', async () => {
    const { connect, pluginsManager, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('a.md', 'x')
    pluginsManager.current = 5
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
    const { connect, pluginsManager, gate } = harness()
    pluginsManager.sandboxed('git', { log: {} })
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

// A dot segment names no note. The contract's path schema refuses it for every action, so a path holding one answers
// invalid at shape from every caller whatever the gate's state, before the gate or a provider hears of it
describe('a path with a dot segment', () => {
  const dotted = ['.git/config', '.obsidian/x', 'notes/.hidden.md', 'notes/deep/.config/x.md', '‌.obsidian/app.json']
  const calls = (path: string): [string, unknown][] => [
    ['luoshu.read', { path }], ['luoshu.write', { path, text: 'x' }], ['luoshu.remove', { path, baseVersion: '0'.repeat(64) }],
    ['luoshu.move', { from: 'notes/a.md', to: path }], ['luoshu.move', { from: path, to: 'notes/a.md' }], ['luoshu.list', { folder: path }],
    ['luoshu.list', { after: path }], ['history.log', { path }], ['leases.acquire', { paths: ['notes/a.md', path] }],
    ['events.publish', { topic: 'search.indexed', path }],
  ]

  it.each(['on', 'off'] as const)('answers invalid from a plugin with the gate %s, a grant to every path held', async state => {
    const { connect, gate, luoshu, pluginsManager } = harness()
    pluginsManager.policyJobs.gate = state
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'luoshu.write', paths: ['**'] }, { type: 'luoshu.list', paths: ['**'] }]
    const search = connect(worker('search'))
    for (const path of dotted) {
      for (const [action, args] of calls(path)) expect(code(await search.ask(action, args)), `${action} ${path}`).toBe('invalid')
    }
    expect(gate.asked).toEqual([])
    expect(luoshu.prepared).toEqual([])
  })

  it.each(['on', 'off'] as const)('answers invalid from a window with the gate %s', async state => {
    const { router, gate, luoshu, pluginsManager } = harness()
    pluginsManager.policyJobs.gate = state
    const way = windowWay(router, { editor })
    for (const path of dotted) {
      expect(code(await way.ask('editor', 'luoshu.read', { path })), path).toBe('invalid')
      expect(code(await way.ask('editor', 'luoshu.write', { path, text: 'x' })), path).toBe('invalid')
      expect(code(await way.ask('editor', 'gate.reach', { plugin: 'search', path })), path).toBe('invalid')
    }
    expect(gate.asked).toEqual([])
    expect(gate.reads).toEqual([])
    expect(luoshu.prepared).toEqual([])
  })
})
