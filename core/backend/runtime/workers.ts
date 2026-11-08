import type { BrowserWindow, MessagePortMain, Session } from 'electron'
import type { Field } from '../../lib/event-log.ts'
import type { WorkerStart } from '../loader/seams.ts'
import { SCHEME } from './before-ready.ts'
import { webPreferences } from './windows.ts'

export const WORKERS_URL = `${SCHEME}://workers/`

// The hidden renderer as the runtime drives it, faked in the tests
export type Renderer = {
  // To the page's preload, a start with the worker's port
  post(channel: 'hetu:start' | 'hetu:terminate', message: unknown, ports?: MessagePortMain[]): void
  // What the page's own frame sent
  onPage(listener: (message: unknown) => void): void
  // Once, when the renderer's process is gone
  onGone(listener: (reason: string) => void): void
  destroy(): void
}

export type WorkerRendererOptions = {
  open(): Renderer
  // A floor record
  record(event: string, fields: Record<string, Field>): void
  // How long whenReady waits for the page
  readyMs: number
  // How long an ended worker still counts as held for a renderer that dies. Its ports close a few ms before Electron
  // tells the renderer is gone, and the loader ends the plugin on that close
  endingMs?: number
}

type Start = WorkerStart & { port: MessagePortMain }

const key = (id: string, incarnation: number) => `${id}\u0000${incarnation}`

// The first-party hidden renderer that holds the sandboxed plugins' workers. Starts wait until its page says ready, so
// none goes to a page that can't hear it. A renderer that dies is recorded with the plugins it held, whose ports close
// with it, and the next start opens a new one
export class WorkerRenderer {
  private readonly options: WorkerRendererOptions
  private renderer: Renderer | null = null
  private ready = false
  private closed = false
  private queue: Start[] = []
  private readonly running = new Map<string, string>()
  private readonly ending = new Map<string, { id: string, timer: ReturnType<typeof setTimeout> }>()
  private waiters: ((ready: boolean) => void)[] = []

  constructor(options: WorkerRendererOptions) {
    this.options = options
  }

  // Opens the renderer if there is none. True once its page says ready, false once readyMs passed first
  whenReady(): Promise<boolean> {
    this.open()
    if (this.ready) return Promise.resolve(true)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter !== settle)
        this.options.record('renderer.late', { ms: this.options.readyMs })
        resolve(false)
      }, this.options.readyMs)
      const settle = (ready: boolean) => {
        clearTimeout(timer)
        resolve(ready)
      }
      this.waiters.push(settle)
    })
  }

  start(start: WorkerStart): void {
    const port = start.port as MessagePortMain
    if (this.closed) {
      port.close()
      return
    }
    this.open()
    if (!this.ready) {
      this.queue.push({ ...start, port })
      return
    }
    this.send({ ...start, port })
  }

  terminate(id: string, incarnation: number): void {
    const queued = this.queue.find(start => start.id === id && start.incarnation === incarnation)
    if (queued !== undefined) {
      this.queue = this.queue.filter(start => start !== queued)
      queued.port.close()
      return
    }
    const at = key(id, incarnation)
    if (!this.running.delete(at)) return
    const timer = setTimeout(() => this.ending.delete(at), this.options.endingMs ?? 1000)
    timer.unref?.()
    this.ending.set(at, { id, timer })
    this.renderer?.post('hetu:terminate', { id, incarnation })
  }

  // At the end of Quit, once the core has stopped its plugins
  close(): void {
    this.closed = true
    for (const start of this.queue.splice(0)) start.port.close()
    this.renderer?.destroy()
    this.renderer = null
  }

  private open(): void {
    if (this.renderer !== null || this.closed) return
    const renderer = this.options.open()
    this.renderer = renderer
    this.ready = false
    renderer.onPage(message => {
      if (this.renderer === renderer) this.heard(message)
    })
    renderer.onGone(reason => {
      if (this.renderer === renderer) this.gone(reason)
    })
  }

  private send(start: Start): void {
    this.running.set(key(start.id, start.incarnation), start.id)
    this.renderer?.post('hetu:start', { id: start.id, incarnation: start.incarnation, code: start.code }, [start.port])
  }

  private heard(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const { kind, id, incarnation, count } = message as Record<string, unknown>
    if (kind === 'ready' && !this.ready) {
      this.ready = true
      for (const start of this.queue.splice(0)) this.send(start)
      for (const settle of this.waiters.splice(0)) settle(true)
      return
    }
    if (kind !== 'errors' || typeof id !== 'string' || typeof incarnation !== 'number') return
    if (!Number.isSafeInteger(count) || (count as number) <= 0 || !this.running.has(key(id, incarnation))) return
    this.options.record('worker.errors', { plugin: id, incarnation, count: count as number })
  }

  private gone(reason: string): void {
    const plugins = [...new Set([...this.running.values(), ...[...this.ending.values()].map(ended => ended.id)])].sort()
    for (const ended of this.ending.values()) clearTimeout(ended.timer)
    this.ending.clear()
    this.options.record('renderer.gone', { reason, plugins: plugins.join(',') })
    this.running.clear()
    for (const start of this.queue.splice(0)) start.port.close()
    this.renderer = null
    this.ready = false
  }
}

// The hidden window behind a Renderer: the workers session, the page's preload and no throttling, since its workers
// answer heartbeats. Messages count only from the page's own main frame
export function openWorkersRenderer(Window: typeof BrowserWindow, session: Session, preload: string, packaged: boolean): Renderer {
  const window = new Window({
    show: false,
    webPreferences: { ...webPreferences(session, packaged), preload, backgroundThrottling: false },
  })
  const contents = window.webContents
  window.loadURL(WORKERS_URL).catch((err: unknown) => console.error(`the worker host page didn't load: ${String(err)}`))
  return {
    post(channel, message, ports = []) {
      if (!contents.isDestroyed()) contents.postMessage(channel, message, ports)
    },
    onPage(listener) {
      contents.ipc.on('hetu:page', (event, message: unknown) => {
        if (event.senderFrame === contents.mainFrame) listener(message)
      })
    },
    onGone(listener) {
      contents.once('render-process-gone', (_event, details) => listener(details.reason))
    },
    destroy() {
      if (!window.isDestroyed()) window.destroy()
    },
  }
}
