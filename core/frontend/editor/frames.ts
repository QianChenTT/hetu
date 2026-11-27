import { ticketUrlOf } from '../../api/ids.ts'
import { dragTokenOf, type FrameAsks, FrameInbox, frameAsks, OpenCredit } from '../../api/ui-limits.ts'
import { lay } from './layers.ts'
import type { CoreLink } from './link.ts'
import type { Rect } from './drag.ts'

// View frames: a view whose plugin draws it in a frame of its own files, for a canvas or its own framework. Main mints
// a single-use URL on the plugin's own host for each mount, served from the bytes the plugin started with, and the
// frame's src is that URL as main answered it, so each plugin's frames get a renderer of their own. The frame is
// sandboxed with scripts only, so its origin is opaque. It gets a port on its first load and on any later one it is
// removed and main records frame.navigated, so a navigated frame never gets a port. A frame talks only to its own
// plugin's worker through the drawer, plain data as JSON text within the cap at a rate. Frames sit in the lifted layer
// over their slots and are never moved in the DOM, which would load them again. Focus goes into a frame when the human
// presses in it, as main tells the page of every press. A frame's own focus does nothing without the human's activation
// in it, by the focus-without-user-activation policy. A frame that takes focus any other way, within the 5 s an
// activation lasts, is pulled back to the note once the move ends. Main drops each key headed for a frame other than
// the one the page told it it let in, so the frame hears none of what the human types meanwhile. hetu's theme is
// offered to every frame as the page sets it, never checked or forced on one. A frame may ask hetu to open a note,
// which is the human's only right after the human pressed in one of its plugin's frames, one open each press, and else
// the plugin's own. A note dragged out of a frame carries a token main minted for its plugin and note, and dropped on
// the editor it opens as the human's once main answers the token

// How long after a press, or the core's own move, focus may still go into that frame
export const FOCUS_GRACE_MS = 500
// While a frame holds focus the page hears nothing when another frame takes it, so it looks again this often
export const FOCUS_WATCH_MS = 50
// How long a frame that took focus with no press seen is held before it counts as taken, as long as main's push of a
// press may come after the move it caused. Unrelated to FOCUS_WATCH_MS, the two only happen to be the same
export const FOCUS_HOLD_MS = 50

// Who put focus in a frame: the human by a press that landed in it or the core by its own move, each counted for one
// move into that frame and only for a short while. Any other move into a frame is the frame's own
export class FocusGuard {
  private readonly clock: () => number
  private allowed: { instance: string, at: number } | null = null
  // The frame let in last, while focus stays in it
  private holder: string | null = null
  // The frame holding focus with no press seen and since when frames held it so, until focus leaves every frame or one
  // is let in. -Infinity once judged taken
  private onHold: { instance: string, at: number } | null = null

  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock
  }

  // A press landed in this frame, or on the page's own elements with null, or the core is moving focus there itself.
  // A frame holding focus keeps it only through a press in it, since the page may not see focus leave and come back
  allow(instance: string | null): void {
    this.allowed = instance === null ? null : { instance, at: this.clock() }
    if (instance !== this.holder) this.holder = null
  }

  // Focus is in this frame now: true when it was let in already or just allowed. A press credit for another frame stays
  // for that frame, which focus may not have reached yet
  entered(instance: string): boolean {
    const allowed = this.allowed
    if (allowed?.instance === instance) this.allowed = null
    if (this.holder === instance) return true
    const ok = allowed?.instance === instance && this.clock() - allowed.at <= FOCUS_GRACE_MS
    this.holder = ok ? instance : null
    return ok
  }

  // Focus is in this frame now, with no press of its own seen yet: in when let in, wait while main's push of the press
  // that put it there could still be on its way and taken once that time is over. Taken at once for a frame already
  // judged taken and with atOnce, as for a key main dropped, which comes after every press main pushed before it. Main
  // drops the keys headed for the frame meanwhile, so the wait leaks none
  judge(instance: string, atOnce = false): 'in' | 'wait' | 'taken' {
    if (this.entered(instance)) {
      this.onHold = null
      return 'in'
    }
    // A move from one frame on hold to another keeps the hold's start, so frames taking turns never hold off the verdict
    if (this.onHold === null) this.onHold = { instance, at: this.clock() }
    else this.onHold.instance = instance
    if (atOnce) this.onHold.at = -Infinity
    if (this.clock() - this.onHold.at < FOCUS_HOLD_MS) return 'wait'
    this.onHold.at = -Infinity
    return 'taken'
  }

  // Whether focus is in this frame, let in
  holding(instance: string): boolean {
    return this.holder === instance
  }

  // The frame let in, while focus stays in it, null for none
  letIn(): string | null {
    return this.holder
  }

  // Focus is in the page's own document again. A press credit not yet used goes with it
  left(): void {
    this.holder = null
    this.allowed = null
    this.onHold = null
  }
}

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

// A view frame's element, hidden until laid out. The source is set last, after every attribute the frame's first load
// reads and before the frame joins the page, so its first load is its own page and never about:blank
export function createFrameElement(page: Document, url: string): HTMLIFrameElement {
  const element = page.createElement('iframe')
  element.className = 'hetu-frame'
  // Scripts only: no same origin, no top navigation, no forms, no popups
  element.setAttribute('sandbox', 'allow-scripts')
  element.setAttribute('referrerpolicy', 'no-referrer')
  // Its focus(), window.focus(), showModal(), select() and the rest do nothing without the human's activation in it,
  // with the Blink feature main turns on, so it can't take focus or an IME composition from the note
  element.setAttribute('allow', "focus-without-user-activation 'none'")
  element.hidden = true
  // Tab never moves into a frame, which no press would have let in
  element.tabIndex = -1
  element.src = url
  return element
}

type Mounted = {
  owner: string
  frame: string
  element: HTMLIFrameElement | null
  box: Rect | null
  url: string | null
  port: MessagePort | null
  inbox: FrameInbox
  asks: FrameAsks
}

export class Frames {
  private readonly link: CoreLink
  private readonly host: HTMLElement
  private readonly relay: (owner: string, instance: string, data: unknown) => void
  private readonly loads = new FrameLoads()
  private readonly mounted = new Map<string, Mounted>()
  private readonly gone: (instance: string) => boolean
  private readonly guard = new FocusGuard()
  private readonly credit = new OpenCredit(() => performance.now())
  private checking = false
  private watch: ReturnType<typeof setInterval> | null = null
  // The look at the end of a frame's hold
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  // The frame caught taking focus and not yet out of it, told once
  private caught: string | null = null
  // Told the URL main served the frame from that focus was let into, null once focus is in no frame let in, so main
  // drops a key headed for any other frame before the page sees that frame take focus
  onLetIn: ((url: string | null) => void) | null = null
  // The URL main was told last
  private lastTold: string | null = null
  // Told the URL main served the frame from when it took focus on its own, so the page gives it back to the note.
  // again says the same frame still holds it from a theft already told
  onTheft: ((url: string, again: boolean) => void) | null = null
  // Told a note to open for owner: human for one a frame of owner's asked right after the human's press in one of them,
  // or a note dragged out of one, else the plugin's own open. dropped says it was dragged, so it opens only where the
  // luoshu resolves it inside owner's read
  onOpen: ((owner: string, path: string, human: boolean, dropped: boolean) => void) | null = null
  // The theme's variables as last offered to the frames
  private variables: Readonly<Record<string, string>> = {}
  // The theme main last took, as JSON, so one main refused is sent again with the next offer
  private offered: string | null = null

  // relay hands what a frame sent to its owner's worker. gone says an instance is closed or its owner down
  constructor(link: CoreLink, host: HTMLElement, relay: (owner: string, instance: string, data: unknown) => void, gone: (instance: string) => boolean) {
    this.link = link
    this.host = host
    this.relay = relay
    this.gone = gone
    // Drops anywhere in the window holding the frames. A drag lands on the empty stage too, and its text never lands in
    // a note
    const page = host.ownerDocument?.defaultView
    page?.addEventListener('dragover', event => {
      if (event.target instanceof Element && event.target.closest('#empty') !== null) event.preventDefault()
    }, true)
    page?.addEventListener('drop', event => void this.dropped(event), true)
  }

  // The theme's variables as the page draws with them, to each frame with its port and to each holding one when they
  // change, as an object so no text a worker sends reads as one. Main gets them for the stylesheet at the root of each
  // frame's ticket until it takes them
  theme(variables: Readonly<Record<string, string>>): void {
    const text = JSON.stringify(variables)
    if (text !== JSON.stringify(this.variables)) {
      this.variables = variables
      for (const held of this.mounted.values()) held.port?.postMessage({ v: 1, kind: 'theme', variables })
    }
    if (text === this.offered) return
    void this.link.call('editor.theme', { variables }).then(got => {
      if (got.ok) this.offered = text
    })
  }

  // The frame drawing a view instance laid over its slot, mounted on first use, or hidden while no slot holds it
  place(owner: string, instance: string, frame: string, box: Rect | null): void {
    let held = this.mounted.get(instance)
    if (held !== undefined && (held.owner !== owner || held.frame !== frame)) {
      this.remove(instance, false)
      held = undefined
    }
    if (held === undefined) {
      held = { owner, frame, element: null, box: null, url: null, port: null, inbox: new FrameInbox(() => performance.now()), asks: frameAsks(() => performance.now()) }
      this.mounted.set(instance, held)
      void this.mount(instance, held)
    }
    held.box = box
    this.lay(held)
  }

  // A press main pushed: down or up at its point on the page, or Enter in the focused frame served from url,
  // counted only while focus is in it by a press or the core's own move
  pushed(press: unknown): void {
    const { down, x, y, key, url } = (typeof press === 'object' && press !== null ? press : {}) as Record<string, unknown>
    const instance = key === true && typeof url === 'string' ? this.instanceAt(url) : null
    const owner = instance === null ? undefined : this.mounted.get(instance)?.owner
    if (instance !== null && owner !== undefined && this.guard.holding(instance)) this.credit.keyed(owner)
    if (typeof x !== 'number' || typeof y !== 'number') return
    if (down === true) this.pressed(x, y)
    else if (down === false) this.released(x, y)
  }

  // Main's word that the human pressed at this point of the page, in a frame or not. The frame drawn there may take
  // focus from it, and its plugin's frames may open a note as the human's
  private pressed(x: number, y: number): void {
    const found = this.at(document.elementFromPoint(x, y))
    this.guard.allow(found?.[0] ?? null)
    this.credit.pressed(found?.[1].owner ?? null)
    this.reportLetIn()
  }

  // Main's word that the human let go of a press at this point of the page
  private released(x: number, y: number): void {
    this.credit.released(this.at(document.elementFromPoint(x, y))?.[1].owner ?? null)
  }

  // Focus moved, in the page or into a frame. It is checked once the move is done, since focus pulled back while the
  // move still runs is moved on again by it
  focusMoved(): void {
    if (this.checking) return
    this.checking = true
    setTimeout(() => {
      this.checking = false
      this.check()
    }, 0)
  }

  // atOnce judges a frame holding focus with no press seen at once, with no hold
  private check(atOnce = false): void {
    const found = this.at(document.activeElement)
    if (found === null) {
      this.guard.left()
      this.reportLetIn()
      this.caught = null
      this.watching(false)
      return
    }
    const [instance, held] = found
    const verdict = this.guard.judge(instance, atOnce)
    this.reportLetIn()
    if (verdict === 'in') {
      this.caught = null
      this.watching(true)
      return
    }
    if (verdict === 'wait') {
      this.lookAtHoldEnd()
      return
    }
    const again = this.caught === instance
    this.caught = instance
    // TODO: decide what a plugin caught taking focus gets (stop it, a notice), only pulled back for now
    if (held.url !== null) this.onTheft?.(held.url, again)
    // With no note shown to take focus back, the frame lets go of it to the page itself
    if (held.element !== null && document.activeElement === held.element) held.element.blur()
    // A frame that keeps focus all the same is looked at again
    this.watching(true)
  }

  // Main dropped a key headed for the frame holding focus, which the page didn't let in. Focus is taken back at once,
  // not once the page sees the move, so a composition that key started follows focus to the note
  keyDropped(): void {
    if (this.at(document.activeElement) !== null) this.check(true)
  }

  // Looks once more when a frame's hold ends
  private lookAtHoldEnd(): void {
    if (this.holdTimer !== null) return
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      this.check()
    }, FOCUS_HOLD_MS + 1)
  }

  // The core moving focus into a frame itself, which the guard lets in
  focusFrame(instance: string): void {
    const element = this.mounted.get(instance)?.element
    if (element === null || element === undefined) return
    this.guard.allow(instance)
    element.focus()
  }

  // Main told the frame focus is let into whenever it changed
  private reportLetIn(): void {
    const instance = this.guard.letIn()
    const url = instance === null ? null : this.mounted.get(instance)?.url ?? null
    if (url === this.lastTold) return
    this.lastTold = url
    this.onLetIn?.(url)
  }

  private watching(on: boolean): void {
    if (on && this.watch === null) this.watch = setInterval(() => this.check(), FOCUS_WATCH_MS)
    if (!on && this.watch !== null) {
      clearInterval(this.watch)
      this.watch = null
    }
  }

  // The instance whose frame main served under the ticket of this URL, which a frame moving within its own page by
  // hash or history keeps, as main matches it
  instanceAt(url: string): string | null {
    const ticket = ticketUrlOf(url)
    if (ticket === null) return null
    for (const [instance, held] of this.mounted) if (ticketUrlOf(held.url) === ticket) return instance
    return null
  }

  // The frame that is this element, with its instance
  private at(element: Element | null): [string, Mounted] | null {
    for (const entry of this.mounted) if (element !== null && entry[1].element === element) return entry
    return null
  }

  private lay(held: Mounted): void {
    if (held.element !== null) lay(held.element, held.box)
  }

  // Frames not placed this time are hidden, and removed once their view closed or went down
  forget(keep: ReadonlySet<string>): void {
    for (const [instance, held] of this.mounted) {
      if (keep.has(instance)) continue
      if (this.gone(instance)) this.remove(instance, false)
      else {
        held.box = null
        this.lay(held)
      }
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
    this.credit.forget(held.owner)
    held.port?.close()
    held.element?.remove()
    // A frame holding focus as it goes holds it no longer, so a later frame given the same instance isn't let in by it
    if (this.guard.letIn() === instance) this.guard.left()
    this.reportLetIn()
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
    const element = createFrameElement(document, url)
    element.dataset.hetuView = instance
    element.dataset.hetuOwner = held.owner
    element.addEventListener('load', () => this.loaded(instance, held))
    held.element = element
    this.loads.started(instance)
    this.host.append(element)
    this.lay(held)
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
      if (typeof event.data !== 'string') {
        this.asked(instance, held, event.data)
        return
      }
      const taken = held.inbox.take(event.data)
      if (taken.ok && this.mounted.get(instance) === held) this.relay(held.owner, instance, taken.data)
    }
    held.port = port1
    // '*' is the only target a frame sandboxed to scripts alone accepts, since its origin is opaque. The port goes only
    // on the first load of the single-use path main served, and a frame that navigates after it is removed with no port
    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
    held.element.contentWindow.postMessage({ v: 1, kind: 'view', variables: this.variables }, '*', [port2])
  }

  // What a frame asked of hetu itself. An open is the human's only on their press in a frame of its plugin's
  private asked(instance: string, held: Mounted, message: unknown): void {
    const taken = held.asks(message)
    if (taken === null || this.mounted.get(instance) !== held) return
    const { ask } = taken
    if (ask.kind === 'open') {
      if (taken.ok) this.onOpen?.(held.owner, ask.path, this.credit.use(held.owner), false)
      return
    }
    void this.dragToken(instance, held, ask.ask, taken.ok ? ask.path : null)
  }

  // Main's token for dragging the note out of the frame, null when it refused or the frame asked past its rate
  private async dragToken(instance: string, held: Mounted, ask: number, path: string | null): Promise<void> {
    const got = path === null ? null : await this.link.call('editor.dragToken', { plugin: held.owner, path })
    if (this.mounted.get(instance) !== held) return
    held.port?.postMessage({ v: 1, kind: 'drag-token', ask, token: got?.ok === true ? (got.result as { token: string }).token : null })
  }

  // A drag carrying a token, dropped on a note's editor or the empty stage, opens its note as the human's once main
  // answered the token with the plugin that asked for it
  private async dropped(event: DragEvent): Promise<void> {
    const token = dragTokenOf(event.dataTransfer?.getData('text/plain') ?? '')
    if (token === null) return
    event.preventDefault()
    if (!(event.target instanceof Element) || event.target.closest('.editor, #empty') === null) return
    const got = await this.link.call('editor.dropToken', { token })
    if (!got.ok) return
    const { plugin, path } = got.result as { plugin: string, path: string }
    this.onOpen?.(plugin, path, true, true)
  }
}
