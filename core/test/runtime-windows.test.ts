import { EventEmitter } from 'node:events'
import type { Session, WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { guardContents, webPreferences } from '../backend/runtime/windows.ts'

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
