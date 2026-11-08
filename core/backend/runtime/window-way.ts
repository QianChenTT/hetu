import type { Caller, WindowRole } from '../../api/envelope.ts'
import { SCHEME } from './before-ready.ts'

export const WINDOW_CHANNEL = 'hetu:window'

// A frame as an IPC event names it, Electron's WebFrameMain
export type SenderFrame = {
  readonly url: string
  readonly parent: unknown
  readonly detached?: boolean
  isDestroyed(): boolean
  send(channel: string, message: unknown): void
}

type IpcEvent = { senderFrame: SenderFrame | null }

// A window's webContents as its way in uses it, faked in the tests
export type WindowContents = {
  readonly mainFrame: SenderFrame
  readonly ipc: { on(channel: string, listener: (event: IpcEvent, message: unknown) => void): unknown }
  on(event: 'did-navigate' | 'destroyed' | 'render-process-gone', listener: () => void): unknown
}

type Carrier = {
  window<S>(check: (sender: S) => Caller | null): (sender: S, message: unknown, answer: (reply: unknown) => void) => void
  end(caller: Caller): void
}

// The bind step's sender check for a window, run before anything else and before any await: the frame is there,
// attached and alive, it is the window's own top frame and it is on the window's own hetu host, with no user or port
export function checkSender(frame: SenderFrame | null, top: unknown, host: string): boolean {
  if (frame === null || frame.detached === true || frame.isDestroyed()) return false
  if (frame !== top || frame.parent !== null) return false
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    return false
  }
  return url.protocol === `${SCHEME}:` && url.hostname === host && url.username === '' && url.password === '' && url.port === ''
}

// A window's way into the carrier. Its messages come only on its own webContents' IPC, so a webContents the core
// didn't make can't reach it, and the sender check refuses anything but its top frame on its own host. Each load of the
// window is its own caller, { kind: 'window', role, n }: a new document ends the old one's way, so the old load's
// subscriptions and pending answers never reach the new one, and an answer goes only to the load that asked. A window
// that is gone, or whose renderer is, ends its way
export class WindowWay {
  private n = 0
  private over = false

  constructor(contents: WindowContents, role: WindowRole, carrier: Carrier) {
    const receive = carrier.window<{ frame: SenderFrame | null, n: number }>(sender => {
      if (this.over || sender.n === 0 || sender.n !== this.n) return null
      return checkSender(sender.frame, contents.mainFrame, role) ? { kind: 'window', role, n: sender.n } : null
    })
    contents.ipc.on(WINDOW_CHANNEL, (event, message) => {
      const frame = event.senderFrame
      const n = this.n
      receive({ frame, n }, message, reply => {
        if (this.over || this.n !== n || frame === null || frame.isDestroyed()) return
        frame.send(WINDOW_CHANNEL, reply)
      })
    })
    const endLoad = () => {
      if (this.n > 0) carrier.end({ kind: 'window', role, n: this.n })
    }
    // A new document committed, a reload among them. Messages from the old one can't arrive after this
    contents.on('did-navigate', () => {
      if (this.over) return
      endLoad()
      this.n++
    })
    const close = () => {
      if (this.over) return
      endLoad()
      this.over = true
    }
    contents.on('destroyed', close)
    contents.on('render-process-gone', close)
  }
}
