import { describe, expect, it } from 'vitest'
import type { CoreViewsPlugin } from '../api/actions.ts'
import type { UiNode } from '../api/ui.ts'
import { Drawer, NODES_PER_SECOND, type PortLike } from '../frontend/editor/bridge.ts'
import { CoreLink } from '../frontend/editor/link.ts'
import type { Arrangement } from '../frontend/editor/layout/arrange.ts'
import type { SettingsValue } from '../frontend/editor/settings.ts'
import { LAYOUT_OWNER, SKELETON } from '../frontend/editor/ui-port.ts'
import { fakeCore, settle } from './editor-fakes.ts'

type Reach = { read?: string[], list?: string[], uiRead?: string[], verbs?: string[] }

function port() {
  const sent: Record<string, unknown>[] = []
  const made: PortLike & { closed: boolean } = {
    closed: false,
    onmessage: null,
    postMessage(message: unknown) {
      sent.push(JSON.parse(message as string) as Record<string, unknown>)
    },
    close() {
      made.closed = true
    },
  }
  let id = 0
  const call = async (verb: string, args?: unknown) => {
    const n = ++id
    made.onmessage?.({ data: JSON.stringify({ v: 1, kind: 'call', id: n, verb, args }) })
    for (let i = 0; i < 4; i++) await settle()
    return sent.find(message => message.kind === 'reply' && message.id === n)
  }
  const events = (topic?: string) => sent.filter(message => message.kind === 'event' && (topic === undefined || message.topic === topic))
  return { port: made, sent, call, events }
}

const kanban: CoreViewsPlugin = {
  plugin: 'kanban', name: 'Kanban', running: true, worker: true, theme: null, views: { board: { title: 'Board', kind: 'view' } },
}
const files: CoreViewsPlugin = {
  plugin: 'files', name: 'Files', running: true, worker: true, theme: null, views: { tree: { title: 'Files', kind: 'view' } },
}

function started(reach: Record<string, Reach>, settings: Partial<SettingsValue> = {}, clock?: () => number) {
  const core = fakeCore({
    'events.subscribe': () => ({ ok: true, result: { standing: [] } }),
    'gate.reach': args => {
      const { plugin, path } = args as { plugin: string, path?: string }
      const held = reach[plugin]
      if (held === undefined) return { ok: false, refusal: { code: 'policy-down' } }
      const has = (list?: string[]) => path !== undefined && (list ?? []).includes(path)
      return { ok: true, result: { read: has(held.read), edit: false, uiRead: has(held.uiRead), list: has(held.list) || has(held.read), verbs: held.verbs ?? [] } }
    },
  })
  const link = new CoreLink(core.bridge)
  link.start()
  const value: SettingsValue = { theme: null, favorites: [], keyOwners: {}, ...settings }
  const drawn: string[] = []
  const opened: string[] = []
  // What the plugin's reach answered for each path the page resolved a note to
  const resolved: Record<string, boolean> = {}
  const posted: unknown[] = []
  // Each arrangement the layout asked the page to keep
  const arranged: Arrangement[] = []
  let changed = 0
  const drawer = new Drawer(link, () => [], () => {}, {
    clock,
    ui: {
      settings: () => value,
      hooks: {
        drawn: (owner, surface) => void drawn.push(`${owner} ${surface}`),
        changed: () => void changed++,
        arranged: arrangement => void arranged.push(structuredClone(arrangement)),
        post: (owner, instance, data) => {
          posted.push([owner, instance, data])
          return null
        },
        open: async (path, reads) => {
          opened.push(path)
          // The path the luoshu would answer, a junction public/link to private standing in
          const at = path.replace(/^public\/link\//, 'private/')
          resolved[at] = await reads(at)
        },
      },
    },
  })
  drawer.start()
  drawer.ui.views.declared([kanban, files])
  return { core, drawer, drawn, opened, resolved, posted, value, arranged, changes: () => changed }
}

const text = (id: string, value: string): UiNode => ({ kind: 'text', id, text: value })
const viewer: Reach = { verbs: ['ui.view'] }

async function connected(drawer: Drawer, plugin: string) {
  const made = port()
  drawer.connect(plugin, 1, made.port)
  for (let i = 0; i < 4; i++) await settle()
  return made
}

describe('views on the drawer port', () => {
  it('opens a view\'s first instance when its owner connects holding ui.view, and draws only the owner\'s own', async () => {
    const { drawer, drawn } = started({ kanban: viewer, files: viewer })
    const board = await connected(drawer, 'kanban')
    const tree = await connected(drawer, 'files')
    expect(board.events('view.opened')).toEqual([{ v: 1, kind: 'event', topic: 'view.opened', instance: 'v1', view: 'board' }])
    expect(await board.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: text('a', 'cards') }] })).toMatchObject({ ok: true })
    expect(await tree.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: text('a', 'stolen') }] })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await tree.call('view.draw', { instance: 'v9', ops: [{ op: 'tree', root: text('a', 'x') }] })).toMatchObject({ ok: false, refusal: { code: 'not-found' } })
    expect(drawer.ui.surfaces.tree('kanban', 'v1')).toEqual(text('a', 'cards'))
    expect(drawn).toEqual(['kanban v1'])
  })

  it('refuses every view verb without ui.view', async () => {
    const { drawer } = started({ kanban: { verbs: ['ui.decoration'] } })
    const board = await connected(drawer, 'kanban')
    expect(board.events('view.opened')).toEqual([])
    for (const [verb, args] of [
      ['view.open', { view: 'board' }], ['view.draw', { instance: 'v1', ops: [] }], ['view.title', { instance: 'v1', title: 'x' }],
      ['view.post', { instance: 'v1', data: 1 }], ['view.bind', { bindings: [] }], ['view.close', { instance: 'v1' }], ['editor.open', { path: 'a.md' }],
    ] as const) {
      expect(await board.call(verb, args), verb).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    }
  })

  it('answers invalid for a refused tree and keeps what the view had', async () => {
    const { drawer } = started({ kanban: viewer })
    const board = await connected(drawer, 'kanban')
    await board.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: text('a', 'one') }] })
    expect(await board.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: { kind: 'slot', id: 's', instance: 'v1' } }] }))
      .toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    expect(await board.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: { kind: 'box', id: 'b', style: { position: 'fixed' } } }] }))
      .toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    expect(drawer.ui.surfaces.tree('kanban', 'v1')).toEqual(text('a', 'one'))
  })

  it(`throttles a plugin whose draws looked at more than ${NODES_PER_SECOND} nodes in a second, before the draw applies`, async () => {
    let now = 0
    const { drawer } = started({ kanban: viewer }, {}, () => now)
    const board = await connected(drawer, 'kanban')
    const big = { kind: 'box', id: 'root', children: Array.from({ length: 9_999 }, (_, i) => text(`t${i}`, 'x')) }
    const draws = Math.floor(NODES_PER_SECOND / 10_000)
    for (let i = 0; i < draws; i++) expect(await board.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: big }] })).toMatchObject({ ok: true })
    expect(await board.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: big }] })).toMatchObject({ ok: true })
    expect(await board.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: text('a', 'late') }] })).toMatchObject({ ok: false, refusal: { code: 'throttled' } })
    expect(drawer.ui.surfaces.tree('kanban', 'v1')).toEqual(big)
    now = 1000
    expect(await board.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: text('a', 'late') }] })).toMatchObject({ ok: true })
  })

  it('refuses a draw whose operations would look at more nodes than the second has left, before it applies', async () => {
    const { drawer } = started({ kanban: viewer }, {}, () => 0)
    const board = await connected(drawer, 'kanban')
    const big = { kind: 'box', id: 'root', children: Array.from({ length: 9_999 }, (_, i) => text(`t${i}`, 'x')) }
    expect(await board.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: big }] })).toMatchObject({ ok: true })
    // Each operation may walk the whole tree, so 100 on a tree of 10,000 may look at a million nodes
    const ops = Array.from({ length: 100 }, (_, i) => ({ op: 'text', id: `t${9_998 - i}`, text: 'y' }))
    expect(await board.call('view.draw', { instance: 'v1', ops })).toMatchObject({ ok: false, refusal: { code: 'throttled' } })
    expect(drawer.ui.surfaces.tree('kanban', 'v1')).toEqual(big)
    expect(await board.call('view.draw', { instance: 'v1', ops: ops.slice(0, 1) })).toMatchObject({ ok: true })
  })

  it('opens and closes more instances, and drops a closed one\'s tree', async () => {
    const { drawer } = started({ kanban: viewer })
    const board = await connected(drawer, 'kanban')
    expect(await board.call('view.open', { view: 'board' })).toMatchObject({ ok: true, result: { instance: 'v2' } })
    await board.call('view.draw', { instance: 'v2', ops: [{ op: 'tree', root: text('a', 'two') }] })
    expect(await board.call('view.close', { instance: 'v2' })).toMatchObject({ ok: true })
    expect(drawer.ui.surfaces.tree('kanban', 'v2')).toBe(null)
    expect(await board.call('view.open', { view: 'tree' })).toMatchObject({ ok: false, refusal: { code: 'not-found' } })
  })

  it('relays a frame view\'s message only from its owner', async () => {
    const { drawer, posted } = started({ kanban: viewer, files: viewer })
    const board = await connected(drawer, 'kanban')
    const tree = await connected(drawer, 'files')
    expect(await board.call('view.post', { instance: 'v1', data: { cards: 2 } })).toMatchObject({ ok: true })
    expect(await tree.call('view.post', { instance: 'v1', data: 'x' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(posted).toEqual([['kanban', 'v1', { cards: 2 }]])
  })

  it('hands what a frame sent to its own owner\'s worker only', async () => {
    const { drawer } = started({ kanban: viewer, files: viewer })
    const board = await connected(drawer, 'kanban')
    const tree = await connected(drawer, 'files')
    drawer.ui.frameMessage('kanban', 'v1', { moved: 'a' })
    drawer.ui.frameMessage('files', 'v1', { stolen: true })
    expect(board.events('view.message')).toEqual([{ v: 1, kind: 'event', topic: 'view.message', instance: 'v1', data: { moved: 'a' } }])
    expect(tree.events('view.message')).toEqual([])
  })

  it('drops everything a plugin drew and puts its views down when its port ends', async () => {
    const { drawer } = started({ kanban: viewer })
    await connected(drawer, 'kanban')
    await (await connected(drawer, 'kanban')).call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: text('a', 'x') }] })
    drawer.end('kanban', 1)
    expect(drawer.ui.surfaces.tree('kanban', 'v1')).toBe(null)
    expect(drawer.ui.views.get('v1')?.down).toBe(true)
  })

  it('takes back a plugin\'s views once it no longer holds ui.view', async () => {
    const reach: Record<string, Reach> = { kanban: viewer }
    const { drawer, core } = started(reach)
    const board = await connected(drawer, 'kanban')
    await board.call('view.draw', { instance: 'v1', ops: [{ op: 'tree', root: text('a', 'x') }] })
    reach.kanban = { verbs: [] }
    core.event('core.security')
    for (let i = 0; i < 4; i++) await settle()
    expect(drawer.ui.surfaces.tree('kanban', 'v1')).toBe(null)
    expect(drawer.ui.views.get('v1')?.down).toBe(true)
  })
})

describe("the drawer's own layout on the drawer port", () => {
  const skeleton: UiNode = { kind: 'box', id: 'root', children: [{ kind: 'editor', id: 'e', instance: 'current' }, { kind: 'slot', id: 's', instance: 'v1' }] }
  const stateOf = (drawer: Drawer, width = 1400) => ({ width, height: 900, views: drawer.ui.views.list([]), editors: ['n1'], current: 'n1', slots: {} })
  const nodes = (tree: UiNode | null): UiNode[] => (tree === null ? [] : [tree, ...((tree as { children?: UiNode[] }).children ?? []).flatMap(nodes)])
  const shown = (drawer: Drawer) => nodes(drawer.ui.surfaces.tree(LAYOUT_OWNER, SKELETON)).filter(node => node.kind === 'slot').map(node => (node as { instance: string }).instance)

  it('draws its skeleton under hetu once the arrangement loaded and it heard the window\'s state', async () => {
    const { drawer, drawn } = started({ kanban: viewer })
    await connected(drawer, 'kanban')
    drawer.ui.state(stateOf(drawer))
    expect(drawer.ui.drawing()).toBe(null)
    expect(drawn).toEqual([])
    drawer.ui.arrangementLoaded(null)
    expect(LAYOUT_OWNER).toBe('hetu')
    expect(drawer.ui.drawing()).toBe('hetu')
    expect(drawn).toEqual(['hetu layout'])
    expect(nodes(drawer.ui.surfaces.tree('hetu', SKELETON)).some(node => node.kind === 'editor')).toBe(true)
    expect(shown(drawer)).toEqual(['v1'])
  })

  // The window draws hetu's layout and layout.draw is no verb, so no plugin draws a skeleton, one called layout included
  it('refuses a skeleton from every plugin as an unknown call and tells no plugin of the window', async () => {
    const { drawer, drawn } = started({ layout: viewer, kanban: viewer })
    const own = await connected(drawer, 'layout')
    const board = await connected(drawer, 'kanban')
    drawer.ui.arrangementLoaded(null)
    expect(await own.call('layout.draw', { ops: [{ op: 'tree', root: skeleton }] })).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    expect(drawer.ui.surfaces.tree('layout', SKELETON)).toBe(null)
    drawer.ui.state(stateOf(drawer))
    drawer.ui.nodeEvent('layout', SKELETON, 'bottom-toggle', 'click')
    drawer.ui.resized('layout', SKELETON, 'columns', [300, 860])
    drawer.ui.viewDropped('v1', 'right', 0.25, 0.5)
    expect(drawn).toEqual(['hetu layout', 'hetu layout'])
    expect([...own.events(), ...board.events()].filter(event => String(event.topic).startsWith('layout.'))).toEqual([])
  })

  it('moves a view the human dropped, hides and shows one from the menu and keeps each in the settings', async () => {
    const { drawer, arranged } = started({ kanban: viewer, files: viewer })
    await connected(drawer, 'kanban')
    await connected(drawer, 'files')
    drawer.ui.arrangementLoaded(null)
    drawer.ui.state(stateOf(drawer))
    expect(shown(drawer).sort()).toEqual(['v1', 'v2'])
    drawer.ui.viewDropped('v1', 'right', 1, 0.5)
    expect(arranged.at(-1)?.places['kanban/board']).toEqual({ column: 'right', order: 1, byHand: true })
    drawer.ui.closeView('v1')
    expect(arranged.at(-1)?.hidden).toEqual(['kanban/board'])
    expect(shown(drawer)).toEqual(['v2'])
    drawer.ui.openView('v1')
    expect(arranged.at(-1)?.hidden).toEqual([])
    expect(shown(drawer)).toEqual(['v1'])
    drawer.ui.viewDropped('v9', 'left', 0, 0)
    expect(arranged).toHaveLength(3)
  })

  it('takes the human\'s clicks and resizes on its skeleton', async () => {
    const { drawer, arranged } = started({ kanban: viewer, files: viewer })
    await connected(drawer, 'kanban')
    await connected(drawer, 'files')
    drawer.ui.arrangementLoaded({ places: { 'kanban/board': { column: 'left', order: 0 }, 'files/tree': { column: 'left', order: 1 } } })
    drawer.ui.state(stateOf(drawer))
    expect(shown(drawer)).toEqual(['v1'])
    drawer.ui.nodeEvent(LAYOUT_OWNER, SKELETON, 't-v2', 'click')
    expect(shown(drawer)).toEqual(['v2'])
    drawer.ui.resized(LAYOUT_OWNER, SKELETON, 'columns', [310, 1090])
    expect(arranged.at(-1)?.widths.left).toBe(310)
  })

  it('draws again only when the window\'s state changed', async () => {
    const { drawer, drawn } = started({ kanban: viewer })
    await connected(drawer, 'kanban')
    drawer.ui.arrangementLoaded(null)
    drawer.ui.state(stateOf(drawer))
    drawer.ui.state(stateOf(drawer))
    expect(drawn).toEqual(['hetu layout'])
    drawer.ui.state(stateOf(drawer, 900))
    expect(drawn).toEqual(['hetu layout', 'hetu layout'])
  })

  // The plain layout draws while the layout can't, so notes still open
  it('draws the plain layout once its skeleton is refused, tells the page, and its own again at the next good draw', async () => {
    const { drawer, changes } = started({ kanban: viewer })
    await connected(drawer, 'kanban')
    drawer.ui.arrangementLoaded(null)
    drawer.ui.state(stateOf(drawer))
    expect(drawer.ui.drawing()).toBe('hetu')
    const before = changes()
    const [board] = drawer.ui.views.list([])
    // Two views with one instance draw one id twice, which the tree's check refuses
    drawer.ui.state({ ...stateOf(drawer), views: [board!, { ...board!, view: 'other' }] })
    expect(drawer.ui.drawing()).toBe(null)
    expect(changes()).toBeGreaterThan(before)
    drawer.ui.state(stateOf(drawer))
    expect(drawer.ui.drawing()).toBe('hetu')
  })
})

describe('events from the human, by owner', () => {
  it('sends a node\'s event to the owner of its surface only', async () => {
    const { drawer } = started({ layout: viewer, kanban: viewer, files: viewer })
    const own = await connected(drawer, 'layout')
    const board = await connected(drawer, 'kanban')
    const tree = await connected(drawer, 'files')
    drawer.ui.nodeEvent('kanban', 'v1', 'add', 'click')
    drawer.ui.nodeEvent('kanban', 'v1', 'name', 'input', 'Plans')
    drawer.ui.nodeEvent('layout', 'layout', 'tab-1', 'click')
    drawer.ui.nodeEvent('files', 'v1', 'x', 'click')
    expect(board.events('view.event')).toEqual([
      { v: 1, kind: 'event', topic: 'view.event', instance: 'v1', node: 'add', type: 'click' },
      { v: 1, kind: 'event', topic: 'view.event', instance: 'v1', node: 'name', type: 'input', value: 'Plans' },
    ])
    expect(own.events()).toEqual([])
    expect(tree.events('view.event')).toEqual([])
  })

  it('hands a dropped payload to the target\'s owner and a dropped view to the drawer\'s layout', async () => {
    const { drawer, arranged } = started({ kanban: viewer })
    const board = await connected(drawer, 'kanban')
    drawer.ui.arrangementLoaded(null)
    drawer.ui.state({ width: 1400, height: 900, views: drawer.ui.views.list([]), editors: ['n1'], current: 'n1', slots: {} })
    drawer.ui.nodeEvent('kanban', 'v1', 'lane', 'drop', undefined, { type: 'note', value: 'a.md' })
    drawer.ui.viewDropped('v1', 'right', 0.25, 0.5)
    expect(board.events('view.event')).toEqual([{ v: 1, kind: 'event', topic: 'view.event', instance: 'v1', node: 'lane', type: 'drop', payload: { type: 'note', value: 'a.md' } }])
    expect(board.events().filter(event => String(event.topic).startsWith('layout.'))).toEqual([])
    expect(arranged.at(-1)?.places['kanban/board']).toMatchObject({ column: 'right', byHand: true })
  })
})

describe('editor.open', () => {
  // A real read only: a note a plugin opens is never the human's, so it can't hand ui.read a note to read
  it('opens a note inside the plugin\'s read scope and refuses one it only lists or reaches on ui.read, before anything is read', async () => {
    const { drawer, opened, core } = started({ kanban: { verbs: ['ui.view'], read: ['a.md'], list: ['names/b.md'], uiRead: ['shown/c.md'] } })
    const board = await connected(drawer, 'kanban')
    expect(await board.call('editor.open', { path: 'a.md' })).toMatchObject({ ok: true })
    expect(await board.call('editor.open', { path: 'names/b.md' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await board.call('editor.open', { path: 'shown/c.md' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await board.call('editor.open', { path: 'secret.md' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(opened).toEqual(['a.md'])
    expect(core.calls('luoshu.read')).toEqual([])
  })

  // The page reads the note, then asks whether the plugin reads where it is before anything opens
  it('hands the page the plugin\'s read of the path the luoshu resolved, so a spelling through a link is judged where it leads', async () => {
    const { drawer, resolved } = started({ kanban: { verbs: ['ui.view'], read: ['public/link/x.md', 'public/a.md'] } })
    const board = await connected(drawer, 'kanban')
    expect(await board.call('editor.open', { path: 'public/link/x.md' })).toMatchObject({ ok: true })
    expect(await board.call('editor.open', { path: 'public/a.md' })).toMatchObject({ ok: true })
    expect(resolved).toEqual({ 'private/x.md': false, 'public/a.md': true })
  })

  // A frame's open with no press of the human's behind it goes the same way
  it('opens the same way for a frame\'s open with no press behind it, a real read only and judged where the path leads', async () => {
    const { drawer, opened, resolved, core } = started({ kanban: { verbs: ['ui.view'], read: ['a.md', 'public/link/x.md'], list: ['names/b.md'], uiRead: ['shown/c.md'] } })
    await connected(drawer, 'kanban')
    await drawer.ui.pluginOpen('kanban', 'a.md')
    for (const path of ['names/b.md', 'shown/c.md', 'secret.md']) await expect(drawer.ui.pluginOpen('kanban', path)).rejects.toMatchObject({ code: 'not-granted' })
    await drawer.ui.pluginOpen('kanban', 'public/link/x.md')
    expect(opened).toEqual(['a.md', 'public/link/x.md'])
    expect(resolved).toEqual({ 'a.md': true, 'private/x.md': false })
    expect(core.calls('luoshu.read')).toEqual([])
  })

  // A note dragged out of a frame is judged where the luoshu resolved it, as editor.open judges a plugin's open
  it('answers whether the plugin reads the path a note resolved to', async () => {
    const { drawer } = started({ kanban: { verbs: ['ui.view'], read: ['public/link/x.md'] } })
    const reads = drawer.ui.resolvedReads('kanban')
    expect(await reads('public/link/x.md')).toBe(true)
    expect(await reads('private/x.md')).toBe(false)
  })

  // From a frame, held to the item and the live port its worker's editor.open is held to
  it('opens from a frame only while the plugin holds ui.view and its worker is connected', async () => {
    const { drawer, opened } = started({ kanban: { verbs: ['ui.view'], read: ['a.md'] }, files: { verbs: [], read: ['a.md'] } })
    await expect(drawer.frameOpen('kanban', 'a.md')).rejects.toMatchObject({ code: 'stopped' })
    await connected(drawer, 'files')
    await expect(drawer.frameOpen('files', 'a.md')).rejects.toMatchObject({ code: 'not-granted' })
    await connected(drawer, 'kanban')
    await drawer.frameOpen('kanban', 'a.md')
    expect(opened).toEqual(['a.md'])
  })
})

describe('keys in the design\'s order', () => {
  it('fires a view\'s own binding only while focus is in one of its instances, bare keys included', async () => {
    const { drawer } = started({ kanban: viewer, files: viewer })
    const board = await connected(drawer, 'kanban')
    await connected(drawer, 'files')
    expect(await board.call('view.bind', { bindings: [{ key: 'j', command: 'down' }] })).toMatchObject({ ok: true })
    expect(drawer.viewKey('v1', 'j')).toBe(true)
    expect(drawer.viewKey('v2', 'j')).toBe(false)
    await settle()
    expect(board.events('view.command')).toEqual([{ v: 1, kind: 'event', topic: 'view.command', instance: 'v1', command: 'down' }])
  })

  it('tells main the keys a plugin\'s views bound named the page\'s way each time they change and none once its port ends', async () => {
    const { drawer } = started({ kanban: viewer })
    const told: [string, string[]][] = []
    drawer.ui.onBindings = (owner, keys) => told.push([owner, keys])
    const board = await connected(drawer, 'kanban')
    await board.call('view.bind', { bindings: [{ key: 'J', command: 'down' }, { key: 'Ctrl-k', command: 'up' }] })
    await board.call('view.bind', { bindings: [{ key: 'x', command: 'cut' }] })
    expect(await board.call('view.bind', { bindings: [{ key: 'Mod-s', command: 'x' }] })).toMatchObject({ ok: false })
    drawer.end('kanban', 1)
    expect(told).toEqual([['kanban', ['j', 'Mod-k']], ['kanban', ['x']], ['kanban', []]])
  })

  it('refuses a view binding on a core key', async () => {
    const { drawer } = started({ kanban: viewer })
    const board = await connected(drawer, 'kanban')
    for (const key of ['Mod-/', 'Ctrl-s', 'Mod-q']) {
      expect(await board.call('view.bind', { bindings: [{ key, command: 'x' }] }), key).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    }
  })

  it('falls back from a view to the global bindings', async () => {
    const { drawer } = started({ kanban: { verbs: ['ui.view', 'ui.command'] } })
    const board = await connected(drawer, 'kanban')
    await board.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'palette' }] })
    expect(drawer.viewKey('v1', 'Mod-k')).toBe(true)
    await settle()
    expect(board.events('editor.command')).toEqual([{ v: 1, kind: 'event', topic: 'editor.command', command: 'palette', instance: null }])
  })

  it('fires a key two plugins bind for neither until the human picks its owner', async () => {
    const { drawer, value } = started({ alpha: { verbs: ['ui.command'] }, beta: { verbs: ['ui.command'] } })
    const alpha = await connected(drawer, 'alpha')
    const beta = await connected(drawer, 'beta')
    await alpha.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'a' }] })
    await beta.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'b' }] })
    expect(drawer.conflicts()).toEqual([{ key: 'Mod-k', plugins: ['alpha', 'beta'] }])
    expect(drawer.key(null, 'Mod-k')).toBe(false)
    value.keyOwners = { 'Mod-k': 'beta' }
    expect(drawer.key(null, 'Mod-k')).toBe(true)
    await settle()
    expect(alpha.events('editor.command')).toEqual([])
    expect(beta.events('editor.command')).toEqual([{ v: 1, kind: 'event', topic: 'editor.command', command: 'b', instance: null }])
  })
})
