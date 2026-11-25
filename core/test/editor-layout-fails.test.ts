import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreViewsPlugin } from '../api/actions.ts'
import type { Layout } from '../frontend/editor/layout/layout.ts'
import { LAYOUT_OWNER, SKELETON, UiPort } from '../frontend/editor/ui-port.ts'

// The layout's calls that throw while named here, each before the layout's own code runs
const failing = vi.hoisted(() => new Set<string>())
vi.mock('../frontend/editor/layout/layout.ts', async real => {
  const actual = await real<typeof import('../frontend/editor/layout/layout.ts')>()
  return {
    ...actual,
    startLayout: (options: Parameters<typeof actual.startLayout>[0]): Layout => {
      const layout = actual.startLayout(options)
      return Object.fromEntries(Object.entries(layout).map(([name, call]) => [name, (...args: unknown[]) => {
        if (failing.has(name)) throw new Error(`${name} failed`)
        return (call as (...args: unknown[]) => void)(...args)
      }])) as Layout
    },
  }
})

afterEach(() => {
  failing.clear()
  vi.restoreAllMocks()
})

const board: CoreViewsPlugin = {
  plugin: 'kanban', name: 'Kanban', running: true, worker: true, theme: null, views: { board: { title: 'Board', kind: 'view' } },
}

function drawn() {
  const told = { changed: 0 }
  const ui = new UiPort({
    send: () => {},
    reach: async () => ({ read: false, list: false, verbs: [] }),
    hooks: { drawn() {}, changed: () => void told.changed++, arranged() {}, post: () => null, open: async () => {} },
    normal: key => key,
    reserved: () => false,
  })
  ui.views.declared([board])
  ui.held('kanban', ['ui.view'])
  const state = (width: number) => ({ width, height: 900, views: ui.views.list([]), editors: ['n1'], current: 'n1', slots: {} })
  ui.arrangementLoaded(null)
  ui.state(state(1400))
  return { ui, told, state }
}

describe("the drawer's layout failing", () => {
  const calls: [string, (ui: UiPort) => void][] = [
    ['state', ui => ui.state({ width: 1300, height: 900, views: ui.views.list([]), editors: ['n1'], current: 'n1', slots: {} })],
    ['drop', ui => ui.viewDropped('v1', 'right', 1, 0)],
    ['event', ui => ui.nodeEvent(LAYOUT_OWNER, SKELETON, 'bottom-toggle', 'click')],
    ['resized', ui => ui.resized(LAYOUT_OWNER, SKELETON, 'columns', [300, 1100])],
  ]
  for (const [name, call] of calls) {
    it(`draws the plain layout once ${name} throws, logs it, and its own again at the next good draw`, () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { ui, told, state } = drawn()
      expect(ui.drawing()).toBe('hetu')
      const before = told.changed
      failing.add(name)
      call(ui)
      expect(ui.drawing()).toBe(null)
      expect(told.changed).toBe(before + 1)
      expect(logged).toHaveBeenCalledTimes(1)
      expect(String(logged.mock.calls[0]?.join(' '))).toContain(`${name} failed`)
      failing.clear()
      ui.state(state(1200))
      expect(ui.drawing()).toBe('hetu')
    })
  }
})
