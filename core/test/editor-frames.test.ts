import { describe, expect, it } from 'vitest'
import { FRAME_ASKS_PER_SECOND, FRAME_MESSAGES_PER_SECOND, FrameInbox, frameAsks, MAX_FRAME_MESSAGE, OPEN_GRACE_MS, OpenCredit, DRAG_PREFIX, dragTokenOf } from '../api/ui-limits.ts'
import { FOCUS_GRACE_MS, FocusGuard, FrameLoads, Frames } from '../frontend/editor/frames.ts'
import type { CoreLink } from '../frontend/editor/link.ts'

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

  it('uses a press credit once, so a second press in the frame holding focus lets nothing in after focus is back in the page', () => {
    const guard = new FocusGuard(() => 0)
    guard.allow('v1')
    expect(guard.entered('v1')).toBe(true)
    guard.allow('v1')
    expect(guard.entered('v1')).toBe(true)
    guard.left()
    expect(guard.entered('v1')).toBe(false)
    guard.allow('v1')
    guard.left()
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

describe('the theme the frames are offered', () => {
  // A link that answers each editor.theme with the next answer given, ok when none is left
  function linked(answers: boolean[]) {
    const sent: unknown[] = []
    const link = {
      call: async (action: string, args?: unknown) => {
        if (action === 'editor.theme') sent.push(args)
        return answers.shift() ?? true ? { ok: true, result: null } : { ok: false, refusal: { code: 'invalid' } }
      },
    } as unknown as CoreLink
    return { link, sent }
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  it('sends main a theme again after a refusal and not after an answer', async () => {
    const { link, sent } = linked([false])
    const frames = new Frames(link, {} as HTMLElement, () => {}, () => false)
    const theme = { '--hetu-color-bg': '#ffffff' }
    frames.theme(theme)
    await settle()
    frames.theme(theme)
    await settle()
    frames.theme(theme)
    await settle()
    expect(sent).toEqual([{ variables: theme }, { variables: theme }])
    frames.theme({ '--hetu-color-bg': '#202020' })
    await settle()
    expect(sent).toHaveLength(3)
  })
})

describe('the frame focus is in', () => {
  it('holds only a frame it let in, until focus leaves it or a press lands elsewhere', () => {
    const guard = new FocusGuard(() => 0)
    expect(guard.holding('v1')).toBe(false)
    expect(guard.entered('v1')).toBe(false)
    expect(guard.holding('v1')).toBe(false)
    guard.allow('v1')
    expect(guard.holding('v1')).toBe(false)
    expect(guard.entered('v1')).toBe(true)
    expect(guard.holding('v1')).toBe(true)
    expect(guard.holding('v2')).toBe(false)
    guard.allow(null)
    expect(guard.holding('v1')).toBe(false)
    guard.allow('v1')
    guard.entered('v1')
    guard.left()
    expect(guard.holding('v1')).toBe(false)
  })

  it('names the frame it let in for main, none before it entered and none once a press lands elsewhere or focus left', () => {
    const guard = new FocusGuard(() => 0)
    expect(guard.letIn()).toBe(null)
    guard.allow('v1')
    expect(guard.letIn()).toBe(null)
    guard.entered('v1')
    expect(guard.letIn()).toBe('v1')
    guard.allow('v1')
    expect(guard.letIn()).toBe('v1')
    guard.allow('v2')
    expect(guard.letIn()).toBe(null)
    guard.entered('v2')
    expect(guard.letIn()).toBe('v2')
    guard.entered('v1')
    expect(guard.letIn()).toBe(null)
    guard.allow('v1')
    guard.entered('v1')
    guard.left()
    expect(guard.letIn()).toBe(null)
  })
})

describe("an open from a frame counted as the human's", () => {
  it('takes one open of the plugin pressed in, then none until the next press', () => {
    const credit = new OpenCredit(() => 0)
    expect(credit.use('kanban')).toBe(false)
    credit.pressed('kanban')
    expect(credit.use('kanban')).toBe(true)
    expect(credit.use('kanban')).toBe(false)
    credit.pressed('kanban')
    expect(credit.use('kanban')).toBe(true)
  })

  it("takes no open of a plugin after a press elsewhere or in another plugin's frame", () => {
    const credit = new OpenCredit(() => 0)
    credit.pressed('kanban')
    credit.pressed(null)
    expect(credit.use('kanban')).toBe(false)
    credit.pressed('kanban')
    credit.pressed('board')
    expect(credit.use('kanban')).toBe(false)
    expect(credit.use('board')).toBe(true)
  })

  it(`counts a press within ${OPEN_GRACE_MS} ms, or the release of a press not yet used, so a long press still opens once`, () => {
    let now = 0
    const credit = new OpenCredit(() => now)
    credit.pressed('kanban')
    now = OPEN_GRACE_MS + 1
    expect(credit.use('kanban')).toBe(false)
    credit.pressed('kanban')
    now += 2000
    credit.released('kanban')
    now += OPEN_GRACE_MS
    expect(credit.use('kanban')).toBe(true)
    credit.released('kanban')
    expect(credit.use('kanban')).toBe(false)
  })

  it("counts a release only after a press in the same plugin's frame", () => {
    const credit = new OpenCredit(() => 0)
    credit.released('kanban')
    expect(credit.use('kanban')).toBe(false)
    credit.pressed(null)
    credit.released('kanban')
    expect(credit.use('kanban')).toBe(false)
    credit.pressed('board')
    credit.released('kanban')
    expect(credit.use('kanban')).toBe(false)
  })

  it('takes no open of a plugin once a frame of its went, as on a stop or restart, and leaves another plugin\'s', () => {
    const credit = new OpenCredit(() => 0)
    credit.pressed('kanban')
    credit.forget('kanban')
    expect(credit.use('kanban')).toBe(false)
    credit.pressed('board')
    credit.forget('kanban')
    expect(credit.use('board')).toBe(true)
  })

  it("takes Enter in the plugin's frame as a press, one open each", () => {
    const credit = new OpenCredit(() => 0)
    credit.keyed('kanban')
    expect(credit.use('board')).toBe(false)
    expect(credit.use('kanban')).toBe(true)
    expect(credit.use('kanban')).toBe(false)
  })
})

describe('what a frame asks of the page', () => {
  it('takes an open and a numbered drag token ask for a path, as objects', () => {
    const asks = frameAsks(() => 0)
    expect(asks({ v: 1, kind: 'open', path: 'a.md' })).toEqual({ ask: { kind: 'open', path: 'a.md' }, ok: true })
    expect(asks({ v: 1, kind: 'drag-token', ask: 3, path: 'b/c.md' })).toEqual({ ask: { kind: 'drag-token', ask: 3, path: 'b/c.md' }, ok: true })
  })

  it('takes nothing else: text, another version or kind, no path, an empty or long one, an ask not a whole number', () => {
    const asks = frameAsks(() => 0)
    for (const message of [
      JSON.stringify({ v: 1, kind: 'open', path: 'a.md' }), null, 1, { v: 2, kind: 'open', path: 'a.md' }, { v: 1, kind: 'close', path: 'a.md' },
      { v: 1, kind: 'open' }, { v: 1, kind: 'open', path: '' }, { v: 1, kind: 'open', path: 'a'.repeat(513) }, { v: 1, kind: 'open', path: 1 },
      { v: 1, kind: 'drag-token', path: 'a.md' }, { v: 1, kind: 'drag-token', ask: 1.5, path: 'a.md' }, { v: 1, kind: 'drag-token', ask: -1, path: 'a.md' },
    ]) expect(asks(message)).toBeNull()
  })

  it('takes no path the note path check refuses, as the worker\'s editor.open', () => {
    const asks = frameAsks(() => 0)
    for (const path of ['a\\b.md', 'c:x.md', 'a\u0001.md', '\ud800.md', 'a//b.md']) {
      expect(asks({ v: 1, kind: 'open', path })).toBeNull()
      expect(asks({ v: 1, kind: 'drag-token', ask: 1, path })).toBeNull()
    }
    expect(asks({ v: 1, kind: 'open', path: 'notes/a b.md' })?.ok).toBe(true)
  })

  it(`answers asks past ${FRAME_ASKS_PER_SECOND} a second as not ok and takes them again in the next`, () => {
    let now = 0
    const asks = frameAsks(() => now)
    for (let i = 0; i < FRAME_ASKS_PER_SECOND; i++) expect(asks({ v: 1, kind: 'open', path: 'a.md' })?.ok).toBe(true)
    expect(asks({ v: 1, kind: 'drag-token', ask: 1, path: 'a.md' })).toEqual({ ask: { kind: 'drag-token', ask: 1, path: 'a.md' }, ok: false })
    now = 1000
    expect(asks({ v: 1, kind: 'open', path: 'a.md' })?.ok).toBe(true)
  })
})

describe('a note dragged out of a frame', () => {
  it('carries its token after the prefix, read back only from text holding exactly that', () => {
    const token = '0123456789abcdef0123456789abcdef'
    expect(dragTokenOf(`${DRAG_PREFIX}${token}`)).toBe(token)
    for (const text of ['', token, `${DRAG_PREFIX}`, `${DRAG_PREFIX}${token}0`, `${DRAG_PREFIX}${token.toUpperCase()}`, ` ${DRAG_PREFIX}${token}`, `hetu-note:${token}`, `${DRAG_PREFIX}${token}\n`]) {
      expect(dragTokenOf(text)).toBeNull()
    }
  })
})
