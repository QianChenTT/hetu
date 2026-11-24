import { afterEach, describe, expect, it } from 'vitest'
import { MAX_DEPTH } from '../api/plain.ts'
import { API_VERSION } from '../api/manifest.ts'
import { MAX_FRAME_MESSAGE } from '../api/ui-limits.ts'
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
})
