import { describe, expect, it } from 'vitest'
import { MAX_FRAME_MESSAGE } from '../api/ui.ts'
import { FOCUS_GRACE_MS, FocusGuard, FRAME_MESSAGES_PER_SECOND, FrameInbox, FrameLoads } from '../frontend/editor/frames.ts'

describe('a frame\'s loads', () => {
  it('hands the port on the first load only and reads any later load as navigated', () => {
    const loads = new FrameLoads()
    loads.started('v1')
    expect(loads.loaded('v1')).toBe('port')
    expect(loads.loaded('v1')).toBe('navigated')
    expect(loads.loaded('v1')).toBe('navigated')
  })

  it('reads a load of a frame it no longer holds as gone, and a frame started again afresh', () => {
    const loads = new FrameLoads()
    expect(loads.loaded('v1')).toBe('gone')
    loads.started('v1')
    loads.loaded('v1')
    loads.ended('v1')
    expect(loads.loaded('v1')).toBe('gone')
    loads.started('v1')
    expect(loads.loaded('v1')).toBe('port')
  })
})

describe('what a frame sends', () => {
  it('takes JSON text of plain data within the cap', () => {
    const inbox = new FrameInbox(() => 0)
    expect(inbox.take(JSON.stringify({ cards: [1, 2] }))).toEqual({ ok: true, data: { cards: [1, 2] } })
  })

  it('drops anything but text, text that is no JSON, a key reaching Object and text past the cap', () => {
    const inbox = new FrameInbox(() => 0)
    expect(inbox.take({ cards: 1 })).toEqual({ ok: false })
    expect(inbox.take('not json')).toEqual({ ok: false })
    expect(inbox.take('{"__proto__":{"x":1}}')).toEqual({ ok: false })
    expect(inbox.take(JSON.stringify('x'.repeat(MAX_FRAME_MESSAGE)))).toEqual({ ok: false })
  })

  it(`drops messages past ${FRAME_MESSAGES_PER_SECOND} a second and takes them again in the next`, () => {
    let now = 0
    const inbox = new FrameInbox(() => now)
    for (let i = 0; i < FRAME_MESSAGES_PER_SECOND; i++) expect(inbox.take('1').ok).toBe(true)
    expect(inbox.take('1').ok).toBe(false)
    now = 1000
    expect(inbox.take('1').ok).toBe(true)
  })
})

describe('focus going into a frame', () => {
  it('lets it in once after a press in that frame and keeps it while focus stays there', () => {
    const guard = new FocusGuard(() => 0)
    guard.allow('v1')
    expect(guard.entered('v1')).toBe(true)
    expect(guard.entered('v1')).toBe(true)
    guard.left()
    expect(guard.entered('v1')).toBe(false)
  })

  it('takes a move into a frame with no press, or after a press elsewhere, as the frame\'s own', () => {
    const guard = new FocusGuard(() => 0)
    expect(guard.entered('v1')).toBe(false)
    guard.allow('v2')
    expect(guard.entered('v1')).toBe(false)
    guard.allow('v1')
    guard.allow(null)
    expect(guard.entered('v1')).toBe(false)
  })

  it('takes a frame that held focus as taking it on its own after a press elsewhere, whether or not the page saw focus leave', () => {
    const guard = new FocusGuard(() => 0)
    guard.allow('v1')
    expect(guard.entered('v1')).toBe(true)
    guard.allow(null)
    expect(guard.entered('v1')).toBe(false)
    guard.allow('v1')
    expect(guard.entered('v1')).toBe(true)
    guard.allow('v2')
    expect(guard.entered('v1')).toBe(false)
  })

  it('takes a move from one frame into another with no press as the other\'s own', () => {
    const guard = new FocusGuard(() => 0)
    guard.allow('v1')
    expect(guard.entered('v1')).toBe(true)
    expect(guard.entered('v2')).toBe(false)
  })

  it('lets the core\'s own move in as it lets a press in', () => {
    const guard = new FocusGuard(() => 0)
    guard.left()
    guard.allow('v1')
    expect(guard.entered('v1')).toBe(true)
  })

  it(`counts a press only within ${FOCUS_GRACE_MS} ms, so a frame that kept focus from moving on a press can't take it later`, () => {
    let now = 0
    const guard = new FocusGuard(() => now)
    guard.allow('v1')
    now = FOCUS_GRACE_MS + 1
    expect(guard.entered('v1')).toBe(false)
    guard.allow('v1')
    now += FOCUS_GRACE_MS
    expect(guard.entered('v1')).toBe(true)
  })
})
