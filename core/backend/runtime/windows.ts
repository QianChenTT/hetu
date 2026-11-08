import type { BrowserWindow, Session, WebContents, WebPreferences } from 'electron'
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
