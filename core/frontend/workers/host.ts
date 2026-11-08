// The worker host page's logic, kept apart from the DOM so it runs in tests. The page hands it real workers and ports

export type WorkerLike = {
  postMessage(message: unknown, transfer: unknown[]): void
  terminate(): void
  addEventListener(type: 'error', listener: (event: { preventDefault(): void }) => void): void
}

export type PortLike = { close(): void }

export type Report = { kind: 'errors', id: string, incarnation: number, count: number }

export type HostOptions = {
  // Runs first in every worker, in the same script as the plugin's bytes
  prelude: string
  spawn(url: string, name: string): WorkerLike
  // To main, through the preload
  report(report: Report): void
}

type Running = { id: string, incarnation: number, worker: WorkerLike, errors: number }

const key = (id: string, incarnation: number) => `${id}\u0000${incarnation}`

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function isStart(value: unknown): value is { id: string, incarnation: number, code: Uint8Array } {
  if (typeof value !== 'object' || value === null) return false
  const { id, incarnation, code } = value as Record<string, unknown>
  return typeof id === 'string' && Number.isSafeInteger(incarnation) && (incarnation as number) > 0 && code instanceof Uint8Array
}

// Starts each worker from the bytes main sent, ends it when main says and counts its errors. Nothing else: a worker's
// own messages to the page go unread, since a plugin talks to the core only on its port
export class WorkerHost {
  private readonly running = new Map<string, Running>()
  private readonly prelude: Uint8Array
  private readonly options: HostOptions

  constructor(options: HostOptions) {
    this.options = options
    this.prelude = new TextEncoder().encode(`${options.prelude}\n`)
  }

  start(start: unknown, port: PortLike | undefined): void {
    if (port === undefined) return
    if (!isStart(start) || this.running.has(key(start.id, start.incarnation))) {
      port.close()
      return
    }
    const script = new Uint8Array(this.prelude.length + start.code.length)
    script.set(this.prelude)
    script.set(start.code, this.prelude.length)
    const worker = this.options.spawn(`data:text/javascript;base64,${base64(script)}`, start.id)
    const run: Running = { id: start.id, incarnation: start.incarnation, worker, errors: 0 }
    worker.addEventListener('error', event => {
      run.errors++
      event.preventDefault()
    })
    this.running.set(key(start.id, start.incarnation), run)
    worker.postMessage({ v: 1, kind: 'port' }, [port])
  }

  terminate(id: unknown, incarnation: unknown): void {
    if (typeof id !== 'string' || typeof incarnation !== 'number') return
    const run = this.running.get(key(id, incarnation))
    if (run === undefined) return
    this.running.delete(key(id, incarnation))
    run.worker.terminate()
  }

  // Each worker's errors since the last flush, which the page calls once a second
  flush(): void {
    for (const run of this.running.values()) {
      if (run.errors === 0) continue
      this.options.report({ kind: 'errors', id: run.id, incarnation: run.incarnation, count: run.errors })
      run.errors = 0
    }
  }
}
