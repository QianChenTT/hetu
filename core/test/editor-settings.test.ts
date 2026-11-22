import { describe, expect, it } from 'vitest'
import { CoreLink } from '../frontend/editor/link.ts'
import { Settings } from '../frontend/editor/settings.ts'
import { fakeCore, settle } from './editor-fakes.ts'

function made(stored: unknown = null) {
  const space = new Map<string, unknown>(stored === null ? [] : [['settings', stored]])
  const core = fakeCore({
    'storage.get': args => ({ ok: true, result: space.get((args as { key: string }).key) ?? null }),
    'storage.set': args => {
      const { key, value } = args as { key: string, value: unknown }
      space.set(key, value)
      return { ok: true, result: null }
    },
  })
  const link = new CoreLink(core.bridge)
  link.start()
  return { settings: new Settings(link), space, core }
}

describe('the window\'s settings', () => {
  it('starts with no layout or theme picked, no favorites and no key owners', async () => {
    const { settings } = made()
    await settings.load()
    expect(settings.value).toEqual({ layout: null, plain: false, theme: null, favorites: [], keyOwners: {} })
  })

  it("takes the drawer's plain layout as a pick of its own, apart from hetu's layout", async () => {
    const { settings, space } = made()
    await settings.load()
    await settings.pickLayout(null)
    expect(settings.value).toMatchObject({ layout: null, plain: true })
    await settings.pickLayout('layout')
    expect(settings.value).toMatchObject({ layout: 'layout', plain: false })
    expect(space.get('settings')).toMatchObject({ layout: 'layout', plain: false })
  })

  it('keeps each change under settings in the window\'s storage and reads it back', async () => {
    const { settings, space, core } = made()
    await settings.load()
    await settings.pickLayout('layout')
    await settings.pickTheme('dusk')
    await settings.favorite('tree/files', true)
    await settings.favorite('kanban/board', true)
    await settings.favorite('tree/files', false)
    await settings.ownKey('Mod-k', 'kanban')
    expect(space.get('settings')).toEqual({ layout: 'layout', plain: false, theme: 'dusk', favorites: ['kanban/board'], keyOwners: { 'Mod-k': 'kanban' } })
    await settings.ownKey('Mod-k', null)
    expect(settings.value.keyOwners).toEqual({})
    // A page loaded again reads what the last one kept. The fake bridge has one listener, so the old link is done
    const link = new CoreLink(core.bridge)
    link.start()
    const again = new Settings(link)
    await again.load()
    expect(again.value).toEqual({ layout: 'layout', plain: false, theme: 'dusk', favorites: ['kanban/board'], keyOwners: {} })
  })

  it('reads settings stored with key owners under keys as keyOwners, the layout, theme and favorites kept', async () => {
    const { settings } = made({ layout: 'layout', plain: false, theme: 'dusk', favorites: ['kanban/board'], keys: { 'Mod-k': 'kanban' } })
    await settings.load()
    expect(settings.value).toEqual({ layout: 'layout', plain: false, theme: 'dusk', favorites: ['kanban/board'], keyOwners: { 'Mod-k': 'kanban' } })
  })

  it('reads a value holding both keys and keyOwners as the defaults, the old name taken only alone', async () => {
    const { settings } = made({ layout: 'layout', plain: false, theme: null, favorites: [], keys: {}, keyOwners: {} })
    await settings.load()
    expect(settings.value).toEqual({ layout: null, plain: false, theme: null, favorites: [], keyOwners: {} })
  })

  it('reads a stored value of the wrong shape as the defaults', async () => {
    for (const stored of [{ layout: 7 }, 'x', { layout: null, theme: null, favorites: ['a b'], keyOwners: {} }, { layout: 'Bad Id', theme: null, favorites: [], keyOwners: {} }]) {
      const { settings } = made(stored)
      await settings.load()
      expect(settings.value, JSON.stringify(stored)).toEqual({ layout: null, plain: false, theme: null, favorites: [], keyOwners: {} })
    }
  })

  it('tells its listener after each change', async () => {
    const { settings } = made()
    let told = 0
    settings.onChange = () => void told++
    await settings.load()
    await settings.favorite('tree/files', true)
    await settle()
    expect(told).toBe(2)
  })
})
