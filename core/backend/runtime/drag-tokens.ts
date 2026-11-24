import { randomBytes } from 'node:crypto'
import type { Caller } from '../../api/envelope.ts'
import { DRAG_TOKEN_MS, DRAG_TOKENS_PER_PLUGIN } from '../../api/ui-limits.ts'
import { callerOf, type PluginReach, reachedBy } from './images.ts'

// Tokens for notes dragged out of plugins' frames. The editor page asks one for a note a frame draws and main mints it
// for that plugin and note when the plugin runs with a ui item and its luoshu.read reaches the note. The frame puts it
// in the drag's text, and the editor page hands it back when it is dropped on the editor. Main answers it once with the
// plugin and the note, asking again whether the plugin runs as the same incarnation and still reads the note, so the
// drop opens the note as the human's, named for that plugin. A token is used up by its first drop whatever the answer,
// ends after DRAG_TOKEN_MS and when the editor page unloads, and a plugin holds at most DRAG_TOKENS_PER_PLUGIN, its
// oldest going first

export { DRAG_TOKENS_PER_PLUGIN }

type Held = { plugin: string, incarnation: number, path: string, until: number }

export class DragTokens {
  // In the order minted, which is the order they expire in
  private readonly tokens = new Map<string, Held>()
  private readonly counts = new Map<string, number>()
  private readonly options: Required<PluginReach>

  constructor(options: PluginReach) {
    this.options = { token: () => randomBytes(16).toString('hex'), now: Date.now, ...options }
  }

  // A token for the editor window alone, null for a plugin not running or a note its luoshu.read doesn't reach
  mint(by: Caller, plugin: string, note: string): string | null {
    const now = this.expired()
    const incarnation = reachedBy(this.options, by, plugin, note)
    if (incarnation === null) return null
    if ((this.counts.get(plugin) ?? 0) >= DRAG_TOKENS_PER_PLUGIN) this.dropOldest(plugin)
    let token = this.options.token()
    while (this.tokens.has(token)) token = this.options.token()
    this.tokens.set(token, { plugin, incarnation, path: note, until: now + DRAG_TOKEN_MS })
    this.counts.set(plugin, (this.counts.get(plugin) ?? 0) + 1)
    return token
  }

  // The plugin that asked for the token dropped on the editor and its note, once, null for one unknown, used or past
  // its time, a plugin that stopped or no longer reads the note, or another window
  redeem(by: Caller, token: string): { plugin: string, path: string } | null {
    this.expired()
    const held = this.tokens.get(token)
    if (!editorWindow(by) || held === undefined) return null
    this.drop(token, held)
    if (this.options.running(held.plugin) !== held.incarnation || !this.options.reads(callerOf(held.plugin, held.incarnation), held.path)) return null
    return { plugin: held.plugin, path: held.path }
  }

  // The editor page went, and every frame with it
  unloaded(): void {
    this.tokens.clear()
    this.counts.clear()
  }

  // Drops the tokens past their time from the oldest on, answering now
  private expired(): number {
    const now = this.options.now()
    for (const [token, held] of this.tokens) {
      if (held.until >= now) break
      this.drop(token, held)
    }
    return now
  }

  private dropOldest(plugin: string): void {
    for (const [token, held] of this.tokens) {
      if (held.plugin !== plugin) continue
      this.drop(token, held)
      return
    }
  }

  private drop(token: string, held: Held): void {
    this.tokens.delete(token)
    const left = (this.counts.get(held.plugin) ?? 1) - 1
    if (left === 0) this.counts.delete(held.plugin)
    else this.counts.set(held.plugin, left)
  }
}

function editorWindow(by: Caller): boolean {
  return by.kind === 'window' && by.role === 'editor'
}
