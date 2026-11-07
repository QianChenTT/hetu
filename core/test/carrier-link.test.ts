import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, code, FakeGuard, FakeLog, harness, host, hostHalf, tick, worker } from './carrier-fakes.ts'

afterEach(cleanup)

// What the loader asks of the carrier through CarrierLink: lifecycle messages down a half's own way, floor records it
// can wait on and the limits the carrier enforces
describe('the carrier as the loader\'s link', () => {
  it('posts a lifecycle message down the half\'s own port', async () => {
    const { carrier, connect, loader } = harness()
    loader.sandboxed('search')
    const search = connect(worker('search'))
    carrier.send(worker('search'), { v: 1, kind: 'stop', graceMs: 3000 })
    expect(await search.waitFor(message => message.kind === 'stop')).toEqual({ v: 1, kind: 'stop', graceMs: 3000 })
  })

  it('hands a host half a copy of the message on a later turn', async () => {
    const { carrier } = harness()
    const vault = hostHalf(carrier, host('vault'))
    const message = { v: 1, kind: 'deps', deps: { log: 'ready' } }
    carrier.send(host('vault'), message)
    expect(vault.inbox).toEqual([])
    message.deps.log = 'starting'
    await tick()
    expect(vault.inbox).toEqual([{ v: 1, kind: 'deps', deps: { log: 'ready' } }])
  })

  it('drops a message for a way that ended', async () => {
    const { carrier } = harness()
    const vault = hostHalf(carrier, host('vault'))
    carrier.end(host('vault'))
    carrier.send(host('vault'), { v: 1, kind: 'stop', graceMs: 3000 })
    await tick()
    expect(vault.inbox).toEqual([])
  })

  it('drops a message for a caller it never registered', () => {
    const { carrier } = harness()
    expect(() => carrier.send(worker('ghost'), { v: 1, kind: 'stop', graceMs: 3000 })).not.toThrow()
  })

  // Only messages a half sends count against its rate. Twenty pings at a rate of 2 would be a flood if they counted
  it('counts no message it sends against the plugin\'s rate', async () => {
    const { carrier, connect, loader } = harness()
    loader.human.plugins.search = { messagesPerSecond: 2 }
    loader.sandboxed('search')
    const search = connect(worker('search'))
    for (let i = 0; i < 20; i++) carrier.send(worker('search'), { v: 1, kind: 'ping' })
    expect((await search.ask('core.self')).ok).toBe(true)
    expect(loader.crashes).toEqual([])
  })

  it('gives record the floor lane\'s landing', async () => {
    const log = new FakeLog()
    const { carrier, loader } = harness({ log })
    expect(await carrier.record('plugin.copied', { plugin: 'git' })).toBe('landed')
    loader.nothing = true
    expect(await carrier.record('plugin.copied', { plugin: 'mcp' })).toBe('muted')
    expect(log.records.map(record => [record.event, record.fields.plugin])).toEqual([['plugin.copied', 'git']])
  })

  it('takes a limit from the human for the plugin, then for all, then the floor, lowered by the watchdog', async () => {
    const { carrier, loader } = harness()
    loader.sandboxed('search')
    expect(carrier.limit('search', 'readyMs')).toBe(10000)
    loader.human.all = { readyMs: 20000 }
    expect(carrier.limit('search', 'readyMs')).toBe(20000)
    loader.human.plugins.search = { readyMs: 15000 }
    expect(carrier.limit('search', 'readyMs')).toBe(15000)
    const watchdog = hostHalf(carrier, host('watchdog'))
    expect((await watchdog.ask('watchdog.limit', { plugin: 'search', constant: 'readyMs', value: 5000 })).ok).toBe(true)
    expect(carrier.limit('search', 'readyMs')).toBe(5000)
  })
})

// The loader reports a slot or guard stopping for shutdown as failed, so nothing passes unguarded. Once the loader says
// shutdown began, what is down answers stopped rather than reading as a failure
describe('shutdown', () => {
  // A call with power, a guarded write and a read from a provider, each meeting what shutdown takes down
  function setup() {
    const parts = harness({ guardsFor: () => ['leases'] })
    const { connect, gate, guards, loader } = parts
    loader.slots.leases = 'on'
    guards.leases = new FakeGuard()
    gate.grants.mcp = [{ type: 'vault.write', paths: ['notes/**'] }]
    gate.grants.search = [{ type: 'vault.read', paths: ['**'] }]
    return { ...parts, mcp: connect(worker('mcp')), search: connect(worker('search')) }
  }

  it('answers stopped for a call with power once shutdown began and the gate reads failed', async () => {
    const { carrier, loader, search } = setup()
    carrier.stopping()
    loader.slots.gate = 'failed'
    expect(code(await search.ask('vault.read', { path: 'notes/a.md' }))).toBe('stopped')
  })

  it('answers stopped for a guarded write once shutdown began and the guard reads failed', async () => {
    const { carrier, loader, mcp, vault } = setup()
    carrier.stopping()
    loader.slots.leases = 'failed'
    expect(code(await mcp.ask('vault.write', { path: 'notes/a.md', text: 'x' }))).toBe('stopped')
    expect(vault.performed).toEqual([])
  })

  it('answers stopped for a provider that is gone once shutdown began', async () => {
    const { carrier, providers, search } = setup()
    carrier.stopping()
    delete (providers as Record<string, unknown>).vault
    expect(code(await search.ask('vault.read', { path: 'notes/a.md' }))).toBe('stopped')
  })

  it('answers policy-down, guard-down and unavailable for the same calls before shutdown', async () => {
    const { loader, mcp, providers, search } = setup()
    loader.slots.leases = 'failed'
    expect(code(await mcp.ask('vault.write', { path: 'notes/a.md', text: 'x' }))).toBe('guard-down')
    delete (providers as Record<string, unknown>).vault
    expect(code(await search.ask('vault.read', { path: 'notes/a.md' }))).toBe('unavailable')
    loader.slots.gate = 'failed'
    expect(code(await search.ask('vault.read', { path: 'notes/a.md' }))).toBe('policy-down')
  })

  it('writes no events.waiting or events.ended while shutdown takes the gate down', async () => {
    const { carrier, gate, loader, log, search } = setup()
    gate.grants.search.push({ type: 'events.subscribe', topics: ['vault.changed'] })
    expect((await search.ask('events.subscribe', { topics: ['vault.changed'] })).result).toEqual({ standing: [] })
    carrier.stopping()
    loader.slots.gate = 'failed'
    loader.current = 2
    carrier.changed()
    const vault = hostHalf(carrier, host('vault'))
    await vault.ask('events.publish', { topic: 'vault.changed', path: 'notes/a.md' })
    carrier.close()
    await tick()
    expect(log.events('events.waiting')).toEqual([])
    expect(log.events('events.ended')).toEqual([])
  })
})
