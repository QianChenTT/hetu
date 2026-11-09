import type { Caller } from '../../api/envelope.ts'
import { INPUT_DELAY_MS } from '../../api/trusted.ts'

export { INPUT_DELAY_MS }

// Keyboard input as before-input-event hands it and mouse input as before-mouse-event does
export type KeyInput = { readonly type: string, readonly code: string, readonly isAutoRepeat?: boolean }
export type MouseInput = { readonly type: string, readonly button?: string }

// The input delay: nothing the human does counts until INPUT_DELAY_MS after the window last showed or gained focus.
// Input already under way doesn't count either: a key or button pressed during the delay is dropped with its repeats
// and its release, however late they come, so a click whose press was aimed at something else never lands here
export class InputDelay {
  private readonly clock: () => number
  private armedAt = Number.POSITIVE_INFINITY
  private readonly held = new Set<string>()

  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock
  }

  restart(): void {
    this.armedAt = this.clock() + INPUT_DELAY_MS
  }

  armed(): boolean {
    return this.clock() >= this.armedAt
  }

  // Whether to drop a key event
  key(input: KeyInput): boolean {
    return this.press(`key ${input.code}`, input.type !== 'keyUp')
  }

  // Whether to drop a mouse event. Moves, the wheel and the rest go only once armed
  mouse(input: MouseInput): boolean {
    const button = `button ${input.button ?? 'left'}`
    if (input.type === 'mouseDown') return this.press(button, true)
    if (input.type === 'mouseUp') return this.press(button, false)
    return !this.armed()
  }

  private press(name: string, down: boolean): boolean {
    if (this.held.has(name)) {
      if (!down) this.held.delete(name)
      return true
    }
    if (this.armed()) return false
    if (down) this.held.add(name)
    return true
  }
}

// What the trusted window needs of a BrowserWindow, which the tests fake
export type TrustedLike = {
  readonly webContents: { on(event: string, listener: (...args: never[]) => void): unknown }
  on(event: 'show' | 'focus' | 'closed', listener: () => void): unknown
  focus(): void
  isDestroyed(): boolean
}

type Prevented = { preventDefault(): void }

// The one trusted window: opened by a human's click on a core control, focused when one is open, its input held back by
// the delay in main where no page code can skip it. A Confirm counts only from it once armed
export class TrustedWindow {
  private readonly open: () => TrustedLike
  private readonly clock: () => number
  private current: { window: TrustedLike, delay: InputDelay } | null = null

  constructor(options: { open: () => TrustedLike, clock?: () => number }) {
    this.open = options.open
    this.clock = options.clock ?? (() => performance.now())
  }

  show(): TrustedLike {
    const current = this.current
    if (current !== null && !current.window.isDestroyed()) {
      current.window.focus()
      return current.window
    }
    const window = this.open()
    const delay = new InputDelay(this.clock)
    const made = { window, delay }
    this.current = made
    window.on('show', () => delay.restart())
    window.on('focus', () => delay.restart())
    // A reload is a new page, which waits the delay like the first
    window.webContents.on('did-start-loading', () => delay.restart())
    window.on('closed', () => {
      if (this.current === made) this.current = null
    })
    window.webContents.on('before-input-event', ((event: Prevented, input: KeyInput) => {
      if (delay.key(input)) event.preventDefault()
    }) as (...args: never[]) => void)
    window.webContents.on('before-mouse-event', ((event: Prevented, input: MouseInput) => {
      if (delay.mouse(input)) event.preventDefault()
    }) as (...args: never[]) => void)
    return window
  }

  // Whether a Confirm from caller counts: the trusted window, open and past its delay
  armed(caller: Caller): boolean {
    const current = this.current
    if (caller.kind !== 'window' || caller.role !== 'trusted' || current === null || current.window.isDestroyed()) return false
    return current.delay.armed()
  }

  // The trusted window, if one is open
  get window(): TrustedLike | null {
    return this.current !== null && !this.current.window.isDestroyed() ? this.current.window : null
  }
}
