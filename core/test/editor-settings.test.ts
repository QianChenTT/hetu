import { describe, expect, it } from 'vitest'
import { CoreLink } from '../frontend/editor/link.ts'
import { Settings } from '../frontend/editor/settings.ts'
import { fakeCore, settle } from './editor-fakes.ts'

function made(stored: unknown = null, arrangement: unknown = null) {
  const space = new Map<string, unknown>([...(stored === null ? [] : [['settings', stored] as const]), ...(arrangement === null ? [] : [['arrangement', arrangement] as const])])
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
  it('starts with no theme picked, no favorites and no key owners', async () => {
    const { settings } = made()
    await settings.load()
    expect(settings.value).toEqual({ theme: null, favorites: [], keyOwners: {} })
  })

  // The layout is the drawer's own, so a layout picked before is no setting any more
  it('reads settings stored with a layout picked, or the plain layout, keeping the rest and dropping the pick', async () => {
    for (const pick of [{ layout: 'layout', plain: false }, { layout: null, plain: true }, { layout: 'tiles' }]) {
      const { settings } = made({ ...pick, theme: 'dusk', favorites: ['kanban/board'], keyOwners: { 'Mod-k': 'kanban' } })
      await settings.load()
      expect(settings.value, JSON.stringify(pick)).toEqual({ theme: 'dusk', favorites: ['kanban/board'], keyOwners: { 'Mod-k': 'kanban' } })
    }
  })

  it('keeps each change under settings in the window\'s storage and reads it back', async () => {
    const { settings, space, core } = made()
    await settings.load()
    await settings.pickTheme('dusk')
    await settings.favorite('tree/files', true)
    await settings.favorite('kanban/board', true)
    await settings.favorite('tree/files', false)
    await settings.ownKey('Mod-k', 'kanban')
    expect(space.get('settings')).toEqual({ theme: 'dusk', favorites: ['kanban/board'], keyOwners: { 'Mod-k': 'kanban' } })
    await settings.ownKey('Mod-k', null)
    expect(settings.value.keyOwners).toEqual({})
    // A page loaded again reads what the last one kept. The fake bridge has one listener, so the old link is done
    const link = new CoreLink(core.bridge)
    link.start()
    const again = new Settings(link)
    await again.load()
    expect(again.value).toEqual({ theme: 'dusk', favorites: ['kanban/board'], keyOwners: {} })
  })

  it('reads settings stored with key owners under keys as keyOwners, the theme and favorites kept', async () => {
    const { settings } = made({ layout: 'layout', plain: false, theme: 'dusk', favorites: ['kanban/board'], keys: { 'Mod-k': 'kanban' } })
    await settings.load()
    expect(settings.value).toEqual({ theme: 'dusk', favorites: ['kanban/board'], keyOwners: { 'Mod-k': 'kanban' } })
  })

  it('reads a value holding both keys and keyOwners as the defaults, the old name taken only alone', async () => {
    const { settings } = made({ layout: 'layout', plain: false, theme: null, favorites: [], keys: {}, keyOwners: {} })
    await settings.load()
    expect(settings.value).toEqual({ theme: null, favorites: [], keyOwners: {} })
  })

  it('reads a stored value of the wrong shape as the defaults', async () => {
    for (const stored of [{ theme: 7 }, 'x', { theme: null, favorites: ['a b'], keyOwners: {} }, { theme: 'Bad Id', favorites: [], keyOwners: {} }, { theme: null, favorites: [], keyOwners: {}, other: 1 }]) {
      const { settings } = made(stored)
      await settings.load()
      expect(settings.value, JSON.stringify(stored)).toEqual({ theme: null, favorites: [], keyOwners: {} })
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

  it("reads the layout's arrangement kept under arrangement apart from the settings, null with none kept", async () => {
    const kept = { places: { 'p/board': { column: 'left', order: 0, byHand: true } } }
    const { settings } = made(null, kept)
    await settings.load()
    expect(settings.arrangement).toEqual(kept)
    const none = made()
    await none.settings.load()
    expect(none.settings.arrangement).toBeNull()
  })

  it("keeps the layout's arrangement under arrangement without telling the settings' listener", async () => {
    const { settings, space } = made()
    let told = 0
    await settings.load()
    settings.onChange = () => void told++
    await settings.keepArrangement({ widths: { left: 300, right: 240 } })
    expect(space.get('arrangement')).toEqual({ widths: { left: 300, right: 240 } })
    expect(space.has('settings')).toBe(false)
    expect(settings.arrangement).toEqual({ widths: { left: 300, right: 240 } })
    expect(told).toBe(0)
  })
})
