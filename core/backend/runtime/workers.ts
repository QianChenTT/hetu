import type { BrowserWindow, MessagePortMain, Session } from 'electron'
import type { Field } from '../../lib/event-log.ts'
import type { WorkerStart } from './header.ts'
import { SCHEME } from './before-ready.ts'
import { webPreferences } from './windows.ts'

export const WORKERS_URL = `${SCHEME}://workers/`

// The hidden renderer as the runtime drives it, faked in the tests
export type Renderer = {
  // To the page's preload, a start with the worker's port or a port to the editor page's drawer
  post(channel: 'hetu:start' | 'hetu:terminate' | 'hetu:limits' | 'hetu:drawer', message: unknown, ports?: MessagePortMain[]): void
  // What the page's own frame sent
  onPage(listener: (message: unknown) => void): void
  // Once, when the renderer's process is gone
  onGone(listener: (reason: string) => void): void
  destroy(): void
}

export type WorkerRendererOptions = {
  open(): Renderer
  // A core record
  record(event: string, fields: Record<string, Field>): void
  // The limits the page's relay applies to a plugin's messages, sent with its start
  limits(id: string): Readonly<Record<string, number>>
  // The page cut a worker off: it ended the worker and the plugin crashed for reason
  cutoff(id: string, incarnation: number, reason: 'malformed' | 'flood'): void
  // How long an ended worker still counts as held for a renderer that dies. Its ports close a few ms before Electron
  // tells the renderer is gone, and the plugins manager ends the plugin on that close
  endingMs?: number
}

type Start = WorkerStart & { port: MessagePortMain }

const key = (id: string, incarnation: number) => `${id}\u0000${incarnation}`

// A hidden renderer that holds a sandboxed plugin's workers. Starts wait until its page says ready, so
// none goes to a page that can't hear it. A renderer that dies is recorded with the plugins it held, whose ports close
// with it, and the next start opens a new one
export class WorkerRenderer {
  private readonly options: WorkerRendererOptions
  private renderer: Renderer | null = null
  private ready = false
  private closed = false
  private queue: Start[] = []
  // Drawer ports for starts still queued, sent right after their start
  private readonly waiting = new Map<string, MessagePortMain>()
  private readonly running = new Map<string, { id: string, incarnation: number }>()
  private readonly ending = new Map<string, { id: string, timer: ReturnType<typeof setTimeout> }>()

  constructor(options: WorkerRendererOptions) {
    this.options = options
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
      this.waiting.get(key(id, incarnation))?.close()
      this.waiting.delete(key(id, incarnation))
      return
    }
    const at = key(id, incarnation)
    if (!this.running.delete(at)) return
    const timer = setTimeout(() => this.ending.delete(at), this.options.endingMs ?? 1000)
    timer.unref?.()
    this.ending.set(at, { id, timer })
    this.renderer?.post('hetu:terminate', { id, incarnation })
  }

  // A port to the editor page's drawer for a worker: to its page with the worker named, after its start when that still
  // waits, and closed for a worker not here
  drawer(id: string, incarnation: number, port: MessagePortMain): void {
    const at = key(id, incarnation)
    if (!this.closed && this.running.has(at)) {
      this.renderer?.post('hetu:drawer', { id, incarnation }, [port])
      return
    }
    if (!this.closed && this.queue.some(start => start.id === id && start.incarnation === incarnation)) {
      this.waiting.get(at)?.close()
      this.waiting.set(at, port)
      return
    }
    port.close()
  }

  // Nothing running and nothing waiting to start
  empty(): boolean {
    return this.running.size === 0 && this.queue.length === 0
  }

  // At the end of Quit, once the core has stopped its plugins
  close(): void {
    this.closed = true
    for (const start of this.queue.splice(0)) start.port.close()
    this.closeWaiting()
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

  // The human set one of the plugin's constants, so each of its running workers' relays gets them again
  limited(id: string): void {
    for (const run of this.running.values()) {
      if (run.id === id) this.renderer?.post('hetu:limits', { id, incarnation: run.incarnation, limits: this.options.limits(id) })
    }
  }

  private send(start: Start): void {
    this.running.set(key(start.id, start.incarnation), { id: start.id, incarnation: start.incarnation })
    const limits = this.options.limits(start.id)
    this.renderer?.post('hetu:start', { id: start.id, incarnation: start.incarnation, code: start.code, limits }, [start.port])
    const at = key(start.id, start.incarnation)
    const drawer = this.waiting.get(at)
    this.waiting.delete(at)
    if (drawer !== undefined) this.renderer?.post('hetu:drawer', { id: start.id, incarnation: start.incarnation }, [drawer])
  }

  private closeWaiting(): void {
    for (const port of this.waiting.values()) port.close()
    this.waiting.clear()
  }

  private heard(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const { kind, id, incarnation, reason } = message as Record<string, unknown>
    if (kind === 'ready' && !this.ready) {
      this.ready = true
      for (const start of this.queue.splice(0)) this.send(start)
      return
    }
    if (typeof id !== 'string' || typeof incarnation !== 'number') return
    // The page already ended the worker, so the plugins manager's end that follows has nothing to send
    if (kind === 'cutoff' && (reason === 'malformed' || reason === 'flood') && this.running.delete(key(id, incarnation))) {
      this.options.cutoff(id, incarnation, reason)
    }
  }

  private gone(reason: string): void {
    const held = [...this.running.values()].map(run => run.id)
    const plugins = [...new Set([...held, ...[...this.ending.values()].map(ended => ended.id)])].sort()
    for (const ended of this.ending.values()) clearTimeout(ended.timer)
    this.ending.clear()
    this.options.record('renderer.gone', { reason, plugins: plugins.join(',') })
    this.running.clear()
    for (const start of this.queue.splice(0)) start.port.close()
    this.closeWaiting()
    // Its window stays until destroyed, so a run that loses renderers doesn't gather dead hidden windows
    this.renderer?.destroy()
    this.renderer = null
    this.ready = false
  }
}

// The hidden window behind a Renderer: the workers session, the page's preload and no throttling, since its workers
// answer heartbeats. Messages count only from the page's own main frame
export function openWorkersRenderer(
  Window: typeof BrowserWindow,
  session: Session,
  preload: string,
  packaged: boolean,
  plugin: string,
): Renderer {
  const window = new Window({
    show: false,
    webPreferences: { ...webPreferences(session, packaged), preload, backgroundThrottling: false },
  })
  const contents = window.webContents
  // The plugin in the URL tells the windows apart, for the tests and for a human looking at them
  window.loadURL(`${WORKERS_URL}?for=${encodeURIComponent(plugin)}`).catch((err: unknown) => console.error(`the worker host page didn't load: ${String(err)}`))
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

// The hidden renderers, one per plugin, so a plugin that floods or exhausts its renderer takes no other plugin down with
// it (decision 20). Each is opened when the plugin's first worker starts and closes a moment after it holds nothing,
// which a stop, a crash or a cutoff leaves, so a run doesn't keep one for every plugin it ever started. The moment lets
// a renderer whose death ended its plugin still be recorded, since its ports close and the plugins manager ends the
// plugin a few ms before Electron tells the renderer is gone. About 70 MB each while it runs
export class WorkerRenderers {
  private readonly make: (plugin: string) => WorkerRenderer
  private readonly idleMs: number
  private readonly renderers = new Map<string, WorkerRenderer>()
  private readonly closing = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(make: (plugin: string) => WorkerRenderer, idleMs = 1000) {
    this.make = make
    this.idleMs = idleMs
  }

  start(start: WorkerStart): void {
    const plugin = start.id
    clearTimeout(this.closing.get(plugin))
    this.closing.delete(plugin)
    let workers = this.renderers.get(plugin)
    if (workers === undefined) {
      workers = this.make(plugin)
      this.renderers.set(plugin, workers)
    }
    workers.start(start)
  }

  terminate(plugin: string, incarnation: number): void {
    const workers = this.renderers.get(plugin)
    if (workers === undefined) return
    workers.terminate(plugin, incarnation)
    if (!workers.empty() || this.closing.has(plugin)) return
    const timer = setTimeout(() => {
      this.closing.delete(plugin)
      if (this.renderers.get(plugin) !== workers || !workers.empty()) return
      workers.close()
      this.renderers.delete(plugin)
    }, this.idleMs)
    timer.unref?.()
    this.closing.set(plugin, timer)
  }

  limited(id: string): void {
    this.renderers.get(id)?.limited(id)
  }

  drawer(id: string, incarnation: number, port: MessagePortMain): void {
    const workers = this.renderers.get(id)
    if (workers === undefined) port.close()
    else workers.drawer(id, incarnation, port)
  }

  close(): void {
    for (const timer of this.closing.values()) clearTimeout(timer)
    this.closing.clear()
    for (const workers of this.renderers.values()) workers.close()
    this.renderers.clear()
  }
}
