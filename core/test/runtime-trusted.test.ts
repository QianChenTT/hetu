import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import { type FolderDialog, INPUT_DELAY_MS, InputDelay, pickFolder, TrustedWindow, type TrustedLike } from '../backend/runtime/trusted.ts'

const key = (type: 'keyDown' | 'keyUp', code: string, isAutoRepeat = false) => ({ type, code, isAutoRepeat })
const mouse = (type: string, button: 'left' | 'right' | 'middle' = 'left') => ({ type, button })

function clocked() {
  let now = 0
  const delay = new InputDelay(() => now)
  return { delay, at: (ms: number) => { now = ms } }
}

describe('the input delay', () => {
  it('takes no input until the window shows', () => {
    const { delay, at } = clocked()
    at(5000)
    expect(delay.armed()).toBe(false)
    expect(delay.key(key('keyDown', 'Enter'))).toBe(true)
  })

  it('arms a second after the window shows, and again after each time it gains focus', () => {
    const { delay, at } = clocked()
    delay.restart()
    at(INPUT_DELAY_MS - 1)
    expect(delay.armed()).toBe(false)
    at(INPUT_DELAY_MS)
    expect(delay.armed()).toBe(true)
    delay.restart()
    expect(delay.armed()).toBe(false)
    at(2 * INPUT_DELAY_MS)
    expect(delay.armed()).toBe(true)
  })

  it('drops a key pressed during the delay with its repeats and its release, however late', () => {
    const { delay, at } = clocked()
    delay.restart()
    expect(delay.key(key('keyDown', 'Enter'))).toBe(true)
    at(5000)
    expect(delay.key(key('keyDown', 'Enter', true))).toBe(true)
    expect(delay.key(key('keyUp', 'Enter'))).toBe(true)
    // The next press is the human's own
    expect(delay.key(key('keyDown', 'Enter'))).toBe(false)
    expect(delay.key(key('keyUp', 'Enter'))).toBe(false)
  })

  it('drops the release of a mouse button pressed during the delay, so the click never lands', () => {
    const { delay, at } = clocked()
    delay.restart()
    expect(delay.mouse(mouse('mouseDown'))).toBe(true)
    at(5000)
    expect(delay.mouse(mouse('mouseUp'))).toBe(true)
    expect(delay.mouse(mouse('mouseDown'))).toBe(false)
    expect(delay.mouse(mouse('mouseUp'))).toBe(false)
  })

  it('drops every mouse event during the delay, moves and the wheel included', () => {
    const { delay, at } = clocked()
    delay.restart()
    for (const type of ['mouseMove', 'mouseWheel', 'mouseEnter', 'contextMenu']) expect(delay.mouse(mouse(type))).toBe(true)
    at(INPUT_DELAY_MS)
    expect(delay.mouse(mouse('mouseMove'))).toBe(false)
  })

  it('passes the release of a button pressed while armed, even once a focus restarted the delay', () => {
    const { delay, at } = clocked()
    delay.restart()
    at(INPUT_DELAY_MS)
    expect(delay.mouse(mouse('mouseDown', 'right'))).toBe(false)
    delay.restart()
    at(5000)
    // Pressed while armed, so its release is the human's and passes
    expect(delay.mouse(mouse('mouseUp', 'right'))).toBe(false)
  })
})

// A BrowserWindow as the trusted window uses it
class FakeWindow extends EventEmitter {
  readonly webContents = new EventEmitter()
  destroyed = false
  shown = 0
  focused = 0

  show(): void {
    this.shown++
    this.emit('show')
  }

  focus(): void {
    this.focused++
    this.emit('focus')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

function event() {
  return { prevented: false, preventDefault() { this.prevented = true } }
}

function trusted() {
  let now = 0
  const windows: FakeWindow[] = []
  const window = new TrustedWindow({
    open: () => {
      const made = new FakeWindow()
      windows.push(made)
      return made as unknown as TrustedLike
    },
    clock: () => now,
  })
  return { window, windows, at: (ms: number) => { now = ms } }
}

const trustedCaller: Caller = { kind: 'window', role: 'trusted', n: 1 }
const editorCaller: Caller = { kind: 'window', role: 'editor', n: 1 }

describe('the trusted window', () => {
  it('opens one window and focuses it when asked again', () => {
    const { window, windows } = trusted()
    window.show()
    window.show()
    expect(windows).toHaveLength(1)
    expect(windows[0].focused).toBe(1)
  })

  it('opens a new one once the last closed', () => {
    const { window, windows } = trusted()
    window.show()
    windows[0].close()
    window.show()
    expect(windows).toHaveLength(2)
  })

  it('counts a Confirm only from the trusted window, past the delay since it showed or gained focus', () => {
    const { window, windows, at } = trusted()
    expect(window.armed(trustedCaller)).toBe(false)
    window.show()
    windows[0].emit('show')
    expect(window.armed(trustedCaller)).toBe(false)
    at(INPUT_DELAY_MS)
    expect(window.armed(trustedCaller)).toBe(true)
    expect(window.armed(editorCaller)).toBe(false)
    windows[0].emit('focus')
    expect(window.armed(trustedCaller)).toBe(false)
    at(2 * INPUT_DELAY_MS)
    expect(window.armed(trustedCaller)).toBe(true)
    windows[0].close()
    expect(window.armed(trustedCaller)).toBe(false)
  })

  // A reload was a new page armed at once
  it('starts the delay again whenever its page starts loading', () => {
    const { window, windows, at } = trusted()
    window.show()
    windows[0].emit('show')
    at(INPUT_DELAY_MS)
    expect(window.armed(trustedCaller)).toBe(true)
    windows[0].webContents.emit('did-start-loading')
    expect(window.armed(trustedCaller)).toBe(false)
  })

  it('drops the page\'s keyboard and mouse input during the delay', () => {
    const { window, windows, at } = trusted()
    window.show()
    windows[0].emit('show')
    const pressed = event()
    windows[0].webContents.emit('before-input-event', pressed, key('keyDown', 'Enter'))
    const clicked = event()
    windows[0].webContents.emit('before-mouse-event', clicked, mouse('mouseDown'))
    expect(pressed.prevented && clicked.prevented).toBe(true)
    at(INPUT_DELAY_MS)
    const later = event()
    windows[0].webContents.emit('before-input-event', later, key('keyDown', 'KeyG'))
    expect(later.prevented).toBe(false)
  })
})

describe('picking the notes folder', () => {
  it('opens the OS folder dialog over the trusted window and answers the folder, or null when cancelled', async () => {
    const { window } = trusted()
    const parent = window.show()
    const asked: { parent: TrustedLike, properties: string[] }[] = []
    const dialog: FolderDialog = async (over, options) => {
      asked.push({ parent: over, properties: options.properties })
      return { canceled: false, filePaths: ['/Users/someone/notes'] }
    }
    expect(await pickFolder(window, dialog)).toBe('/Users/someone/notes')
    expect(asked).toEqual([{ parent, properties: ['openDirectory', 'createDirectory'] }])
    expect(await pickFolder(window, async () => ({ canceled: true, filePaths: [] }))).toBeNull()
  })

  it('opens no dialog while no trusted window is open', async () => {
    const { window } = trusted()
    let asked = 0
    expect(await pickFolder(window, async () => {
      asked++
      return { canceled: false, filePaths: ['/notes'] }
    })).toBeNull()
    expect(asked).toBe(0)
  })
})
