import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENVELOPE_ROOM } from '../api/rate.ts'
import { definePlugin } from '../sdk/plugin.ts'
import { runInUtility, utilityTransport, type UtilityPort } from '../sdk/utility.ts'
import type { WorkerLimits } from '../sdk/worker.ts'

afterEach(() => {
  vi.useRealTimers()
})

// The utility half's end of its channel as Electron gives it inside the process: message hands over an event with
// data, and nothing arrives before start
class FakePortMain extends EventEmitter implements UtilityPort {
  posted: unknown[] = []
  started = false

  postMessage(text: string): void {
    this.posted.push(text)
  }

  start(): void {
    this.started = true
  }

  gets(data: unknown): void {
    this.emit('message', { data, ports: [] })
  }
}

const limits: WorkerLimits = { messagesPerSecond: 1000, floodFactor: 10, floodMs: 5000, bytesPerSecond: 1000, resultBytes: 100 }
const cap = limits.resultBytes + ENVELOPE_ROOM
const init = JSON.stringify({ v: 1, kind: 'init', id: 'mcp-http-handler', incarnation: 1, api: 2, deps: {}, lastStop: null, previousVersion: null })

describe('the SDK\'s utility transport', () => {
  it('starts the port, sends JSON text and reads text from main', () => {
    const port = new FakePortMain()
    const transport = utilityTransport(port, limits)
    const heard: unknown[] = []
    transport.listen(message => heard.push(message))
    expect(port.started).toBe(true)
    transport.post({ v: 1, kind: 'ready' })
    expect(port.posted).toEqual(['{"v":1,"kind":"ready"}'])
    port.gets('{"v":1,"kind":"ping"}')
    port.gets({ v: 1, kind: 'ping' })
    port.gets('not json')
    expect(heard).toEqual([{ v: 1, kind: 'ping' }])
  })

  it('paces itself to 90% of the byte budget main counts, in order, since no relay sits in front of it', () => {
    vi.useFakeTimers()
    let now = 0
    const port = new FakePortMain()
    // 1000 a second, 900 kept for the plugin, a bucket of the cap at the start
    const transport = utilityTransport(port, limits, () => now)
    expect(transport.paces).toBe(true)
    transport.post({ a: 'x'.repeat(cap - 20) })
    transport.post({ b: 'y'.repeat(880) })
    transport.post({ c: 1 })
    expect(port.posted).toHaveLength(1)
    now = 500
    vi.advanceTimersByTime(500)
    expect(port.posted).toHaveLength(1)
    now = 1100
    vi.advanceTimersByTime(600)
    expect(port.posted.map(text => Object.keys(JSON.parse(text as string))[0])).toEqual(['a', 'b', 'c'])
  })

  it('paces to limits main sends from then on, lower or higher, and never holds a pong back', () => {
    vi.useFakeTimers()
    let now = 0
    const port = new FakePortMain()
    const roomy = { ...limits, bytesPerSecond: 1_000_000 }
    const transport = utilityTransport(port, roomy, () => now)
    // 1000 a second, so ten go at once
    for (let i = 0; i < 10; i++) transport.post({ n: i })
    expect(port.posted).toHaveLength(10)
    // Lowered to 10 a second, 9 kept for the plugin, and the last ten went within this second
    transport.limit({ ...roomy, messagesPerSecond: 10 })
    now = 1000
    for (let i = 10; i < 30; i++) transport.post({ n: i })
    expect(port.posted).toHaveLength(19)
    transport.post({ v: 1, kind: 'pong' })
    expect(port.posted.at(-1)).toBe('{"v":1,"kind":"pong"}')
    now = 2000
    vi.advanceTimersByTime(1000)
    expect(port.posted).toHaveLength(29)
    // Raised again, the rest go at once
    transport.limit(roomy)
    vi.advanceTimersByTime(10)
    expect(port.posted).toHaveLength(31)
  })

  it('takes no limits from its channel, where only main\'s text arrives', () => {
    vi.useFakeTimers()
    const port = new FakePortMain()
    const transport = utilityTransport(port, { ...limits, bytesPerSecond: 1_000_000, messagesPerSecond: 10 }, () => 0)
    transport.listen(() => {})
    port.gets({ v: 1, kind: 'limits', limits: { ...limits, bytesPerSecond: 1_000_000, messagesPerSecond: 1000 } })
    for (let i = 0; i < 20; i++) transport.post({ n: i })
    expect(port.posted).toHaveLength(9)
  })

  it('refuses a message past the cap by throwing, so a reply fails on its own', () => {
    const transport = utilityTransport(new FakePortMain(), limits)
    expect(() => transport.post({ v: 1, kind: 'reply', id: 1, result: 'x'.repeat(200_000) })).toThrow(/too-large/)
  })
})

describe('a plugin started in a utility process', () => {
  it('runs on its port at the limits it was given and answers init with ready and a ping with a pong', async () => {
    const port = new FakePortMain()
    let started = false
    runInUtility(definePlugin({ start: () => { started = true } }), port, limits)
    port.gets(init)
    await vi.waitFor(() => expect(port.posted).toContain('{"v":1,"kind":"ready"}'))
    expect(started).toBe(true)
    port.gets('{"v":1,"kind":"ping"}')
    await vi.waitFor(() => expect(port.posted).toContain('{"v":1,"kind":"pong"}'))
  })

  it('gives back a way to hand the transport new limits', async () => {
    const port = new FakePortMain()
    const limit = runInUtility(definePlugin({ start() {} }), port, limits)
    expect(typeof limit).toBe('function')
    expect(() => limit({ ...limits, messagesPerSecond: 20 })).not.toThrow()
  })

  it('reads its context as a host half with no data folder', async () => {
    const port = new FakePortMain()
    let dataDir: string | null | undefined
    runInUtility(definePlugin({ start: ctx => { dataDir = ctx.dataDir } }), port, limits)
    port.gets(init)
    await vi.waitFor(() => expect(port.posted).toContain('{"v":1,"kind":"ready"}'))
    expect(dataDir).toBe(null)
  })
})
