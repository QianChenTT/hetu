import { describe, expect, it } from 'vitest'
import { CoreLink } from '../frontend/mount/link.ts'
import { Settings } from '../frontend/mount/settings.ts'
import { fakeCore, settle } from './mount-fakes.ts'

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
    expect(settings.value).toEqual({ layout: null, theme: null, favorites: [], keys: {} })
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
    expect(space.get('settings')).toEqual({ layout: 'layout', theme: 'dusk', favorites: ['kanban/board'], keys: { 'Mod-k': 'kanban' } })
    await settings.ownKey('Mod-k', null)
    expect(settings.value.keys).toEqual({})
    // A page loaded again reads what the last one kept. The fake bridge has one listener, so the old link is done
    const link = new CoreLink(core.bridge)
    link.start()
    const again = new Settings(link)
    await again.load()
    expect(again.value).toEqual({ layout: 'layout', theme: 'dusk', favorites: ['kanban/board'], keys: {} })
  })

  it('reads a stored value of the wrong shape as the defaults', async () => {
    for (const stored of [{ layout: 7 }, 'x', { layout: null, theme: null, favorites: ['a b'], keys: {} }, { layout: 'Bad Id', theme: null, favorites: [], keys: {} }]) {
      const { settings } = made(stored)
      await settings.load()
      expect(settings.value, JSON.stringify(stored)).toEqual({ layout: null, theme: null, favorites: [], keys: {} })
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
