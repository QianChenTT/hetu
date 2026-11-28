import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_DEPTH } from '../api/plain.ts'
import { API_VERSION } from '../api/manifest.ts'
import { DRAG_PREFIX, DRAG_TOKEN_MS, DRAG_TOKENS_PER_PLUGIN, FRAME_MESSAGES_PER_SECOND, MAX_FRAME_MESSAGE, OPEN_GRACE_MS } from '../api/ui-limits.ts'
import { definePlugin, type PluginContext } from '../sdk/plugin.ts'
import { type FakeCore, fakeCore, FakeDrawer } from '../sdk/testing/index.ts'

// A plugin's test driving its frame views through the fake drawer, held to the checks hetu's drawer makes of what a
// frame and its worker send each other

const cores: FakeCore[] = []
afterEach(async () => {
  for (const made of cores.splice(0)) await made.close()
})

const manifest = {
  id: 'kanban', name: 'Kanban', version: '1.0.0', api: `^${API_VERSION}`,
  entries: { worker: 'dist/worker.js', frames: { board: 'board.html' } },
  capabilities: [{ type: 'ui.view' }],
  views: { board: { title: 'Board', kind: 'view', frame: 'board' }, list: { title: 'List', kind: 'view' } },
}

// The plugin answers each message from its frame with how many it heard
async function started() {
  const drawer = new FakeDrawer()
  const made = fakeCore({ manifest, drawer })
  cores.push(made)
  const heard: unknown[] = []
  let given: PluginContext | null = null
  await made.start(definePlugin({
    start(ctx) {
      given = ctx
      ctx.ui.on('view.message', event => {
        heard.push(event.data)
        void ctx.ui.views.post(event.instance, { heard: heard.length })
      })
    },
  }))
  const settled = () => new Promise(resolve => setTimeout(resolve, 5))
  const board = drawer.instances().find(each => each.view === 'board')!.instance
  const list = drawer.instances().find(each => each.view === 'list')!.instance
  return { drawer, ctx: given as unknown as PluginContext, heard, settled, board, list }
}

// Nested one past what plain data takes
function nested(depth: number): unknown {
  let value: unknown = 'deep'
  for (let at = 0; at < depth; at++) value = { a: value }
  return value
}

describe('frame views in the fake drawer', () => {
  it('carries a mounted frame\'s message to its worker and the worker\'s answer back, as JSON would', async () => {
    const { drawer, heard, settled, board } = await started()
    const frame = drawer.mountFrame(board)
    expect(frame.post({ moved: 'card', at: new Date(0), gone: undefined })).toBe(true)
    await settled()
    expect(heard).toEqual([{ moved: 'card', at: '1970-01-01T00:00:00.000Z' }])
    expect(frame.received).toEqual([{ heard: 1 }])
  })

  it('refuses what hetu\'s drawer drops from a frame: past the cap, not plain data or nothing', async () => {
    const { drawer, heard, settled, board } = await started()
    const frame = drawer.mountFrame(board)
    expect(frame.post('x'.repeat(MAX_FRAME_MESSAGE))).toBe(false)
    // Within the cap as plain data, past it as the JSON text a frame sends
    expect(frame.post('"'.repeat(MAX_FRAME_MESSAGE / 2))).toBe(false)
    expect(frame.post(JSON.parse('{"__proto__": 1}'))).toBe(false)
    expect(frame.post(nested(MAX_DEPTH + 1))).toBe(false)
    expect(frame.post(undefined)).toBe(false)
    expect(frame.post('x'.repeat(MAX_FRAME_MESSAGE - 16))).toBe(true)
    await settled()
    expect(heard).toHaveLength(1)
  })

  it(`drops a frame's messages past ${FRAME_MESSAGES_PER_SECOND} a second, as hetu's drawer does`, async () => {
    const { drawer, heard, settled, board } = await started()
    const frame = drawer.mountFrame(board)
    for (let at = 0; at < FRAME_MESSAGES_PER_SECOND; at++) expect(frame.post(at)).toBe(true)
    expect(frame.post('one more')).toBe(false)
    await settled()
    expect(heard).toHaveLength(FRAME_MESSAGES_PER_SECOND)
  })

  it('refuses a worker\'s post past the cap or not plain data, to a view drawn as a tree and to a frame not yet loaded', async () => {
    const { drawer, ctx, board, list } = await started()
    await expect(ctx.ui.views.post(board, { early: true })).rejects.toMatchObject({ code: 'unavailable' })
    const frame = drawer.mountFrame(board)
    await expect(ctx.ui.views.post(board, 'x'.repeat(MAX_FRAME_MESSAGE))).rejects.toMatchObject({ code: 'invalid' })
    await expect(ctx.ui.views.post(board, nested(MAX_DEPTH + 1))).rejects.toMatchObject({ code: 'invalid' })
    await expect(ctx.ui.views.post(list, { tree: true })).rejects.toMatchObject({ code: 'not-found' })
    await ctx.ui.views.post(board, { cards: ['a'] })
    expect(frame.received).toEqual([{ cards: ['a'] }])
    expect(() => drawer.mountFrame(list)).toThrow()
  })

  it('ends a frame with its view, so neither side reaches the other', async () => {
    const { drawer, ctx, heard, settled, board } = await started()
    const frame = drawer.mountFrame(board)
    await ctx.ui.views.close(board)
    expect(frame.post({ late: true })).toBe(false)
    await expect(ctx.ui.views.post(board, { late: true })).rejects.toMatchObject({ code: 'not-found' })
    await settled()
    expect(heard).toEqual([])
  })

  it('hands a frame the theme the test set, with its mount and on each change after', async () => {
    const { drawer, board } = await started()
    const frame = drawer.mountFrame(board)
    expect(frame.theme()).toEqual({})
    const told: unknown[] = []
    frame.onTheme(theme => told.push(theme))
    drawer.changeTheme({ '--hetu-color-bg': '#202020' })
    expect(frame.theme()).toEqual({ '--hetu-color-bg': '#202020' })
    expect(told).toEqual([{ '--hetu-color-bg': '#202020' }])
    expect(drawer.mountFrame(board).theme()).toEqual({ '--hetu-color-bg': '#202020' })
  })

  it('takes nothing from a frame once its plugin no longer holds ui.view, as hetu\'s drawer drops it', async () => {
    const { drawer, heard, settled, board } = await started()
    const frame = drawer.mountFrame(board)
    drawer.connect([], manifest.views as never)
    expect(frame.post({ after: true })).toBe(false)
    await settled()
    expect(heard).toEqual([])
  })
})

describe('opens and drags from a frame in the fake drawer', () => {
  // kanban reads notes/** and its board frame is mounted. The luoshu holds a note outside that too
  async function opening() {
    const drawer = new FakeDrawer()
    const capabilities = [{ type: 'ui.view' }, { type: 'luoshu.read', paths: ['notes/**'] }]
    const made = fakeCore({ manifest: { ...manifest, capabilities }, drawer, notes: { 'notes/a.md': 'aye', 'notes/b.md': 'bee', 'secret/c.md': 'see' } })
    cores.push(made)
    const plugin = definePlugin({ start() {} })
    await made.start(plugin)
    const board = drawer.instances().find(each => each.view === 'board')!.instance
    return { drawer, made, plugin, frame: drawer.mountFrame(board) }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens a note as the human\'s only once after the test says the human pressed the frame, and in the background otherwise', async () => {
    const { drawer, frame } = await opening()
    frame.pressed()
    const opened = frame.open('notes/a.md')
    expect(opened).not.toBeNull()
    expect(drawer.isHuman(opened!)).toBe(true)
    expect(drawer.text(opened!)).toBe('aye')
    const background = frame.open('notes/b.md')
    expect(background).not.toBeNull()
    expect(drawer.isHuman(background!)).toBe(false)
    expect(drawer.opened).toEqual(['notes/b.md'])
  })

  it(`opens in the background past ${OPEN_GRACE_MS} ms after the press, and nothing outside the plugin's read`, async () => {
    const { drawer, frame } = await opening()
    vi.useFakeTimers({ toFake: ['Date'] })
    frame.pressed()
    vi.setSystemTime(Date.now() + OPEN_GRACE_MS + 1)
    const late = frame.open('notes/a.md')
    expect(drawer.isHuman(late!)).toBe(false)
    expect(frame.open('secret/c.md')).toBeNull()
    expect(drawer.opened).toEqual(['notes/a.md'])
  })

  it('opens a dragged note as the human\'s once on a drop of its token, and nothing for a replay, an unknown token or other text', async () => {
    const { drawer, frame } = await opening()
    const token = frame.dragToken('notes/b.md')
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    const opened = drawer.drop(`${DRAG_PREFIX}${token}`)
    expect(opened).not.toBeNull()
    expect(drawer.isHuman(opened!)).toBe(true)
    expect(drawer.text(opened!)).toBe('bee')
    expect(drawer.drop(`${DRAG_PREFIX}${token}`)).toBeNull()
    expect(drawer.drop(`${DRAG_PREFIX}${'f'.repeat(32)}`)).toBeNull()
    expect(drawer.drop('notes/b.md')).toBeNull()
  })

  it('mints no token for a note outside the plugin\'s read, and refuses one past its time or from an earlier run', async () => {
    const { drawer, made, plugin, frame } = await opening()
    expect(frame.dragToken('secret/c.md')).toBeNull()
    const late = frame.dragToken('notes/a.md')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + DRAG_TOKEN_MS + 1)
    expect(drawer.drop(`${DRAG_PREFIX}${late}`)).toBeNull()
    vi.useRealTimers()
    const earlier = frame.dragToken('notes/a.md')
    await made.stop()
    await made.start(plugin)
    expect(drawer.drop(`${DRAG_PREFIX}${earlier}`)).toBeNull()
  })

  it('takes Enter in the frame holding focus from a press and the release of a long press as the human\'s press, as hetu\'s drawer does', async () => {
    const { drawer, frame } = await opening()
    // Enter counts only in the frame holding focus from a press, so one with no press before counts nothing
    expect(frame.keyed()).toBe(false)
    vi.useFakeTimers({ toFake: ['Date'] })
    frame.pressed()
    vi.setSystemTime(Date.now() + OPEN_GRACE_MS + 1)
    expect(frame.keyed()).toBe(true)
    expect(drawer.isHuman(frame.open('notes/a.md')!)).toBe(true)
    drawer.pressedElsewhere()
    expect(frame.keyed()).toBe(false)
    frame.pressed()
    vi.setSystemTime(Date.now() + 2000)
    frame.released()
    expect(drawer.isHuman(frame.open('notes/b.md')!)).toBe(true)
  })

  it('opens, mints and takes a drop for nothing once the plugin no longer holds ui.view', async () => {
    const { drawer, frame } = await opening()
    const token = frame.dragToken('notes/a.md')
    drawer.connect([{ type: 'luoshu.read', paths: ['notes/**'] }], manifest.views as never, path => (path === 'notes/a.md' ? 'aye' : undefined))
    frame.pressed()
    expect(frame.open('notes/a.md')).toBeNull()
    expect(frame.dragToken('notes/a.md')).toBeNull()
    expect(drawer.drop(`${DRAG_PREFIX}${token}`)).toBeNull()
  })

  it(`holds ${DRAG_TOKENS_PER_PLUGIN} tokens, its oldest going first`, async () => {
    const { drawer, frame } = await opening()
    // A hundred asks a second, within what a frame may ask
    vi.useFakeTimers({ toFake: ['Date'] })
    const minted = Array.from({ length: DRAG_TOKENS_PER_PLUGIN + 1 }, (_, at) => {
      if (at % 100 === 0) vi.setSystemTime(Date.now() + 1000)
      return frame.dragToken('notes/a.md')
    })
    expect(minted.every(token => token !== null)).toBe(true)
    expect(drawer.drop(`${DRAG_PREFIX}${minted[0]}`)).toBeNull()
    expect(drawer.drop(`${DRAG_PREFIX}${minted[1]}`)).not.toBeNull()
  })
})
