import type { BrowserWindow, Session, WebContents, WebPreferences } from 'electron'
import { type CoreKey, coreKeyOf, keyName } from '../../api/keys.ts'
import { SCHEME } from './before-ready.ts'
import { frameOwner } from '../../api/ids.ts'

export const EDITOR_URL = `${SCHEME}://editor/`

// On every web contents, DevTools' included: no navigation a page starts, no new window, no webview, no Bluetooth
// device, which Electron would otherwise pick for the page itself, and no WebRTC over UDP
export function guardContents(contents: WebContents): void {
  // CSP's connect-src doesn't cover WebRTC and Chromium doesn't enforce webrtc 'block', so a frame under
  // connect-src 'none' still reached a STUN server over UDP. disable_non_proxied_udp leaves WebRTC only TCP through the
  // session's proxy, which leads nowhere (lockDown). Applies to every frame of the contents
  // https://www.electronjs.org/docs/latest/api/web-contents#contentssetwebrtciphandlingpolicypolicy
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  contents.on('will-navigate', event => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', event => event.preventDefault())
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault()
    callback('')
  })
}

// Every page runs sandboxed and isolated with no Node, in the session of its role
export function webPreferences(session: Session, packaged: boolean): WebPreferences {
  return {
    session,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: !packaged,
  }
}

// How a window a human sees opens: as usual, or quiet, without taking focus and at a place of its own and hidden as
// well when hide holds the options that keep it from sight
export type Placement = { quiet: boolean, at?: { x: number, y: number }, hide?: { opacity: number, focusable?: boolean } }

type Display = { id: number, workArea: { x: number, y: number } }

// Past every display Windows allows and see-through where a system keeps a window on a display, as macOS does
const OFF_SCREEN = { x: -32000, y: -32000 }

// A run from the source with HETU_QUIET_WINDOWS set to 1 opens its windows without taking focus, on a display other
// than the one under the cursor when there is one, so the person at the machine can keep working and watch. Set to
// hidden, as the tests run it, the windows still open and draw for Playwright and captures but off every display, at
// zero opacity and unable to take focus, so a later focus() can't take the foreground either. A packaged build ignores
// both
export function quietPlacement(options: {
  packaged: boolean
  env: Record<string, string | undefined>
  displays: readonly Display[]
  cursorDisplay: number
  platform?: string
}): Placement {
  if (options.packaged) return { quiet: false }
  // On Linux a window that can't take focus leaves the window manager and stays on top of every other
  if (options.env.HETU_QUIET_WINDOWS === 'hidden') {
    return { quiet: true, at: OFF_SCREEN, hide: (options.platform ?? process.platform) === 'linux' ? { opacity: 0 } : { opacity: 0, focusable: false } }
  }
  if (options.env.HETU_QUIET_WINDOWS !== '1') return { quiet: false }
  const other = options.displays.find(display => display.id !== options.cursorDisplay)
  return other === undefined ? { quiet: true } : { quiet: true, at: { x: other.workArea.x + 40, y: other.workArea.y + 40 } }
}

// The editor window on its shell, shown once it has drawn. preload is the shell's, which gives the top frame its bridge
export function openEditor(
  Window: typeof BrowserWindow,
  session: Session,
  packaged: boolean,
  placement: Placement = { quiet: false },
  preload?: string,
): BrowserWindow {
  const preferences = preload === undefined ? webPreferences(session, packaged) : { ...webPreferences(session, packaged), preload }
  const window = new Window({ width: 1100, height: 760, show: false, title: 'hetu', webPreferences: preferences, ...placement.at, ...placement.hide })
  window.once('ready-to-show', () => (placement.quiet ? window.showInactive() : window.show()))
  window.loadURL(EDITOR_URL).catch((err: unknown) => console.error(`the editor page didn't load: ${String(err)}`))
  return window
}

export const TRUSTED_URL = `${SCHEME}://trusted/`

// The application menu: none on Windows and Linux, so Electron's default Reload, Close and DevTools keys reach no
// window, and only Quit on macOS, where the menu bar is the app's and Quit lives in it
export function appMenu(platform: string): { label: string, submenu: { role: 'quit' }[] }[] | null {
  return platform === 'darwin' ? [{ label: 'hetu', submenu: [{ role: 'quit' }] }] : null
}

// The trusted window: its own OS window with its own taskbar entry, on the fixed trusted page in the trusted session,
// never on top of other windows and shown once it has drawn. preload is the shell's, the same narrow bridge
export function openTrusted(
  Window: typeof BrowserWindow,
  session: Session,
  packaged: boolean,
  placement: Placement = { quiet: false },
  preload?: string,
): BrowserWindow {
  const preferences = preload === undefined ? webPreferences(session, packaged) : { ...webPreferences(session, packaged), preload }
  const window = new Window({ width: 640, height: 720, show: false, title: 'hetu: security', webPreferences: preferences, ...placement.at, ...placement.hide })
  window.once('ready-to-show', () => (placement.quiet ? window.showInactive() : window.show()))
  window.loadURL(TRUSTED_URL).catch((err: unknown) => console.error(`the trusted page didn't load: ${String(err)}`))
  return window
}

// A core key from the editor window's input as main sees it before the page or any frame does, named the page's own
// way. A frame with focus would hear a key first, so main takes the core keys and hands them to the page
export function coreKeyOfInput(input: { type: string, key: string, code: string, control: boolean, meta: boolean, alt: boolean, shift: boolean }, mac: boolean): CoreKey | null {
  if (input.type !== 'keyDown') return null
  return coreKeyOf({ key: input.key, code: input.code, ctrlKey: input.control, metaKey: input.meta, altKey: input.alt, shiftKey: input.shift }, mac)
}

type EditorInput = Parameters<typeof coreKeyOfInput>[0] & { isAutoRepeat: boolean }
type EditorKey = { channel: 'hetu:key', sent: CoreKey } | { channel: 'hetu:view-key', sent: { url: string, key: string } } | { channel: null }

// What main does with a key of the editor window's input before the page or any frame hears it, null to let it go on. A
// core key goes to the page whatever has focus, a held one once. focused is the URL of the frame holding focus. While
// it is a plugin's frame, which hears a key before the page, a key that plugin's views bound goes to the page with the
// frame's URL
export function editorKeyOfInput(input: EditorInput, focused: string | null, bound: ReadonlyMap<string, ReadonlySet<string>>, mac: boolean): EditorKey | null {
  const core = coreKeyOfInput(input, mac)
  if (core !== null) return input.isAutoRepeat ? { channel: null } : { channel: 'hetu:key', sent: core }
  if (input.type !== 'keyDown' || focused === null || !URL.canParse(focused)) return null
  const at = new URL(focused)
  const plugin = at.protocol === `${SCHEME}:` ? frameOwner(at.hostname) : null
  const key = keyName({ key: input.key, ctrlKey: input.control, metaKey: input.meta, altKey: input.alt, shiftKey: input.shift }, mac)
  if (plugin === null || key === null || bound.get(plugin)?.has(key) !== true) return null
  return { channel: 'hetu:view-key', sent: { url: focused, key } }
}

// The URL of the plugin's frame holding focus when Enter went down in it, which the page counts as the human's press
// there for an open from that plugin's frames. Only that key and only that it went down, never the text typed, null
// for any other key or with focus outside a plugin's frame
export function frameKeyOfInput(input: EditorInput, focused: string | null): string | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.control || input.meta || input.alt) return null
  if (input.key !== 'Enter' || focused === null || !URL.canParse(focused)) return null
  const at = new URL(focused)
  return at.protocol === `${SCHEME}:` && frameOwner(at.hostname) !== null ? focused : null
}

