import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENVELOPE_ROOM } from '../api/rate.ts'
import { definePlugin } from '../sdk/plugin.ts'
import { portTransport, runInWorker, type WorkerLimits } from '../sdk/worker.ts'

afterEach(() => {
  vi.useRealTimers()
})

// A worker's end of its channel: what it posted, and messages arriving on it
class FakePort {
  posted: unknown[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null

  postMessage(text: string): void {
    this.posted.push(text)
  }

  gets(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const limits: WorkerLimits = { messagesPerSecond: 1000, floodFactor: 10, floodMs: 5000, bytesPerSecond: 1000, resultBytes: 100 }
const cap = limits.resultBytes + ENVELOPE_ROOM

describe('the SDK\'s worker transport', () => {
  it('sends each message as JSON text and reads text from main', () => {
    const port = new FakePort()
    const transport = portTransport(port, limits)
    const heard: unknown[] = []
    transport.listen(message => heard.push(message))
    transport.post({ v: 1, kind: 'ready' })
    expect(port.posted).toEqual(['{"v":1,"kind":"ready"}'])
    port.gets('{"v":1,"kind":"ping"}')
    expect(heard).toEqual([{ v: 1, kind: 'ping' }])
  })

  it('ignores anything from main that isn\'t text that parses', () => {
    const port = new FakePort()
    const transport = portTransport(port, limits)
    const heard: unknown[] = []
    transport.listen(message => heard.push(message))
    port.gets({ v: 1 })
    port.gets('{not json')
    expect(heard).toEqual([])
  })

  it('refuses a message the relay would cut it off for, by throwing, so a reply fails instead', () => {
    const port = new FakePort()
    const transport = portTransport(port, limits)
    // Weighs the cap and one: 8 for the object, 1 for its key, 8 and the bytes for the string
    expect(() => transport.post({ t: 'x'.repeat(cap - 16) })).toThrow('too-large')
    expect(() => transport.post(JSON.parse('{"__proto__":1}'))).toThrow()
    expect(() => transport.post({ big: 1n })).toThrow()
    expect(port.posted).toEqual([])
    transport.post({ t: 'x'.repeat(cap - 17) })
    expect(port.posted).toHaveLength(1)
  })

  it('holds messages past 90% of the byte budget until it refills, in order', () => {
    vi.useFakeTimers()
    let now = 0
    const port = new FakePort()
    // 1000 a second, 900 kept for the plugin, a bucket of the cap at the start
    const transport = portTransport(port, limits, () => now)
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

  it('holds messages past 90% of the message rate in the same queue, so a backlog never leaves in a burst', () => {
    vi.useFakeTimers()
    let now = 0
    const port = new FakePort()
    const transport = portTransport(port, { ...limits, messagesPerSecond: 10, bytesPerSecond: 1_000_000 }, () => now)
    for (let i = 0; i < 20; i++) transport.post({ n: i })
    expect(port.posted).toHaveLength(9)
    now = 1000
    vi.advanceTimersByTime(1000)
    expect(port.posted).toHaveLength(18)
    now = 2000
    vi.advanceTimersByTime(1000)
    expect(port.posted.map(text => (JSON.parse(text as string) as { n: number }).n)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('answers a ping at once, ahead of what waits for the budget, so a busy plugin never reads as unresponsive', () => {
    vi.useFakeTimers()
    const port = new FakePort()
    const transport = portTransport(port, limits, () => 0)
    transport.post({ a: 'x'.repeat(cap - 20) })
    transport.post({ b: 'y'.repeat(880) })
    transport.post({ v: 1, kind: 'pong' })
    expect(port.posted.map(text => Object.keys(JSON.parse(text as string))[0])).toEqual(['a', 'v'])
  })

  it('takes lower limits the page sends down, as the relay applies them', () => {
    const port = new FakePort()
    const transport = portTransport(port, limits)
    transport.listen(() => {})
    port.gets({ v: 1, kind: 'limits', limits: { ...limits, resultBytes: 1 } })
    expect(() => transport.post({ t: 'x'.repeat(ENVELOPE_ROOM) })).toThrow('too-large')
    port.gets({ v: 1, kind: 'limits', limits: { ...limits, resultBytes: 0 } })
    expect(() => transport.post({ t: 'x'.repeat(ENVELOPE_ROOM - 20) })).not.toThrow()
  })
})

// The worker's global as runInWorker sees it
function scope() {
  return { onmessage: null as ((event: { data: unknown, ports: readonly unknown[] }) => void) | null }
}

describe('a plugin started in a worker', () => {
  it('waits for the page\'s port message, then runs on that port at its limits', async () => {
    const self = scope()
    let started = false
    runInWorker(definePlugin({ start: () => { started = true } }), self)
    const port = new FakePort()
    self.onmessage?.({ data: { v: 1, kind: 'other' }, ports: [port] })
    self.onmessage?.({ data: { v: 1, kind: 'port', limits }, ports: [] })
    expect(self.onmessage).not.toBeNull()
    self.onmessage?.({ data: { v: 1, kind: 'port', limits }, ports: [port] })
    expect(self.onmessage).toBeNull()
    port.gets(JSON.stringify({ v: 1, kind: 'init', id: 'hello', incarnation: 1, api: 1, deps: {}, lastStop: null, previousVersion: null }))
    await vi.waitFor(() => expect(port.posted).toContain('{"v":1,"kind":"ready"}'))
    expect(started).toBe(true)
  })

  it('stays waiting for a port message without whole positive limits', () => {
    const self = scope()
    runInWorker(definePlugin({ start: () => {} }), self)
    self.onmessage?.({ data: { v: 1, kind: 'port', limits: { ...limits, bytesPerSecond: 0 } }, ports: [new FakePort()] })
    expect(self.onmessage).not.toBeNull()
  })
})
