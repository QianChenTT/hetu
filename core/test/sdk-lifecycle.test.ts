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
  parts.gate.grants.search = [{ type: 'vault.read', paths: ['**'] }]
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

  it('reads its requires and plugin.call targets from deps', async () => {
    let ctx: PluginContext | null = null
    const { send } = running({ start: given => { ctx = given } }, init({ deps: { vault: 'ready', mcp: 'starting', git: 'unavailable' } }))
    await until(() => ctx !== null)
    expect(['vault', 'mcp', 'git', 'other'].map(id => ctx!.has(id))).toEqual([true, true, false, false])
    send({ v: 1, kind: 'deps', deps: { vault: 'unavailable', mcp: 'ready' } })
    await until(() => !ctx!.has('vault'))
    expect(ctx!.has('mcp')).toBe(true)
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
        pending = ctx.vault.read({ path: 'notes/a.md' }).catch((err: unknown) => err)
      },
    })
    parts.vault.hold.prepare = new Promise(() => {})
    await until(() => parts.heard().includes('ready') && pending !== null)
    parts.send({ v: 1, kind: 'stop', graceMs: 3000 })
    const settled = await pending
    expect(settled).toBeInstanceOf(Refused)
    expect(settled).toMatchObject({ code: 'stopped', action: 'vault.read' })
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
