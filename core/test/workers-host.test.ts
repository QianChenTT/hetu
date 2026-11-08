import { describe, expect, it } from 'vitest'
import { WorkerHost, type Report } from '../frontend/workers/host.ts'

// A worker as the page sees one: what it was started from, what it was sent and whether it was ended
class FakeWorker {
  posted: { message: unknown, transfer: unknown[] }[] = []
  ended = false
  private readonly listeners: ((event: { preventDefault(): void }) => void)[] = []

  readonly url: string
  readonly name: string

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

class FakePort {
  closed = false
  close(): void {
    this.closed = true
  }
}

function host() {
  const workers: FakeWorker[] = []
  const reports: Report[] = []
  const page = new WorkerHost({
    prelude: 'delete globalThis.Worker',
    spawn: (url, name) => {
      const worker = new FakeWorker(url, name)
      workers.push(worker)
      return worker
    },
    report: report => reports.push(report),
  })
  return { page, workers, reports }
}

const start = (id = 'search', incarnation = 1, text = 'run()') => ({ id, incarnation, code: new TextEncoder().encode(text) })

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

  it('hands the worker its port and nothing else', () => {
    const { page, workers } = host()
    const port = new FakePort()
    page.start(start(), port)
    expect(workers[0].posted).toEqual([{ message: { v: 1, kind: 'port' }, transfer: [port] }])
  })

  it('ends the worker of the incarnation named and no other', () => {
    const { page, workers } = host()
    page.start(start('search', 1), new FakePort())
    page.start(start('git', 1), new FakePort())
    page.terminate('search', 2)
    expect(workers.map(worker => worker.ended)).toEqual([false, false])
    page.terminate('search', 1)
    expect(workers.map(worker => worker.ended)).toEqual([true, false])
    page.terminate('search', 1)
    expect(workers[0].ended).toBe(true)
  })

  it('refuses a second start of a running incarnation and closes its port', () => {
    const { page, workers } = host()
    page.start(start('search', 1), new FakePort())
    const second = new FakePort()
    page.start(start('search', 1), second)
    expect(workers).toHaveLength(1)
    expect(second.closed).toBe(true)
  })

  it('refuses a start that isn\'t { id, incarnation, code } with one port', () => {
    const { page, workers } = host()
    const port = new FakePort()
    for (const bad of [null, {}, { id: 5, incarnation: 1, code: new Uint8Array() }, { id: 'search', incarnation: 0, code: new Uint8Array() },
      { id: 'search', incarnation: 1, code: 'run()' }, { id: 'search', incarnation: 1.5, code: new Uint8Array() }]) {
      page.start(bad, port)
    }
    page.start(start(), undefined)
    expect(workers).toHaveLength(0)
    expect(port.closed).toBe(true)
  })

  it('counts each worker\'s errors and reports them only when flushed, once each second', () => {
    const { page, workers, reports } = host()
    page.start(start('search', 1), new FakePort())
    page.start(start('git', 3), new FakePort())
    workers[0].fail()
    workers[0].fail()
    workers[1].fail()
    expect(reports).toEqual([])
    page.flush()
    expect(reports).toEqual([
      { kind: 'errors', id: 'search', incarnation: 1, count: 2 },
      { kind: 'errors', id: 'git', incarnation: 3, count: 1 },
    ])
    page.flush()
    expect(reports).toHaveLength(2)
  })

  it('drops the error count of a worker it ended', () => {
    const { page, workers, reports } = host()
    page.start(start(), new FakePort())
    workers[0].fail()
    page.terminate('search', 1)
    page.flush()
    expect(reports).toEqual([])
  })
})
