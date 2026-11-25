import { z } from 'zod'
import { localName, pluginId } from '../../api/ids.ts'
import type { CoreLink } from './link.ts'

// The editor window's own settings, kept under settings in its storage space: the theme, the favorite views and which
// plugin owns a key two plugins bind, and apart from them the layout's arrangement. Picking a theme is a normal setting
// with no Confirm, since it gains no reach

export type SettingsValue = { theme: string | null, favorites: string[], keyOwners: Record<string, string> }

const KEY = 'settings'
// The layout's arrangement, under a key of its own, so a drag or a resize draws no settings again
const ARRANGEMENT = 'arrangement'
// The arrangement is written at most once in this many ms, the latest, so a plugin opening and closing a view in a loop
// moves the layout each time and writes nothing each time
export const ARRANGEMENT_WRITE_MS = 500
export const MAX_FAVORITES = 64
export const MAX_KEY_OWNERS = 64

// A view as owner/view, the way favorites and the layout's arrangement name it
export const viewKey = z.string().max(130).refine(value => {
  const [owner, view, ...rest] = value.split('/')
  return rest.length === 0 && pluginId.safeParse(owner).success && localName.safeParse(view).success
}, 'owner/view')

const shape = z.strictObject({
  theme: pluginId.nullable(),
  favorites: z.array(viewKey).max(MAX_FAVORITES),
  keyOwners: z.record(z.string().max(40), pluginId).refine(owners => Object.keys(owners).length <= MAX_KEY_OWNERS),
})

// Settings stored before keyOwners had its name held it as keys, read under the new name so the rest is kept. Settings
// stored while a layout was picked held the pick as layout and plain, which are dropped
function renamed(stored: unknown): unknown {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return stored
  const { layout: _layout, plain: _plain, ...kept } = stored as Record<string, unknown>
  if (!Object.hasOwn(kept, 'keys') || Object.hasOwn(kept, 'keyOwners')) return kept
  const { keys, ...rest } = kept
  return { ...rest, keyOwners: keys }
}

const defaults = (): SettingsValue => ({ theme: null, favorites: [], keyOwners: {} })

export class Settings {
  private readonly link: CoreLink
  private held: SettingsValue = defaults()
  private kept: unknown = null
  // Whether the arrangement changed since it was last written, and the write waiting for its time
  private unwritten = false
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  onChange: (() => void) | null = null

  constructor(link: CoreLink) {
    this.link = link
  }

  get value(): SettingsValue {
    return this.held
  }

  // The layout's arrangement as storage held it, read by the layout in its own shape
  get arrangement(): unknown {
    return this.kept
  }

  async load(): Promise<void> {
    const [got, arranged] = await Promise.all([this.link.call('storage.get', { key: KEY }), this.link.call('storage.get', { key: ARRANGEMENT })])
    this.kept = arranged.ok ? arranged.result : null
    const parsed = got.ok ? shape.safeParse(renamed(got.result)) : null
    this.held = parsed?.success === true ? { ...parsed.data, keyOwners: { ...parsed.data.keyOwners } } : defaults()
    this.onChange?.()
  }

  async favorite(view: string, on: boolean): Promise<void> {
    const rest = this.held.favorites.filter(each => each !== view)
    await this.set({ ...this.held, favorites: on ? [...rest, view] : rest })
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

  // Kept for the run even when storage refuses, as the settings are, and written within ARRANGEMENT_WRITE_MS
  keepArrangement(value: unknown): void {
    this.kept = value
    this.unwritten = true
    this.writeTimer ??= setTimeout(() => void this.writeArrangement(), ARRANGEMENT_WRITE_MS)
  }

  // The arrangement written now if it changed since its last write, as when the page goes
  async writeArrangement(): Promise<void> {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer)
    this.writeTimer = null
    if (!this.unwritten) return
    this.unwritten = false
    await this.link.call('storage.set', { key: ARRANGEMENT, value: this.kept })
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
