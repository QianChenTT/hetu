// The worker host page's logic, kept apart from the DOM so it runs in tests. The page hands it real workers and ports
import type { FloorConstant } from '../../api/floor.ts'
import { type Budget, countMessage, newBudget, newRate, type Rate, type RelayLimits, relayLimitsOf, spend, textCap } from '../../api/rate.ts'

export type WorkerLike = {
  postMessage(message: unknown, transfer: unknown[]): void
  terminate(): void
  addEventListener(type: 'error', listener: (event: { preventDefault(): void }) => void): void
}

export type PortLike = {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: unknown, ports: readonly unknown[] }) => void) | null
  onmessageerror: (() => void) | null
  onclose: (() => void) | null
}

// The plugin's limits as the carrier applies them, sent with its start
export type Limits = RelayLimits

export type Report =
  | { kind: 'errors' | 'dropped', id: string, incarnation: number, count: number }
  | { kind: 'cutoff', id: string, incarnation: number, reason: 'malformed' | 'flood' }

export type HostOptions = {
  // Runs first in every worker, in the same script as the plugin's bytes
  prelude: string
  spawn(url: string, name: string): WorkerLike
  // To main, through the preload
  report(report: Report): void
  // A new channel, one end for the worker and one the page keeps
  channel(): { port1: PortLike, port2: PortLike }
  now?: () => number
}

type Running = {
  id: string
  incarnation: number
  worker: WorkerLike
  own: PortLike
  main: PortLike
  limits: Limits
  cap: number
  rate: Rate
  budget: Budget
  errors: number
  dropped: number
}

const key = (id: string, incarnation: number) => `${id}\u0000${incarnation}`

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function startOf(value: unknown): { id: string, incarnation: number, code: Uint8Array, limits: Limits } | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, incarnation, code, limits } = value as Record<string, unknown>
  const checked = relayLimitsOf(limits)
  if (typeof id !== 'string' || !Number.isSafeInteger(incarnation) || (incarnation as number) <= 0) return null
  if (!(code instanceof Uint8Array) || checked === null) return null
  return { id, incarnation: incarnation as number, code, limits: checked }
}

// Starts each worker from the bytes main sent and relays its messages to main, ends it when main says and counts its
// errors. Every message from a worker is checked before main has to read it, since main reads a message whole before
// any check of its own: only text within the cap passes, at the carrier's rate and within the text budget. A worker
// that sends anything else, or floods, is cut off: ended at once, then main is told why. Main's port stays open for
// the carrier to close, so the reason can't be lost to a close that arrives first
export class WorkerHost {
  private readonly running = new Map<string, Running>()
  private readonly prelude: Uint8Array
  private readonly options: HostOptions
  private readonly now: () => number

  constructor(options: HostOptions) {
    this.options = options
    this.now = options.now ?? (() => performance.now())
    this.prelude = new TextEncoder().encode(`${options.prelude}\n`)
  }

  start(given: unknown, main: PortLike | undefined): void {
    if (main === undefined) return
    const start = startOf(given)
    if (start === null || this.running.has(key(start.id, start.incarnation))) {
      main.close()
      return
    }
    const script = new Uint8Array(this.prelude.length + start.code.length)
    script.set(this.prelude)
    script.set(start.code, this.prelude.length)
    const { port1: own, port2: theirs } = this.options.channel()
    const worker = this.options.spawn(`data:text/javascript;base64,${base64(script)}`, start.id)
    const limit = (name: FloorConstant) => start.limits[name as keyof Limits]
    const run: Running = {
      id: start.id, incarnation: start.incarnation, worker, own, main, limits: start.limits, cap: textCap(limit),
      rate: newRate(), budget: newBudget(), errors: 0, dropped: 0,
    }
    worker.addEventListener('error', event => {
      run.errors++
      event.preventDefault()
    })
    own.onmessage = event => this.fromWorker(run, event.data, event.ports.length)
    own.onmessageerror = () => this.cut(run, 'malformed')
    // The worker's end closes when the worker closed itself or died. Main's port closes in turn, which the carrier reads
    // as the plugin crashed, as it did before the relay
    own.onclose = () => {
      if (this.running.get(key(run.id, run.incarnation)) !== run) return
      this.end(run)
      run.main.close()
    }
    main.onmessage = event => {
      if (this.running.get(key(run.id, run.incarnation)) === run) own.postMessage(event.data)
    }
    this.running.set(key(start.id, start.incarnation), run)
    worker.postMessage({ v: 1, kind: 'port', limits: start.limits }, [theirs])
  }

  // The watchdog lowered one of the plugin's limits, which the relay applies from the next message on
  relimit(id: unknown, incarnation: unknown, given: unknown): void {
    if (typeof id !== 'string' || typeof incarnation !== 'number') return
    const run = this.running.get(key(id, incarnation))
    const limits = relayLimitsOf(given)
    if (run === undefined || limits === null) return
    run.limits = limits
    run.cap = textCap(name => limits[name as keyof Limits])
  }

  terminate(id: unknown, incarnation: unknown): void {
    if (typeof id !== 'string' || typeof incarnation !== 'number') return
    const run = this.running.get(key(id, incarnation))
    if (run === undefined) return
    this.end(run)
  }

  // Each worker's errors and drops since the last flush, which the page calls once a second
  flush(): void {
    for (const run of this.running.values()) {
      if (run.errors > 0) this.options.report({ kind: 'errors', id: run.id, incarnation: run.incarnation, count: run.errors })
      if (run.dropped > 0) this.options.report({ kind: 'dropped', id: run.id, incarnation: run.incarnation, count: run.dropped })
      run.errors = 0
      run.dropped = 0
    }
  }

  private fromWorker(run: Running, data: unknown, ports: number): void {
    if (this.running.get(key(run.id, run.incarnation)) !== run) return
    if (typeof data !== 'string' || data.length > run.cap || ports > 0) return this.cut(run, 'malformed')
    const now = this.now()
    const verdict = countMessage(run.rate, now, name => run.limits[name as keyof Limits])
    if (verdict === 'flood') return this.cut(run, 'flood')
    if (verdict === 'drop' || !spend(run.budget, now, data.length, run.limits.textPerSecond, run.cap)) {
      run.dropped++
      return
    }
    run.main.postMessage(data)
  }

  private cut(run: Running, reason: 'malformed' | 'flood'): void {
    if (this.running.get(key(run.id, run.incarnation)) !== run) return
    this.end(run)
    this.options.report({ kind: 'cutoff', id: run.id, incarnation: run.incarnation, reason })
  }

  private end(run: Running): void {
    this.running.delete(key(run.id, run.incarnation))
    run.worker.terminate()
    run.own.onmessage = null
    run.own.onmessageerror = null
    run.own.onclose = null
    run.own.close()
  }
}
