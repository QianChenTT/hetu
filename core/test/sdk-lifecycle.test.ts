import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin, type PluginContext, type PluginSpec, run } from '../sdk/plugin.ts'
import { Refused } from '../sdk/refused.ts'
import { cleanup, harness, tick, worker } from './carrier-fakes.ts'
import { sdkTransport } from './sdk-fakes.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const init = (over: object = {}) => ({
  v: 1, kind: 'init', id: 'search', incarnation: 1, api: 1, deps: {}, lastStop: null, previousVersion: null, ...over,
})

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(5)
  }
}

// search running the spec on an in-process handle, as a host half runs on its link
function running(spec: PluginSpec, first: object | null = init()) {
  const parts = harness()
  parts.loader.sandboxed('search')
  parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
  const transport = sdkTransport(parts.carrier, worker('search'))
  run(definePlugin(spec), transport)
  if (first !== null) parts.carrier.send(worker('search'), first)
  const heard = () => parts.loader.lifecycle.map(entry => entry.kind)
  return { ...parts, transport, heard, send: (message: object) => parts.carrier.send(worker('search'), message) }
}

describe('a plugin\'s life through the SDK', () => {
  it('starts on init and sends ready once start resolved', async () => {
    let release: () => void = () => {}
    const { heard } = running({ start: () => new Promise<void>(resolve => { release = resolve }) })
    await tick(30)
    expect(heard()).toEqual([])
    release()
    await until(() => heard().includes('ready'))
    expect(heard()).toEqual(['ready'])
  })

  it('hands start the id, incarnation, lastStop and previousVersion from init', async () => {
    let seen: PluginContext | null = null
    running({ start: ctx => { seen = ctx } }, init({ incarnation: 2, lastStop: 'off', previousVersion: '1.0.0' }))
    await until(() => seen !== null)
    expect(seen).toMatchObject({ id: 'search', incarnation: 2, lastStop: 'off', previousVersion: '1.0.0' })
  })

  it('hands start the data folder init carries to an install host half and null when it carries none', async () => {
    let host: PluginContext | null = null
    let other: PluginContext | null = null
    running({ start: ctx => { host = ctx } }, init({ dataDir: 'C:\\data' }))
    running({ start: ctx => { other = ctx } }, init())
    await until(() => host !== null && other !== null)
    expect(host!.dataDir).toBe('C:\\data')
    expect(other!.dataDir).toBeNull()
  })

  // The door's port reaches http's utility half in its init. Any other half hears none
  it('hands start the port init carries and null when it carries none or one that is no port', async () => {
    const seen: (number | null)[] = []
    for (const first of [init({ port: 5123 }), init(), init({ port: 0 }), init({ port: 65536 }), init({ port: 4747.5 }), init({ port: '4747' })]) {
      let ctx: PluginContext | null = null
      running({ start: given => { ctx = given } }, first)
      await until(() => ctx !== null)
      seen.push(ctx!.port)
    }
    expect(seen).toEqual([5123, null, null, null, null, null])
  })

  it('reads its requires and plugin.call targets from deps', async () => {
    let ctx: PluginContext | null = null
    const { send } = running({ start: given => { ctx = given } }, init({ deps: { luoshu: 'ready', mcp: 'starting', git: 'unavailable' } }))
    await until(() => ctx !== null)
    expect(['luoshu', 'mcp', 'git', 'other'].map(id => ctx!.has(id))).toEqual([true, true, false, false])
    send({ v: 1, kind: 'deps', deps: { luoshu: 'unavailable', mcp: 'ready' } })
    await until(() => !ctx!.has('luoshu'))
    expect(ctx!.has('mcp')).toBe(true)
  })

  // Only http's utility half may make the call, so search's worker is refused at the floor
  it('tells the core a failed bind as core.bindFailed with the reason and nothing else', async () => {
    let answer: unknown = null
    const { transport } = running({
      start: async ctx => { answer = await ctx.bindFailed('port-taken').then(() => 'answered', (error: Refused) => error.code) },
    })
    await until(() => answer !== null)
    expect(answer).toBe('not-granted')
    const call = (transport.sent as Record<string, unknown>[]).find(message => message.kind === 'call')
    expect(call).toMatchObject({ action: 'core.bindFailed', args: { reason: 'port-taken' } })
    expect(Object.keys(call!.args as object)).toEqual(['reason'])
  })

  it('answers ping with pong', async () => {
    const { heard, send } = running({ start: () => {} })
    await until(() => heard().includes('ready'))
    send({ v: 1, kind: 'ping' })
    await until(() => heard().includes('pong'))
  })

  it('sends no ready when start throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { heard } = running({ start: () => { throw new Error('broken') } })
    await tick(50)
    expect(heard()).toEqual([])
    expect(error).toHaveBeenCalled()
  })

  it('runs stop and every onStop, then answers stopped', async () => {
    const order: string[] = []
    const { heard, send } = running({
      start: ctx => {
        ctx.onStop(() => { order.push('onStop') })
      },
      stop: () => { order.push('stop') },
    })
    await until(() => heard().includes('ready'))
    send({ v: 1, kind: 'stop', graceMs: 3000 })
    await until(() => heard().includes('stopped'))
    expect(order.sort()).toEqual(['onStop', 'stop'])
  })

  it('waits for stop work that takes time, so its save lands before stopped goes out', async () => {
    const order: string[] = []
    const slow = (name: string) => new Promise<void>(resolve => setTimeout(() => {
      order.push(name)
      resolve()
    }, 40))
    const { heard, send } = running({
      start: ctx => {
        ctx.onStop(() => slow('onStop saved'))
      },
      stop: () => slow('stop saved'),
    })
    await until(() => heard().includes('ready'))
    send({ v: 1, kind: 'stop', graceMs: 3000 })
    await until(() => heard().includes('stopped'))
    order.push('stopped')
    expect(order.slice(0, 2).sort()).toEqual(['onStop saved', 'stop saved'])
    expect(order[2]).toBe('stopped')
  })

  it('answers stopped within the grace when an onStop hangs', async () => {
    const { heard, send } = running({ start: ctx => { ctx.onStop(() => new Promise(() => {})) } })
    await until(() => heard().includes('ready'))
    const started = Date.now()
    send({ v: 1, kind: 'stop', graceMs: 400 })
    await until(() => heard().includes('stopped'))
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('settles calls still pending at stop with stopped', async () => {
    let pending: Promise<unknown> | null = null
    const parts = running({
      start: ctx => {
        pending = ctx.luoshu.read({ path: 'notes/a.md' }).catch((err: unknown) => err)
      },
    })
    parts.luoshu.hold.prepare = new Promise(() => {})
    await until(() => parts.heard().includes('ready') && pending !== null)
    parts.send({ v: 1, kind: 'stop', graceMs: 3000 })
    const settled = await pending
    expect(settled).toBeInstanceOf(Refused)
    expect(settled).toMatchObject({ code: 'stopped', action: 'luoshu.read' })
  })

  it('ignores every message before init', async () => {
    const { heard, send } = running({ start: () => {} }, null)
    send({ v: 1, kind: 'ping' })
    send({ v: 1, kind: 'stop', graceMs: 3000 })
    await tick(30)
    expect(heard()).toEqual([])
    send(init())
    await until(() => heard().includes('ready'))
    expect(heard()).toEqual(['ready'])
  })
})

describe('a plugin hearing its requirements change', () => {
  const deps = (map: object) => ({ v: 1, kind: 'deps', deps: map })

  // A hook gets nothing and reads has again, so what it reads is the map the deps message brought
  it('runs each onDeps hook once a deps message changed the map, with has already reading the new map', async () => {
    const seen: boolean[][] = []
    let ctx: PluginContext | null = null
    const { send } = running({
      start: given => {
        ctx = given
        given.onDeps(() => { seen.push([given.has('mcp'), given.has('git')]) })
      },
    }, init({ deps: { mcp: 'unavailable', git: 'ready' } }))
    await until(() => ctx !== null)
    await tick(20)
    // init's own read runs none
    expect(seen).toEqual([])
    send(deps({ mcp: 'starting', git: 'ready' }))
    await until(() => seen.length === 1)
    expect(seen).toEqual([[true, true]])
    // starting to ready is a change, though has read true for both
    send(deps({ mcp: 'ready', git: 'ready' }))
    await until(() => seen.length === 2)
    // The same map in another order is no change
    send(deps({ git: 'ready', mcp: 'ready' }))
    await tick(30)
    expect(seen).toHaveLength(2)
    // A key gone or a key added is
    send(deps({ mcp: 'ready' }))
    await until(() => seen.length === 3)
    expect(seen[2]).toEqual([true, false])
    send(deps({ mcp: 'ready', git: 'unavailable' }))
    await until(() => seen.length === 4)
    expect(seen[3]).toEqual([true, false])
  })

  it('runs every hook, one that throws or rejects caught and the rest still run', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ran: string[] = []
    let ctx: PluginContext | null = null
    const { send } = running({
      start: given => {
        ctx = given
        given.onDeps(() => { throw new Error('first') })
        given.onDeps(async () => { throw new Error('second') })
        given.onDeps(() => { ran.push('third') })
      },
    })
    await until(() => ctx !== null)
    send(deps({ mcp: 'ready' }))
    await until(() => ran.length === 1)
    await tick(20)
    expect(errors).toHaveBeenCalledTimes(2)
    send(deps({ mcp: 'unavailable' }))
    await until(() => ran.length === 2)
  })

  it('runs none for a deps message that is not a map, nor once the half is stopping', async () => {
    let ran = 0
    const { send, heard } = running({ start: given => { given.onDeps(() => { ran++ }) } })
    await until(() => heard().includes('ready'))
    send({ v: 1, kind: 'deps', deps: 'mcp' })
    send({ v: 1, kind: 'deps' })
    await tick(30)
    expect(ran).toBe(0)
    send({ v: 1, kind: 'stop', graceMs: 3000 })
    send(deps({ mcp: 'ready' }))
    await until(() => heard().includes('stopped'))
    await tick(20)
    expect(ran).toBe(0)
  })
})
