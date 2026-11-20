import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, code, editor, FakeGuard, FakeLog, harness, host, hostHalf, tick, windowWay, worker } from './router-fakes.ts'

afterEach(cleanup)

// What the plugins manager asks of the router through RouterLink: lifecycle messages down a half's own way, core records it
// can wait on and the limits the router enforces
describe('the router as the plugins manager\'s link', () => {
  it('posts a lifecycle message down the half\'s own port', async () => {
    const { router, connect, pluginsManager } = harness()
    pluginsManager.sandboxed('search')
    const search = connect(worker('search'))
    router.send(worker('search'), { v: 1, kind: 'stop', graceMs: 3000 })
    expect(await search.waitFor(message => message.kind === 'stop')).toEqual({ v: 1, kind: 'stop', graceMs: 3000 })
  })

  it('hands a host half a copy of the message on a later turn', async () => {
    const { router } = harness()
    const luoshu = hostHalf(router, host('luoshu'))
    const message = { v: 1, kind: 'deps', deps: { log: 'ready' } }
    router.send(host('luoshu'), message)
    expect(luoshu.inbox).toEqual([])
    message.deps.log = 'starting'
    await tick()
    expect(luoshu.inbox).toEqual([{ v: 1, kind: 'deps', deps: { log: 'ready' } }])
  })

  it('drops a message for a way that ended', async () => {
    const { router } = harness()
    const luoshu = hostHalf(router, host('luoshu'))
    router.end(host('luoshu'))
    router.send(host('luoshu'), { v: 1, kind: 'stop', graceMs: 3000 })
    await tick()
    expect(luoshu.inbox).toEqual([])
  })

  it('drops a message for a caller it never registered', () => {
    const { router } = harness()
    expect(() => router.send(worker('ghost'), { v: 1, kind: 'stop', graceMs: 3000 })).not.toThrow()
  })

  // Only messages a half sends count against its rate. Twenty pings at a rate of 2 would be a flood if they counted
  it('counts no message it sends against the plugin\'s rate', async () => {
    const { router, connect, pluginsManager } = harness()
    pluginsManager.human.plugins.search = { messagesPerSecond: 2 }
    pluginsManager.sandboxed('search')
    const search = connect(worker('search'))
    for (let i = 0; i < 20; i++) router.send(worker('search'), { v: 1, kind: 'ping' })
    expect((await search.ask('core.self')).ok).toBe(true)
    expect(pluginsManager.crashes).toEqual([])
  })

  it('gives record the core record lane\'s landing', async () => {
    const log = new FakeLog()
    const { recording, router, pluginsManager } = harness({ log })
    expect(await recording.record('plugin.copied', { plugin: 'git' })).toBe('landed')
    pluginsManager.nothing = true
    expect(await recording.record('plugin.copied', { plugin: 'mcp' })).toBe('muted')
    expect(log.records.map(record => [record.event, record.fields.plugin])).toEqual([['plugin.copied', 'git']])
  })

  it('takes a limit from the human for the plugin, then for all, then the fixed value', () => {
    const { router, pluginsManager } = harness()
    pluginsManager.sandboxed('search')
    expect(router.limit('search', 'readyMs')).toBe(10000)
    pluginsManager.human.all = { readyMs: 20000 }
    expect(router.limit('search', 'readyMs')).toBe(20000)
    pluginsManager.human.plugins.search = { readyMs: 15000 }
    expect(router.limit('search', 'readyMs')).toBe(15000)
  })
})

// The plugins manager reports a policy job or guard stopping for shutdown as failed, so nothing passes unguarded. Once the plugins manager says
// shutdown began, what is down answers stopped rather than reading as a failure
describe('shutdown', () => {
  // A call with power, a guarded write and a read from a provider, each meeting what shutdown takes down
  function setup() {
    const parts = harness({ guardsFor: () => ['leases'] })
    const { connect, gate, guards, pluginsManager } = parts
    pluginsManager.policyJobs.leases = 'on'
    guards.leases = new FakeGuard()
    gate.grants.scribe = [{ type: 'luoshu.write', paths: ['notes/**'] }]
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    return { ...parts, scribe: connect(worker('scribe')), search: connect(worker('search')) }
  }

  it('answers stopped for a call with power once shutdown began and the gate reads failed', async () => {
    const { router, pluginsManager, search } = setup()
    router.stopping()
    pluginsManager.policyJobs.gate = 'failed'
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('stopped')
  })

  it('answers gate.reach and gate.filterReadable stopped once shutdown began and the gate reads failed', async () => {
    const { router, pluginsManager, gate, scribe, search } = setup()
    pluginsManager.sandboxed('search', { query: {} })
    gate.grants.scribe = [...gate.grants.scribe, { type: 'plugin.call', targets: ['search'] }]
    const way = windowWay(router, { editor })
    scribe.call('search.query', {})
    const got = await search.delivered('search.query')
    router.stopping()
    pluginsManager.policyJobs.gate = 'failed'
    expect(code(await way.ask('editor', 'gate.reach', { plugin: 'search', path: 'notes/a.md' }))).toBe('stopped')
    expect(code(await search.ask('gate.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('stopped')
  })

  it('answers stopped for a guarded write once shutdown began and the guard reads failed', async () => {
    const { router, pluginsManager, scribe, luoshu } = setup()
    router.stopping()
    pluginsManager.policyJobs.leases = 'failed'
    expect(code(await scribe.ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))).toBe('stopped')
    expect(luoshu.performed).toEqual([])
  })

  it('answers stopped for a provider that is gone once shutdown began', async () => {
    const { router, providers, search } = setup()
    router.stopping()
    delete (providers as Record<string, unknown>).luoshu
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('stopped')
  })

  it('answers policy-down, guard-down and unavailable for the same calls before shutdown', async () => {
    const { pluginsManager, scribe, providers, search } = setup()
    pluginsManager.policyJobs.leases = 'failed'
    expect(code(await scribe.ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))).toBe('guard-down')
    delete (providers as Record<string, unknown>).luoshu
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('unavailable')
    pluginsManager.policyJobs.gate = 'failed'
    expect(code(await search.ask('luoshu.read', { path: 'notes/a.md' }))).toBe('policy-down')
  })

  // A change the human confirmed just before Quit still applies during shutdown. A narrowing ends what it removed
  it('ends a subscription a change applied during shutdown no longer grants', async () => {
    const { router, gate, pluginsManager, search } = setup()
    gate.grants.search.push({ type: 'events.subscribe', topics: ['luoshu.changed'] })
    expect((await search.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: [] })
    router.stopping()
    gate.grants.search = gate.grants.search.filter(grant => grant.type !== 'events.subscribe')
    pluginsManager.current = 2
    router.changed()
    const luoshu = hostHalf(router, host('luoshu'))
    await luoshu.ask('events.publish', { topic: 'luoshu.changed' })
    await luoshu.ask('events.publish', { topic: 'luoshu.changed', path: 'notes/a.md' })
    await tick(30)
    expect(search.events().filter(event => event.topic === 'luoshu.changed')).toEqual([])
  })

  it('writes no events.waiting or events.ended while shutdown takes the gate down', async () => {
    const { router, gate, pluginsManager, log, search } = setup()
    gate.grants.search.push({ type: 'events.subscribe', topics: ['luoshu.changed'] })
    expect((await search.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: [] })
    router.stopping()
    pluginsManager.policyJobs.gate = 'failed'
    pluginsManager.current = 2
    router.changed()
    const luoshu = hostHalf(router, host('luoshu'))
    await luoshu.ask('events.publish', { topic: 'luoshu.changed', path: 'notes/a.md' })
    await tick(30)
    // The gate still holds during shutdown: a grants snapshot the gate never judged search on holds its events back
    expect(search.events()).toEqual([])
    router.close()
    await tick()
    expect(log.events('events.waiting')).toEqual([])
    expect(log.events('events.ended')).toEqual([])
  })
})
