import { describe, expect, it } from 'vitest'
import { MAX_FRAME_MESSAGE } from '../api/ui.ts'
import { FRAME_MESSAGES_PER_SECOND, FrameInbox, FrameLoads } from '../frontend/mount/frames.ts'

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
