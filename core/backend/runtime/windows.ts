import type { BrowserWindow, Session, WebContents, WebPreferences } from 'electron'
import { type CoreKey, coreKeyOf } from '../../frontend/mount/keys.ts'
import { SCHEME } from './before-ready.ts'

export const EDITOR_URL = `${SCHEME}://editor/`

// On every web contents, DevTools' included: no navigation a page starts, no new window, no webview and no Bluetooth
// device, which Electron would otherwise pick for the page itself
export function guardContents(contents: WebContents): void {
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

// How a window a human sees opens: as usual, or quiet, without taking focus and at a place of its own
export type Placement = { quiet: boolean, at?: { x: number, y: number } }

type Display = { id: number, workArea: { x: number, y: number } }

// A run from the source with HETU_QUIET_WINDOWS set to 1, as the tests run it, opens its windows without taking focus,
// on a display other than the one under the cursor when there is one, so the person at the machine can keep working. A
// packaged build ignores it
export function quietPlacement(options: {
  packaged: boolean
  env: Record<string, string | undefined>
  displays: readonly Display[]
  cursorDisplay: number
}): Placement {
  if (options.packaged || options.env.HETU_QUIET_WINDOWS !== '1') return { quiet: false }
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
  const window = new Window({ width: 1100, height: 760, show: false, title: 'hetu', webPreferences: preferences, ...placement.at })
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
  const window = new Window({ width: 640, height: 720, show: false, title: 'hetu: security', webPreferences: preferences, ...placement.at })
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
