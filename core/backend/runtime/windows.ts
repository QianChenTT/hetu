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

// The editor window on the placeholder page, shown once it has drawn
export function openEditor(Window: typeof BrowserWindow, session: Session, packaged: boolean): BrowserWindow {
  const window = new Window({ width: 1100, height: 760, show: false, title: 'hetu', webPreferences: webPreferences(session, packaged) })
  window.once('ready-to-show', () => window.show())
  window.loadURL(EDITOR_URL).catch((err: unknown) => console.error(`the editor page didn't load: ${String(err)}`))
  return window
}
