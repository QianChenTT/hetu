import { describe, expect, it } from 'vitest'
import { ENVELOPE_ROOM } from '../api/rate.ts'
import { type Limits, type PortLike, type Report, WorkerHost } from '../frontend/workers/host.ts'

// A worker as the page sees one: what it was started from, what it was sent and whether it was ended
class FakeWorker {
  posted: { message: unknown, transfer: unknown[] }[] = []
  ended = false
  readonly url: string
  readonly name: string
  private readonly listeners: ((event: { preventDefault(): void }) => void)[] = []

  constructor(url: string, name: string) {
    this.url = url
    this.name = name
  }

  postMessage(message: unknown, transfer: unknown[]): void {
    this.posted.push({ message, transfer })
  }

  terminate(): void {
    this.ended = true
  }

  addEventListener(_type: 'error', listener: (event: { preventDefault(): void }) => void): void {
    this.listeners.push(listener)
  }

  fail(): void {
    for (const listener of this.listeners) listener({ preventDefault() {} })
  }
}

class FakePort implements PortLike {
  posted: unknown[] = []
  closed = false
  onmessage: ((event: { data: unknown, ports: readonly unknown[] }) => void) | null = null
  onmessageerror: (() => void) | null = null
  onclose: (() => void) | null = null

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  close(): void {
    this.closed = true
  }

  // A message arriving on this end
  gets(data: unknown, ports: unknown[] = []): void {
    this.onmessage?.({ data, ports })
  }
}

const limits: Limits = { messagesPerSecond: 3, floodFactor: 2, floodMs: 2000, textPerSecond: 100, resultBytes: 50 }
const cap = limits.resultBytes + ENVELOPE_ROOM

function host() {
  const workers: FakeWorker[] = []
  const inner: { port1: FakePort, port2: FakePort }[] = []
  const reports: Report[] = []
  let time = 0
  const page = new WorkerHost({
    prelude: 'delete globalThis.Worker',
    spawn: (url, name) => {
      const worker = new FakeWorker(url, name)
      workers.push(worker)
      return worker
    },
    report: report => reports.push(report),
    channel: () => {
      const made = { port1: new FakePort(), port2: new FakePort() }
      inner.push(made)
      return made
    },
    now: () => time,
  })
  return { page, workers, inner, reports, at: (ms: number) => { time = ms } }
}

const start = (id = 'search', incarnation = 1, text = 'run()', over: Partial<Limits> = {}) =>
  ({ id, incarnation, code: new TextEncoder().encode(text), limits: { ...limits, ...over } })

// A started worker: the page's end of its channel, main's port and the worker
function running(over: Partial<Limits> = {}) {
  const parts = host()
  const main = new FakePort()
  parts.page.start(start('search', 1, 'run()', over), main)
  return { ...parts, main, worker: parts.workers[0], own: parts.inner[0].port1, theirs: parts.inner[0].port2 }
}

function script(url: string): string {
  const prefix = 'data:text/javascript;base64,'
  expect(url.startsWith(prefix)).toBe(true)
  return Buffer.from(url.slice(prefix.length), 'base64').toString('utf8')
}

describe('the worker host page', () => {
  it('starts a worker from one data: script, the prelude first and then the bytes it was given', () => {
    const { page, workers } = host()
    page.start(start('search', 1, 'run("héllo")'), new FakePort())
    expect(workers).toHaveLength(1)
    expect(script(workers[0].url)).toBe('delete globalThis.Worker\nrun("héllo")')
    expect(workers[0].name).toBe('search')
  })

  it('hands the worker its end of a channel the page made, never main\'s port', () => {
    const { worker, theirs, main } = running()
    expect(worker.posted).toEqual([{ message: { v: 1, kind: 'port', limits }, transfer: [theirs] }])
    expect(worker.posted[0].transfer).not.toContain(main)
  })

  it('passes main\'s messages to the worker and the worker\'s text to main, each as it came', () => {
    const { main, own } = running()
    main.gets('{"v":1,"kind":"init"}')
    expect(own.posted).toEqual(['{"v":1,"kind":"init"}'])
    own.gets('{"v":1,"kind":"ready"}')
    expect(main.posted).toEqual(['{"v":1,"kind":"ready"}'])
  })

  it.each([
    ['an object', { v: 1, kind: 'ready' }],
    ['a number', 5],
    ['text past the cap', 'x'.repeat(cap + 1)],
  ])('cuts a worker off at once for %s, ending it before it tells main', (_name, data) => {
    const { worker, own, main, reports } = running()
    own.gets(data)
    expect(worker.ended).toBe(true)
    expect(own.closed).toBe(true)
    expect(reports).toEqual([{ kind: 'cutoff', id: 'search', incarnation: 1, reason: 'malformed' }])
    expect(main.posted).toEqual([])
    // main's port is the carrier's to close, so the reason reaches main first
    expect(main.closed).toBe(false)
    own.gets('{"v":1,"kind":"ready"}')
    expect(main.posted).toEqual([])
  })

  it('cuts a worker off for text of the cap that carries a port, or a message it couldn\'t read', () => {
    const carried = running()
    carried.own.gets('{"v":1}', [new FakePort()])
    expect(carried.reports).toEqual([{ kind: 'cutoff', id: 'search', incarnation: 1, reason: 'malformed' }])
    const unread = running()
    unread.own.onmessageerror?.()
    expect(unread.reports).toEqual([{ kind: 'cutoff', id: 'search', incarnation: 1, reason: 'malformed' }])
    const fits = running()
    fits.own.gets('x'.repeat(cap))
    expect(fits.reports).toEqual([])
  })

  it('closes main\'s port when the worker\'s end closes, as when it closed itself, so main reads it as crashed', () => {
    const { own, main, worker, page, reports } = running()
    own.onclose?.()
    expect(main.closed).toBe(true)
    expect(worker.ended).toBe(true)
    expect(reports).toEqual([])
    page.terminate('search', 1)
    expect(main.posted).toEqual([])
  })

  it('drops a message over the rate and counts it, as the carrier does', () => {
    const { own, main, page, reports, at } = running()
    at(1000)
    for (let i = 0; i < 4; i++) own.gets(`m${i}`)
    expect(main.posted).toEqual(['m0', 'm1', 'm2'])
    at(2000)
    own.gets('m4')
    expect(main.posted.at(-1)).toBe('m4')
    page.flush()
    expect(reports).toEqual([{ kind: 'dropped', id: 'search', incarnation: 1, count: 1 }])
  })

  it('drops text over the budget, after one message of the cap went through at once', () => {
    const { own, main, at } = running({ textPerSecond: 10, resultBytes: 1 })
    at(0)
    own.gets('x'.repeat(1 + ENVELOPE_ROOM))
    own.gets('y')
    expect(main.posted).toHaveLength(1)
    at(100)
    own.gets('z')
    expect(main.posted.at(-1)).toBe('z')
  })

  it('cuts a worker off at the flood cap, the carrier\'s rule: floodFactor times the rate across floodMs', () => {
    const { own, reports, worker, at } = running()
    at(0)
    // 3 a second times 2 across 2 s is 12
    for (let i = 0; i < 12; i++) own.gets('m')
    expect(worker.ended).toBe(false)
    own.gets('m')
    expect(worker.ended).toBe(true)
    expect(reports).toEqual([{ kind: 'cutoff', id: 'search', incarnation: 1, reason: 'flood' }])
  })

  it('refuses a start without whole positive limits and closes main\'s port', () => {
    const { page, workers } = host()
    for (const bad of [{ ...limits, floodMs: 0 }, { ...limits, textPerSecond: 1.5 }, { messagesPerSecond: 3 }, null]) {
      const main = new FakePort()
      page.start({ ...start(), limits: bad }, main)
      expect(main.closed).toBe(true)
    }
    expect(workers).toHaveLength(0)
  })

  it('ends the worker of the incarnation named and no other', () => {
    const { page, workers } = host()
    page.start(start('search', 1), new FakePort())
    page.start(start('git', 1), new FakePort())
    page.terminate('search', 2)
    expect(workers.map(worker => worker.ended)).toEqual([false, false])
    page.terminate('search', 1)
    expect(workers.map(worker => worker.ended)).toEqual([true, false])
  })

  it('refuses a second start of a running incarnation and closes its port', () => {
    const { page, workers } = host()
    page.start(start('search', 1), new FakePort())
    const second = new FakePort()
    page.start(start('search', 1), second)
    expect(workers).toHaveLength(1)
    expect(second.closed).toBe(true)
  })

  it('refuses a start that isn\'t { id, incarnation, code, limits } with a port', () => {
    const { page, workers } = host()
    const port = new FakePort()
    for (const bad of [null, {}, { ...start(), id: 5 }, { ...start(), incarnation: 0 }, { ...start(), code: 'run()' },
      { ...start(), incarnation: 1.5 }]) {
      page.start(bad, port)
    }
    page.start(start(), undefined)
    expect(workers).toHaveLength(0)
    expect(port.closed).toBe(true)
  })

  it('reports each worker\'s errors once flushed, and nothing for a worker it ended', () => {
    const { page, workers, reports } = host()
    page.start(start('search', 1), new FakePort())
    page.start(start('git', 3), new FakePort())
    workers[0].fail()
    workers[0].fail()
    workers[1].fail()
    page.flush()
    expect(reports).toEqual([
      { kind: 'errors', id: 'search', incarnation: 1, count: 2 },
      { kind: 'errors', id: 'git', incarnation: 3, count: 1 },
    ])
    page.flush()
    expect(reports).toHaveLength(2)
    workers[1].fail()
    page.terminate('git', 3)
    page.flush()
    expect(reports).toHaveLength(2)
  })
})
