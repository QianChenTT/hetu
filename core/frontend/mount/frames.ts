import { plainProblem } from '../../api/plain.ts'
import { MAX_FRAME_MESSAGE } from '../../api/ui.ts'
import { lay } from './layers.ts'
import type { CoreLink } from './link.ts'
import type { Rect } from './drag.ts'

// View frames: a view whose plugin draws it in a frame of its own files, for a canvas or its own framework. Main mints a
// single-use URL on the views host for each mount, served from the bytes the plugin started with. The frame is sandboxed
// with scripts only, so its origin is opaque. It gets a port on its first load and on any later one it is removed and
// main records frame.navigated, so a navigated frame never gets a port. A frame talks only to its own plugin's worker
// through the drawer, plain data as JSON text within the cap at a rate. Frames sit in the lifted layer over their
// slots and are never moved in the DOM, which would load them again

export const FRAME_MESSAGES_PER_SECOND = 100

// Which load a frame is at: the first gets the port, any later one means it navigated
export class FrameLoads {
  private readonly loads = new Map<string, number>()

  started(instance: string): void {
    this.loads.set(instance, 0)
  }

  loaded(instance: string): 'port' | 'navigated' | 'gone' {
    const count = this.loads.get(instance)
    if (count === undefined) return 'gone'
    this.loads.set(instance, count + 1)
    return count === 0 ? 'port' : 'navigated'
  }

  ended(instance: string): void {
    this.loads.delete(instance)
  }
}

// What one frame sends: JSON text of plain data within the cap, at most so many a second. Anything else is dropped
export class FrameInbox {
  private readonly clock: () => number
  private second = { start: Number.NEGATIVE_INFINITY, count: 0 }

  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock
  }

  take(message: unknown): { ok: true, data: unknown } | { ok: false } {
    const now = this.clock()
    if (now - this.second.start >= 1000) this.second = { start: now, count: 0 }
    if (this.second.count >= FRAME_MESSAGES_PER_SECOND) return { ok: false }
    this.second.count++
    if (typeof message !== 'string' || message.length > MAX_FRAME_MESSAGE) return { ok: false }
    let data: unknown
    try {
      data = JSON.parse(message)
    } catch {
      return { ok: false }
    }
    return plainProblem(data, MAX_FRAME_MESSAGE) === null ? { ok: true, data } : { ok: false }
  }
}

type Mounted = { owner: string, frame: string, element: HTMLIFrameElement | null, url: string | null, port: MessagePort | null, inbox: FrameInbox }

export class Frames {
  private readonly link: CoreLink
  private readonly host: HTMLElement
  private readonly relay: (owner: string, instance: string, data: unknown) => void
  private readonly loads = new FrameLoads()
  private readonly mounted = new Map<string, Mounted>()
  private readonly gone: (instance: string) => boolean

  // relay hands what a frame sent to its owner's worker. gone says an instance is closed or its owner down
  constructor(link: CoreLink, host: HTMLElement, relay: (owner: string, instance: string, data: unknown) => void, gone: (instance: string) => boolean) {
    this.link = link
    this.host = host
    this.relay = relay
    this.gone = gone
  }

  // The frame drawing a view instance laid over its slot, mounted on first use, or hidden while no slot holds it
  place(owner: string, instance: string, frame: string, box: Rect | null): void {
    let held = this.mounted.get(instance)
    if (held !== undefined && (held.owner !== owner || held.frame !== frame)) {
      this.remove(instance, false)
      held = undefined
    }
    if (held === undefined) {
      held = { owner, frame, element: null, url: null, port: null, inbox: new FrameInbox() }
      this.mounted.set(instance, held)
      void this.mount(instance, held)
    }
    if (held.element !== null) lay(held.element, box)
  }

  // Frames not placed this time are hidden, and removed once their view closed or went down
  forget(keep: ReadonlySet<string>): void {
    for (const [instance, held] of this.mounted) {
      if (keep.has(instance)) continue
      if (this.gone(instance)) this.remove(instance, false)
      else if (held.element !== null) lay(held.element, null)
    }
  }

  // A message from the owner's worker to its frame, once the frame has its port
  post(owner: string, instance: string, data: unknown): 'not-found' | 'unavailable' | null {
    const held = this.mounted.get(instance)
    if (held === undefined || held.owner !== owner) return 'not-found'
    if (held.port === null) return 'unavailable'
    held.port.postMessage(JSON.stringify(data))
    return null
  }

  remove(instance: string, navigated: boolean): void {
    const held = this.mounted.get(instance)
    if (held === undefined) return
    this.mounted.delete(instance)
    this.loads.ended(instance)
    held.port?.close()
    held.element?.remove()
    if (held.url !== null) void this.link.call('editor.frameGone', { url: held.url, navigated })
  }

  // Every frame, when the page's plugins went
  clear(): void {
    for (const instance of [...this.mounted.keys()]) this.remove(instance, false)
  }

  private async mount(instance: string, held: Mounted): Promise<void> {
    const got = await this.link.call('editor.frame', { plugin: held.owner, frame: held.frame })
    if (!got.ok || this.mounted.get(instance) !== held) return
    const url = (got.result as { url: string }).url
    held.url = url
    const element = document.createElement('iframe')
    element.className = 'hetu-frame'
    // Scripts only: no same origin, no top navigation, no forms, no popups
    element.setAttribute('sandbox', 'allow-scripts')
    element.setAttribute('referrerpolicy', 'no-referrer')
    element.hidden = true
    // The source is set before the frame joins the page, so its first load is its own page and never about:blank
    element.src = url
    element.addEventListener('load', () => this.loaded(instance, held))
    held.element = element
    this.loads.started(instance)
    this.host.append(element)
  }

  private loaded(instance: string, held: Mounted): void {
    if (this.mounted.get(instance) !== held) return
    const load = this.loads.loaded(instance)
    if (load === 'navigated') {
      this.remove(instance, true)
      return
    }
    if (load !== 'port' || held.element?.contentWindow == null) return
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = event => {
      const taken = held.inbox.take(event.data)
      if (taken.ok && this.mounted.get(instance) === held) this.relay(held.owner, instance, taken.data)
    }
    held.port = port1
    held.element.contentWindow.postMessage({ v: 1, kind: 'view' }, '*', [port2])
  }
}
