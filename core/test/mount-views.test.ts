import { describe, expect, it } from 'vitest'
import type { CoreViewsPlugin } from '../api/actions.ts'
import type { UiEvent } from '../api/ui.ts'
import { ViewList } from '../frontend/mount/views.ts'

type Told = [string, Omit<UiEvent, 'v' | 'kind'>]

const kanban: CoreViewsPlugin = {
  plugin: 'kanban', name: 'Kanban', running: true, worker: true, theme: null,
  views: { board: { title: 'Board', kind: 'view', size: { min: 200 }, priority: 60 }, count: { title: 'Cards', kind: 'item' } },
}
const tree: CoreViewsPlugin = { plugin: 'tree', name: 'Files', running: true, worker: true, theme: null, views: { files: { title: 'Files', kind: 'view' } } }

function made() {
  const told: Told[] = []
  const list = new ViewList((owner, event) => void told.push([owner, event]))
  list.declared([kanban, tree])
  return { list, told }
}

describe('view instances', () => {
  it('opens the first instance of each declared view when its owner connects holding ui.view', () => {
    const { list, told } = made()
    list.connected('kanban', true)
    expect(told).toEqual([['kanban', { topic: 'view.opened', instance: 'v1', view: 'board' }], ['kanban', { topic: 'view.opened', instance: 'v2', view: 'count' }]])
    expect(list.owner('v1')).toBe('kanban')
    list.connected('tree', false)
    expect(list.list([]).map(view => view.owner)).toEqual(['kanban', 'kanban'])
  })

  it('opens more instances for their owner only, of views it declared', () => {
    const { list } = made()
    list.connected('kanban', true)
    expect(list.open('kanban', 'board')).toBe('v3')
    expect(list.open('kanban', 'files')).toBe('not-found')
    expect(list.open('tree', 'files')).toBe('not-granted')
    expect(list.close('tree', 'v3')).toBe('not-granted')
    expect(list.close('kanban', 'v3')).toBe(null)
    expect(list.owner('v3')).toBe(null)
  })

  it('keeps a crashed owner\'s first instances in place as down, and reuses them when it connects again', () => {
    const { list, told } = made()
    list.connected('kanban', true)
    list.open('kanban', 'board')
    list.ended('kanban')
    expect(list.list([]).map(view => [view.instance, view.down])).toEqual([['v1', true], ['v2', true]])
    told.length = 0
    list.connected('kanban', true)
    expect(told.map(([, event]) => (event as unknown as { instance: string }).instance)).toEqual(['v1', 'v2'])
    expect(list.list([]).every(view => !view.down)).toBe(true)
  })

  it('gives the layout the manifest\'s title, sizes, hint and favorite mark, never a title set while running', () => {
    const { list } = made()
    list.connected('kanban', true)
    expect(list.title('kanban', 'v1', 'Board: secret plans')).toBe(null)
    expect(list.title('tree', 'v1', 'x')).toBe('not-granted')
    expect(list.list(['tree/files', 'kanban/board'])[0]).toEqual({
      instance: 'v1', owner: 'kanban', view: 'board', kind: 'view', title: 'Board', size: { min: 200 }, priority: 60, favorite: 1, down: false,
    })
    expect(list.get('v1')?.runtimeTitle).toBe('Board: secret plans')
  })

  it('tells the owner when an instance is shown, resized or hidden, once each change', () => {
    const { list, told } = made()
    list.connected('kanban', true)
    told.length = 0
    list.shown('v1', { width: 300, height: 400 })
    list.shown('v1', { width: 300, height: 400 })
    list.shown('v1', { width: 320, height: 400 })
    list.shown('v1', null)
    list.shown('v1', null)
    expect(told).toEqual([
      ['kanban', { topic: 'view.shown', instance: 'v1', width: 300, height: 400 }],
      ['kanban', { topic: 'view.shown', instance: 'v1', width: 320, height: 400 }],
      ['kanban', { topic: 'view.hidden', instance: 'v1' }],
    ])
  })

  it('closes the instances of a view its owner no longer declares', () => {
    const { list } = made()
    list.connected('kanban', true)
    list.declared([{ ...kanban, views: { board: kanban.views.board! } }, tree])
    expect(list.list([]).map(view => view.view)).toEqual(['board'])
    list.declared([tree])
    expect(list.list([])).toEqual([])
  })
})
