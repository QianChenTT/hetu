import { z } from 'zod'
import { localName, pluginId } from '../../api/ids.ts'
import type { CoreLink } from './link.ts'

// The editor window's own settings, kept under settings in its storage space: the layout the human picked, the theme,
// the favorite views and which plugin owns a key two plugins bind. Picking a layout or a theme is a normal setting
// with no Confirm, since neither gains any reach. Favorites are the drawer's, so they survive a change of layout

// layout is the layout the human picked, null for hetu's own. plain says the human picked the drawer's plain layout
export type SettingsValue = { layout: string | null, plain: boolean, theme: string | null, favorites: string[], keyOwners: Record<string, string> }

const KEY = 'settings'
export const MAX_FAVORITES = 64
export const MAX_KEY_OWNERS = 64

const shape = z.strictObject({
  layout: pluginId.nullable(),
  plain: z.boolean(),
  theme: pluginId.nullable(),
  favorites: z.array(z.string().max(130).refine(value => {
    const [owner, view, ...rest] = value.split('/')
    return rest.length === 0 && pluginId.safeParse(owner).success && localName.safeParse(view).success
  }, 'owner/view')).max(MAX_FAVORITES),
  keyOwners: z.record(z.string().max(40), pluginId).refine(owners => Object.keys(owners).length <= MAX_KEY_OWNERS),
})

// Settings stored before keyOwners had its name held it as keys, read under the new name so the rest is kept
function renamed(stored: unknown): unknown {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored) || !Object.hasOwn(stored, 'keys') || Object.hasOwn(stored, 'keyOwners')) return stored
  const { keys, ...rest } = stored as Record<string, unknown>
  return { ...rest, keyOwners: keys }
}

const defaults = (): SettingsValue => ({ layout: null, plain: false, theme: null, favorites: [], keyOwners: {} })

export class Settings {
  private readonly link: CoreLink
  private held: SettingsValue = defaults()
  onChange: (() => void) | null = null

  constructor(link: CoreLink) {
    this.link = link
  }

  get value(): SettingsValue {
    return this.held
  }

  async load(): Promise<void> {
    const got = await this.link.call('storage.get', { key: KEY })
    const parsed = got.ok ? shape.safeParse(renamed(got.result)) : null
    this.held = parsed?.success === true ? { ...parsed.data, keyOwners: { ...parsed.data.keyOwners } } : defaults()
    this.onChange?.()
  }

  async favorite(view: string, on: boolean): Promise<void> {
    const rest = this.held.favorites.filter(each => each !== view)
    await this.set({ ...this.held, favorites: on ? [...rest, view] : rest })
  }

  // A layout plugin by id, or null for the drawer's plain layout
  async pickLayout(id: string | null): Promise<void> {
    await this.set({ ...this.held, layout: id, plain: id === null })
  }

  async pickTheme(id: string | null): Promise<void> {
    await this.set({ ...this.held, theme: id })
  }

  // The plugin that owns a key two plugins bind, or null to leave it to neither
  async ownKey(key: string, plugin: string | null): Promise<void> {
    const keyOwners = { ...this.held.keyOwners }
    if (plugin === null) delete keyOwners[key]
    else keyOwners[key] = plugin
    await this.set({ ...this.held, keyOwners })
  }

  // Kept for the run even when storage refuses, so the human's pick holds until hetu quits
  private async set(next: SettingsValue): Promise<void> {
    const parsed = shape.safeParse(next)
    if (!parsed.success) return
    this.held = next
    this.onChange?.()
    await this.link.call('storage.set', { key: KEY, value: next })
  }
}
