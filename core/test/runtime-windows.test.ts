import { EventEmitter } from 'node:events'
import type { BrowserWindow, Session, WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { guardContents, openEditor, openTrusted, quietPlacement, TRUSTED_URL, webPreferences } from '../backend/runtime/windows.ts'

// A web contents as the guard sees it: events to answer and the window open handler
class FakeContents extends EventEmitter {
  opener: ((details: { url: string }) => { action: string }) | null = null

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.opener = handler
  }
}

// An event as Electron passes it, telling whether a guard called preventDefault
function event() {
  return { prevented: false, preventDefault() { this.prevented = true } }
}

function guarded() {
  const contents = new FakeContents()
  guardContents(contents as unknown as WebContents)
  return contents
}

describe('the window guards', () => {
  it('denies every navigation a page starts', () => {
    const contents = guarded()
    const navigation = event()
    contents.emit('will-navigate', navigation, 'https://example.com/')
    expect(navigation.prevented).toBe(true)
  })

  it('denies every new window', () => {
    const contents = guarded()
    expect(contents.opener?.({ url: 'hetu://editor/' })).toEqual({ action: 'deny' })
  })

  it('denies every webview', () => {
    const contents = guarded()
    const attach = event()
    contents.emit('will-attach-webview', attach, {}, {})
    expect(attach.prevented).toBe(true)
  })

  it('picks no Bluetooth device, where Electron would pick the first one found', () => {
    const contents = guarded()
    const pick = event()
    const picked: string[] = []
    contents.emit('select-bluetooth-device', pick, [{ deviceId: 'a' }], (id: string) => picked.push(id))
    expect(pick.prevented).toBe(true)
    expect(picked).toEqual([''])
  })

  it('gives a page the sandbox, isolation, no Node and no webview, with DevTools only in a run from the source', () => {
    const session = {} as Session
    for (const packaged of [true, false]) {
      expect(webPreferences(session, packaged)).toEqual({
        session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false, webviewTag: false, spellcheck: false, navigateOnDragDrop: false,
        safeDialogs: true, devTools: !packaged,
      })
    }
  })
})

describe('quiet windows for runs from the source', () => {
  const displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
  ]

  it('opens without focus on a display other than the one under the cursor when HETU_QUIET_WINDOWS is 1', () => {
    expect(quietPlacement({ packaged: false, env: { HETU_QUIET_WINDOWS: '1' }, displays, cursorDisplay: 1 })).toEqual({ quiet: true, at: { x: 1960, y: 40 } })
    expect(quietPlacement({ packaged: false, env: { HETU_QUIET_WINDOWS: '1' }, displays, cursorDisplay: 2 })).toEqual({ quiet: true, at: { x: 40, y: 40 } })
    expect(quietPlacement({ packaged: false, env: { HETU_QUIET_WINDOWS: '1' }, displays: displays.slice(0, 1), cursorDisplay: 1 })).toEqual({ quiet: true })
  })

  it('opens as usual otherwise, and always in a packaged build', () => {
    expect(quietPlacement({ packaged: false, env: {}, displays, cursorDisplay: 1 })).toEqual({ quiet: false })
    expect(quietPlacement({ packaged: true, env: { HETU_QUIET_WINDOWS: '1' }, displays, cursorDisplay: 1 })).toEqual({ quiet: false })
  })

  it('shows a quiet editor without focus, where it was placed', () => {
    const made: { options: Record<string, unknown>, shown: string[], window: EventEmitter }[] = []
    class FakeWindow extends EventEmitter {
      shown: string[] = []
      webContents = {}
      constructor(options: Record<string, unknown>) {
        super()
        made.push({ options, shown: this.shown, window: this })
      }
      show() { this.shown.push('show') }
      showInactive() { this.shown.push('showInactive') }
      loadURL() { return Promise.resolve() }
    }
    const session = {} as Session
    openEditor(FakeWindow as unknown as typeof BrowserWindow, session, false, { quiet: true, at: { x: 1960, y: 40 } })
    openEditor(FakeWindow as unknown as typeof BrowserWindow, session, false)
    for (const { window } of made) window.emit('ready-to-show')
    expect(made.map(({ options, shown }) => [options.x, options.y, shown])).toEqual([[1960, 40, ['showInactive']], [undefined, undefined, ['show']]])
  })
})

describe('the trusted window', () => {
  it('opens its own page in the trusted session with the bridge of the shell, shown once drawn', () => {
    const made: { options: Record<string, unknown>, shown: string[], loaded: string[], window: EventEmitter }[] = []
    class FakeWindow extends EventEmitter {
      shown: string[] = []
      loaded: string[] = []
      webContents = {}
      constructor(options: Record<string, unknown>) {
        super()
        made.push({ options, shown: this.shown, loaded: this.loaded, window: this })
      }
      show() { this.shown.push('show') }
      showInactive() { this.shown.push('showInactive') }
      loadURL(url: string) { this.loaded.push(url); return Promise.resolve() }
    }
    const session = { trusted: true } as unknown as Session
    openTrusted(FakeWindow as unknown as typeof BrowserWindow, session, false, { quiet: false }, 'mount-preload.js')
    const [{ options, shown, loaded, window }] = made
    expect(loaded).toEqual([TRUSTED_URL])
    expect(TRUSTED_URL).toBe('hetu://trusted/')
    expect(options.show).toBe(false)
    expect((options.webPreferences as Record<string, unknown>).session).toBe(session)
    expect((options.webPreferences as Record<string, unknown>).preload).toBe('mount-preload.js')
    expect((options.webPreferences as Record<string, unknown>).sandbox).toBe(true)
    window.emit('ready-to-show')
    expect(shown).toEqual(['show'])
  })
})
