import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkSender, WindowWay, type WindowContents } from '../backend/runtime/window-way.ts'
import { cleanup, harness, tick } from './carrier-fakes.ts'

afterEach(() => {
  cleanup()
})

// A frame as an IPC event names it
class FakeFrame {
  url: string
  parent: FakeFrame | null
  detached = false
  destroyed = false
  sent: unknown[] = []

  constructor(url: string, parent: FakeFrame | null = null) {
    this.url = url
    this.parent = parent
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(_channel: string, message: unknown): void {
    this.sent.push(message)
  }
}

// A window's webContents as the way sees it: its main frame, its own IPC and the events of its life
class FakeContents extends EventEmitter {
  mainFrame = new FakeFrame('hetu://editor/')
  readonly ipc = new EventEmitter()

  // A message from frame on the window's channel
  sends(frame: FakeFrame, message: unknown): void {
    this.ipc.emit('hetu:window', { senderFrame: frame }, message)
  }
}

const call = (id: number, action: string, args?: unknown) => ({ v: 1, kind: 'call', id, action, args })

function window() {
  const parts = harness()
  const contents = new FakeContents()
  const way = new WindowWay(contents as unknown as WindowContents, 'editor', parts.carrier)
  contents.emit('did-navigate')
  return { ...parts, contents, way }
}

const answers = (frame: FakeFrame) => frame.sent as { kind: string, id?: number, ok?: boolean, result?: unknown }[]

describe('the sender check', () => {
  it('takes only the window\'s own top frame, attached and alive, on its own hetu host', () => {
    const top = new FakeFrame('hetu://editor/')
    expect(checkSender(top, top, 'editor')).toBe(true)
    expect(checkSender(null, top, 'editor')).toBe(false)
    expect(checkSender(new FakeFrame('hetu://editor/', top), top, 'editor')).toBe(false)
    const elsewhere = new FakeFrame('hetu://editor/')
    expect(checkSender(elsewhere, top, 'editor')).toBe(false)
    expect(checkSender(top, top, 'trusted')).toBe(false)
    for (const url of ['hetu://trusted/', 'https://editor/', 'hetu://user@editor/', 'hetu://editor:1/', 'about:blank', 'not a url']) {
      const frame = new FakeFrame(url)
      expect(checkSender(frame, frame, 'editor'), url).toBe(false)
    }
    top.detached = true
    expect(checkSender(top, top, 'editor')).toBe(false)
    top.detached = false
    top.destroyed = true
    expect(checkSender(top, top, 'editor')).toBe(false)
  })
})

describe('a window\'s way in', () => {
  it('binds each message from the window\'s top frame to the window and its load, and answers that frame', async () => {
    const { contents } = window()
    contents.sends(contents.mainFrame, call(1, 'core.self'))
    await tick(10)
    expect(answers(contents.mainFrame)).toEqual([expect.objectContaining({ v: 1, kind: 'reply', id: 1, ok: true, result: { kind: 'window', role: 'editor', n: 1 } })])
  })

  it('reads nothing a frame inside the window sends, nor a frame on another host', async () => {
    const { contents } = window()
    const inner = new FakeFrame('hetu://editor/', contents.mainFrame)
    contents.sends(inner, call(1, 'core.self'))
    contents.mainFrame.url = 'hetu://trusted/'
    contents.sends(contents.mainFrame, call(2, 'core.self'))
    await tick(10)
    expect(inner.sent).toEqual([])
    expect(answers(contents.mainFrame)).toEqual([])
  })

  it('gives each load its own way: a new document ends the old one\'s way and takes the next n', async () => {
    const { contents, carrier } = window()
    contents.sends(contents.mainFrame, call(1, 'events.subscribe', { topics: ['core.status'] }))
    await tick(10)
    // The window's own n check would hide a way left open in the carrier, so the end is checked where it happens
    const end = vi.spyOn(carrier, 'end')
    contents.emit('did-navigate')
    expect(end).toHaveBeenCalledWith({ kind: 'window', role: 'editor', n: 1 })
    contents.sends(contents.mainFrame, call(2, 'core.self'))
    await tick(10)
    expect(answers(contents.mainFrame).at(-1)).toMatchObject({ id: 2, result: { kind: 'window', role: 'editor', n: 2 } })
    // The first load's subscription went with its way, so nothing reaches the second load
    carrier.changed()
    await tick(10)
    expect(answers(contents.mainFrame).filter(message => message.kind === 'event')).toEqual([])
  })

  it('drops an answer to a load that is gone', async () => {
    const { contents, luoshu } = window()
    luoshu.hold.prepare = new Promise(() => {})
    contents.sends(contents.mainFrame, call(1, 'core.self'))
    await tick(10)
    const before = answers(contents.mainFrame).length
    contents.sends(contents.mainFrame, call(2, 'luoshu.read', { path: 'notes/a.md' }))
    contents.emit('did-navigate')
    await tick(10)
    expect(answers(contents.mainFrame).filter(message => message.id === 2)).toEqual([])
    expect(answers(contents.mainFrame)).toHaveLength(before)
  })

  it('ends the way for good when the window is gone', async () => {
    const { contents, carrier } = window()
    contents.sends(contents.mainFrame, call(1, 'events.subscribe', { topics: ['core.status'] }))
    await tick(10)
    const end = vi.spyOn(carrier, 'end')
    contents.emit('destroyed')
    expect(end).toHaveBeenCalledWith({ kind: 'window', role: 'editor', n: 1 })
    contents.sends(contents.mainFrame, call(2, 'core.self'))
    await tick(10)
    expect(answers(contents.mainFrame).filter(message => message.id === 2)).toEqual([])
    carrier.changed()
    await tick(10)
    expect(answers(contents.mainFrame).filter(message => message.kind === 'event')).toEqual([])
    contents.emit('did-navigate')
    contents.sends(contents.mainFrame, call(3, 'core.self'))
    await tick(10)
    expect(answers(contents.mainFrame).filter(message => message.id === 3)).toEqual([])
  })

  // A reload after the crash is a new load, so the window isn't lost until hetu restarts
  it('ends a crashed renderer\'s load, answers nothing until the next load and answers that one with the next n', async () => {
    const { contents, carrier } = window()
    const end = vi.spyOn(carrier, 'end')
    contents.emit('render-process-gone')
    expect(end).toHaveBeenCalledWith({ kind: 'window', role: 'editor', n: 1 })
    contents.sends(contents.mainFrame, call(1, 'core.self'))
    await tick(10)
    expect(answers(contents.mainFrame)).toEqual([])
    contents.emit('did-navigate')
    contents.sends(contents.mainFrame, call(2, 'core.self'))
    await tick(10)
    expect(answers(contents.mainFrame).at(-1)).toMatchObject({ id: 2, result: { kind: 'window', role: 'editor', n: 2 } })
  })
})
