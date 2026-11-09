import { describe, expect, it } from 'vitest'
import type { CoreViewsPlugin } from '../api/actions.ts'
import type { UiNode } from '../api/ui.ts'
import { Drawer, NODES_PER_SECOND, type PortLike } from '../frontend/mount/bridge.ts'
import { CoreLink } from '../frontend/mount/link.ts'
import type { SettingsValue } from '../frontend/mount/settings.ts'
import { fakeCore, settle } from './mount-fakes.ts'

type Reach = { read?: string[], list?: string[], verbs?: string[] }

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
    'editor.reach': args => {
      const { plugin, path } = args as { plugin: string, path?: string }
      const held = reach[plugin]
      if (held === undefined) return { ok: false, refusal: { code: 'policy-down' } }
      const has = (list?: string[]) => path !== undefined && (list ?? []).includes(path)
      return { ok: true, result: { read: has(held.read), write: false, list: has(held.list) || has(held.read), verbs: held.verbs ?? [] } }
    },
  })
  const link = new CoreLink(core.bridge)
  link.start()
  const value: SettingsValue = { layout: null, theme: null, favorites: [], keys: {}, ...settings }
  const drawn: string[] = []
  const opened: string[] = []
  const posted: unknown[] = []
  let changed = 0
  const drawer = new Drawer(link, () => [], () => {}, {
    clock,
    ui: {
      settings: () => value,
      hooks: {
        drawn: (owner, surface) => void drawn.push(`${owner} ${surface}`),
        changed: () => void changed++,
        post: (owner, instance, data) => {
          posted.push([owner, instance, data])
          return null
        },
        open: async path => void opened.push(path),
      },
    },
  })
  drawer.start()
  drawer.ui.views.declared([kanban, files])
  return { core, drawer, drawn, opened, posted, value, changes: () => changed }
}

const text = (id: string, value: string): UiNode => ({ kind: 'text', id, text: value })
const viewer: Reach = { verbs: ['ui.view'] }
const layouter: Reach = { verbs: ['ui.layout'] }

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

describe('the layout on the drawer port', () => {
  const skeleton: UiNode = { kind: 'box', id: 'root', children: [{ kind: 'editor', id: 'e', instance: 'current' }, { kind: 'slot', id: 's', instance: 'v1' }] }

  it('takes a skeleton only from the layout the human picked, else hetu\'s own', async () => {
    const { drawer, drawn, value } = started({ layout: layouter, other: layouter, kanban: viewer })
    const own = await connected(drawer, 'layout')
    const other = await connected(drawer, 'other')
    expect(drawer.ui.layout()).toBe('layout')
    expect(await own.call('layout.draw', { ops: [{ op: 'tree', root: skeleton }] })).toMatchObject({ ok: true })
    expect(await other.call('layout.draw', { ops: [{ op: 'tree', root: skeleton }] })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(drawn).toEqual(['layout layout'])
    value.layout = 'other'
    drawer.ui.settingsChanged()
    expect(drawer.ui.layout()).toBe('other')
    expect(await other.call('layout.draw', { ops: [{ op: 'tree', root: skeleton }] })).toMatchObject({ ok: true })
  })

  it('refuses a skeleton from a plugin without ui.layout and a view placing slots', async () => {
    const { drawer } = started({ layout: viewer })
    const own = await connected(drawer, 'layout')
    expect(drawer.ui.layout()).toBe(null)
    expect(await own.call('layout.draw', { ops: [{ op: 'tree', root: skeleton }] })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it('draws the plain layout once the picked layout\'s port ends, and tells the page', async () => {
    const { drawer, changes } = started({ layout: layouter })
    await connected(drawer, 'layout')
    const before = changes()
    drawer.end('layout', 1)
    expect(drawer.ui.layout()).toBe(null)
    expect(changes()).toBeGreaterThan(before)
  })

  it('sends the layout its state when it changes and only to the layout', async () => {
    const { drawer } = started({ layout: layouter, kanban: viewer })
    const own = await connected(drawer, 'layout')
    const board = await connected(drawer, 'kanban')
    const state = { width: 800, height: 600, views: drawer.ui.views.list([]), editors: ['n1'], current: 'n1', slots: {} }
    drawer.ui.state(state)
    drawer.ui.state(state)
    expect(own.events('layout.state')).toEqual([{ v: 1, kind: 'event', topic: 'layout.state', state }])
    expect(board.events('layout.state')).toEqual([])
  })
})

describe('events from the human, by owner', () => {
  it('sends a node\'s event to the owner of its surface only', async () => {
    const { drawer } = started({ layout: layouter, kanban: viewer, files: viewer })
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
    expect(own.events('layout.event')).toEqual([{ v: 1, kind: 'event', topic: 'layout.event', node: 'tab-1', type: 'click' }])
    expect(tree.events('view.event')).toEqual([])
    expect(own.events('view.event')).toEqual([])
  })

  it('hands a dropped payload to the target\'s owner and a dropped view to the layout', async () => {
    const { drawer } = started({ layout: layouter, kanban: viewer })
    const own = await connected(drawer, 'layout')
    const board = await connected(drawer, 'kanban')
    drawer.ui.nodeEvent('kanban', 'v1', 'lane', 'drop', undefined, { type: 'note', value: 'a.md' })
    drawer.ui.viewDropped('v1', 'right', 0.25, 0.5)
    drawer.ui.resized('layout', 'layout', 'split', [200, 600])
    drawer.ui.openView('v1')
    expect(board.events('view.event')).toEqual([{ v: 1, kind: 'event', topic: 'view.event', instance: 'v1', node: 'lane', type: 'drop', payload: { type: 'note', value: 'a.md' } }])
    expect(own.events().map(event => event.topic)).toEqual(['layout.drop', 'layout.resized', 'layout.open'])
    expect(own.events('layout.drop')).toEqual([{ v: 1, kind: 'event', topic: 'layout.drop', instance: 'v1', zone: 'right', x: 0.25, y: 0.5 }])
  })
})

describe('editor.open', () => {
  it('opens a note inside the plugin\'s read or list scope and refuses one outside before anything is read', async () => {
    const { drawer, opened, core } = started({ kanban: { verbs: ['ui.view'], read: ['a.md'], list: ['names/b.md'] } })
    const board = await connected(drawer, 'kanban')
    expect(await board.call('editor.open', { path: 'a.md' })).toMatchObject({ ok: true })
    expect(await board.call('editor.open', { path: 'names/b.md' })).toMatchObject({ ok: true })
    expect(await board.call('editor.open', { path: 'secret.md' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(opened).toEqual(['a.md', 'names/b.md'])
    expect(core.calls('luoshu.read')).toEqual([])
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

  it('refuses a view binding on a core key', async () => {
    const { drawer } = started({ kanban: viewer })
    const board = await connected(drawer, 'kanban')
    for (const key of ['Mod-/', 'Mod-p', 'Ctrl-s', 'Mod-q']) {
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
    value.keys = { 'Mod-k': 'beta' }
    expect(drawer.key(null, 'Mod-k')).toBe(true)
    await settle()
    expect(alpha.events('editor.command')).toEqual([])
    expect(beta.events('editor.command')).toEqual([{ v: 1, kind: 'event', topic: 'editor.command', command: 'b', instance: null }])
  })
})
