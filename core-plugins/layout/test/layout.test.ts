import path from 'node:path'
import { type FakeCore, fakeCore, FakeDrawer } from '@hetu/sdk/testing'
import type { LayoutState, LayoutView, UiNode } from '@hetu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import layout from '../src/worker.ts'

const manifest = path.join(import.meta.dirname, '..', 'hetu-plugin.json')
const cores: FakeCore[] = []

afterEach(async () => {
  for (const core of cores.splice(0)) await core.close()
})

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(5)
  }
}

const view = (instance: string, name: string, extra: Partial<LayoutView> = {}): LayoutView => ({
  instance, owner: 'p', view: name, kind: 'view', title: name, size: {}, priority: null, favorite: null, down: false, ...extra,
})

const state = (over: Partial<LayoutState> = {}): LayoutState => ({
  width: 1400, height: 900, editors: ['n1'], current: 'n1', slots: {}, views: [view('v1', 'tree'), view('v2', 'board')], ...over,
})

function nodes(tree: UiNode | null): UiNode[] {
  if (tree === null) return []
  const kids = [...((tree as { children?: UiNode[] }).children ?? [])]
  return [tree, ...kids.flatMap(nodes)]
}

const columnOf = (tree: UiNode | null, instance: string) =>
  nodes(tree).find(node => node.id.startsWith('col-') && nodes(node).some(child => child.kind === 'slot' && (child as { instance?: string }).instance === instance))?.id

async function started(drawer = new FakeDrawer(), made?: FakeCore) {
  const core = made ?? fakeCore({ manifest, drawer })
  if (made === undefined) cores.push(core)
  expect(await core.start(layout)).toEqual({ state: 'ready' })
  return { core, drawer }
}

describe("hetu's layout", () => {
  it('draws the skeleton once it hears the window\'s state, the editor in main and new views in the sides', async () => {
    const { drawer } = await started()
    drawer.emit({ topic: 'layout.state', state: state() })
    await until(() => drawer.tree('layout') !== null)
    const tree = drawer.tree('layout')
    expect(nodes(tree).filter(node => node.kind === 'editor')).toEqual([expect.objectContaining({ instance: 'current' })])
    expect(columnOf(tree, 'v1')).toBe('col-left')
    expect(columnOf(tree, 'v2')).toBe('col-right')
  })

  it('moves a dropped view and keeps where the human put it', async () => {
    const { core, drawer } = await started()
    drawer.emit({ topic: 'layout.state', state: state() })
    await until(() => drawer.tree('layout') !== null)
    drawer.emit({ topic: 'layout.drop', instance: 'v2', zone: 'left', x: 0, y: 0.5 })
    await until(() => columnOf(drawer.tree('layout'), 'v2') === 'col-left')
    await until(() => (core.stored('storage', 'arrangement') as { places?: Record<string, unknown> } | undefined)?.places?.['p/board'] !== undefined)
    expect((core.stored('storage', 'arrangement') as { places: Record<string, unknown> }).places['p/board']).toEqual({ column: 'left', order: 0, byHand: true })
  })

  it('keeps the widths the human resized the sides to', async () => {
    const { core, drawer } = await started()
    drawer.emit({ topic: 'layout.state', state: state() })
    await until(() => drawer.tree('layout') !== null)
    drawer.emit({ topic: 'layout.resized', node: 'columns', sizes: [300, 860, 240] })
    await until(() => (core.stored('storage', 'arrangement') as { widths?: { left: number } } | undefined)?.widths?.left === 300)
    await until(() => (nodes(drawer.tree('layout')).find(node => node.id === 'columns') as { sizes?: number[] } | undefined)?.sizes?.[0] === 300)
  })

  it('keeps a resize the human made right before a stop, on storage slow to write', async () => {
    const drawer = new FakeDrawer()
    const core = fakeCore({ manifest, drawer, latencyMs: 600 })
    cores.push(core)
    await started(drawer, core)
    drawer.emit({ topic: 'layout.state', state: state() })
    await until(() => drawer.tree('layout') !== null)
    drawer.emit({ topic: 'layout.resized', node: 'columns', sizes: [300, 860, 240] })
    await until(() => (nodes(drawer.tree('layout')).find(node => node.id === 'columns') as { sizes?: number[] } | undefined)?.sizes?.[0] === 300)
    await core.stop()
    expect((core.stored('storage', 'arrangement') as { widths?: { left: number } } | undefined)?.widths?.left).toBe(300)
  })

  it('keeps a resize begun while the stop waits for an earlier write', async () => {
    const drawer = new FakeDrawer()
    const core = fakeCore({ manifest, drawer, latencyMs: 300 })
    cores.push(core)
    await started(drawer, core)
    drawer.emit({ topic: 'layout.state', state: state() })
    await until(() => drawer.tree('layout') !== null)
    drawer.emit({ topic: 'layout.resized', node: 'columns', sizes: [300, 860, 240] })
    await until(() => (nodes(drawer.tree('layout')).find(node => node.id === 'columns') as { sizes?: number[] } | undefined)?.sizes?.[0] === 300)
    const stopping = core.stop()
    await new Promise(resolve => setTimeout(resolve, 50))
    drawer.emit({ topic: 'layout.resized', node: 'columns', sizes: [411, 749, 240] })
    await stopping
    expect((core.stored('storage', 'arrangement') as { widths?: { left: number } } | undefined)?.widths?.left).toBe(411)
  })

  it('reads the arrangement back when it starts again', async () => {
    const drawer = new FakeDrawer()
    const core = fakeCore({ manifest, drawer })
    cores.push(core)
    await started(drawer, core)
    drawer.emit({ topic: 'layout.state', state: state() })
    await until(() => drawer.tree('layout') !== null)
    drawer.emit({ topic: 'layout.drop', instance: 'v2', zone: 'left', x: 1, y: 0 })
    await until(() => (core.stored('storage', 'arrangement') as { places?: Record<string, { column: string }> } | undefined)?.places?.['p/board']?.column === 'left')
    await core.stop()
    await started(drawer, core)
    drawer.emit({ topic: 'layout.state', state: state({ views: [view('v7', 'tree'), view('v8', 'board')] }) })
    await until(() => drawer.tree('layout') !== null)
    expect(columnOf(drawer.tree('layout'), 'v8')).toBe('col-left')
  })

  it('folds the lowest-ranked side to a rail in a narrow window and keeps a favorite open', async () => {
    const { drawer } = await started()
    drawer.emit({ topic: 'layout.state', state: state({ width: 560, views: [view('v1', 'tree'), view('v2', 'board', { favorite: 0 })] }) })
    await until(() => drawer.tree('layout') !== null)
    const ids = nodes(drawer.tree('layout')).map(node => node.id)
    expect(ids).toContain('rail-left')
    expect(ids).toContain('col-right')
  })

  it('shows a note the human opened in main, after a view was picked there', async () => {
    const { drawer } = await started()
    drawer.emit({ topic: 'layout.state', state: state() })
    await until(() => drawer.tree('layout') !== null)
    drawer.emit({ topic: 'layout.drop', instance: 'v2', zone: 'main', x: 1, y: 0 })
    await until(() => nodes(drawer.tree('layout')).every(node => node.kind !== 'editor'))
    drawer.emit({ topic: 'layout.state', state: state({ editors: ['n1', 'n2'], current: 'n2' }) })
    await until(() => nodes(drawer.tree('layout')).some(node => node.kind === 'editor'))
  })
})
