import { randomBytes } from 'node:crypto'
import type { Caller } from '../../api/envelope.ts'
import { imageTypeOf } from '../../api/ui.ts'
import { hostOnly, parsedUrl } from '../lib/url.ts'
import { IMAGE_CSP, type Served } from './lib.ts'

// The images host: images of the notes folder the drawer shows for plugins' image nodes, never handed to a plugin as
// bytes. The drawer asks for a URL for each image it draws and main mints hetu://images/<token>, which names the
// plugin, its incarnation and the path and loads once within TOKEN_MS. On that request main asks again whether the
// plugin runs as that incarnation and whether its luoshu.read reaches the path, reads the note under the luoshu's own
// path rules and answers its bytes only when they sniff as the type its extension names. Every token ends when the
// editor page unloads, and one whose plugin stopped, was removed or lost the grant answers nothing. With the gate off
// by the human every read is let on, so an image is too, wherever in the notes it is

// How long a token waits for its one request. The drawer sets the URL as soon as it has it
const TOKEN_MS = 10_000
// The most tokens waiting at once for one plugin and in all, past which a mint is refused, and the most notes read at
// once, the rest waiting their turn, so images never hold much of main's memory or keep the luoshu's latches from notes
const PER_PLUGIN = 32
const IN_ALL = 128
const READS_AT_ONCE = 4

// What main asks about a plugin before a token of its views names one of its notes
export type PluginReach = {
  // The incarnation the plugin runs as with a ui item, null when it doesn't
  running(plugin: string): number | null
  // Whether the plugin's luoshu.read reaches a path now, as the gate answers
  reads(caller: Caller, path: string): boolean
  token?: () => string
  now?: () => number
}

export type ImagesOptions = PluginReach & {
  // The note's bytes under the luoshu's path rules, reads asked about each path the read resolves, null when refused
  read(caller: Caller, path: string, reads: (path: string) => boolean): Promise<{ bytes: Uint8Array } | null>
}

type Held = { plugin: string, incarnation: number, path: string, until: number }

// The worker half is the one a view's tree comes from. The gate judges a plugin by its id
export const callerOf = (plugin: string, incarnation: number): Caller => ({ kind: 'plugin', id: plugin, half: 'worker', incarnation })

// The incarnation of a plugin running with a ui item whose luoshu.read reaches the path, asked by the editor window,
// which alone draws plugins' views. null for anything else
export function reachedBy(reach: PluginReach, by: Caller, plugin: string, path: string): number | null {
  const incarnation = reach.running(plugin)
  if (by.kind !== 'window' || by.role !== 'editor' || incarnation === null) return null
  return reach.reads(callerOf(plugin, incarnation), path) ? incarnation : null
}

export class ViewImages {
  private readonly tokens = new Map<string, Held>()
  private readonly options: ImagesOptions
  private readonly token: () => string
  private readonly now: () => number
  private reading = 0
  private readonly waiting: (() => void)[] = []

  constructor(options: ImagesOptions) {
    this.options = options
    this.token = options.token ?? (() => randomBytes(16).toString('hex'))
    this.now = options.now ?? Date.now
  }

  // A URL the editor page loads the image from once, null for another window, a plugin not running, a path its
  // luoshu.read doesn't reach or past the tokens waiting. Only the editor window draws plugins' trees
  mint(by: Caller, plugin: string, path: string): string | null {
    const incarnation = imageTypeOf(path) === null ? null : reachedBy(this.options, by, plugin, path)
    if (incarnation === null) return null
    const now = this.expired()
    const mine = [...this.tokens.values()].filter(held => held.plugin === plugin).length
    if (mine >= PER_PLUGIN || this.tokens.size >= IN_ALL) return null
    let token = this.token()
    while (this.tokens.has(token)) token = this.token()
    this.tokens.set(token, { plugin, incarnation, path, until: now + TOKEN_MS })
    return `hetu://images/${token}`
  }

  // The editor page went, and every image with it
  unloaded(): void {
    this.tokens.clear()
  }

  async serve(url: string): Promise<Served | null> {
    // Tokens past their time go first, so the one asked for is one still in it
    this.expired()
    const token = tokenOf(url)
    const held = token === null ? undefined : this.tokens.get(token)
    if (token === null || held === undefined) return null
    this.tokens.delete(token)
    const live = () => this.options.running(held.plugin) === held.incarnation
    if (!live()) return null
    const caller = callerOf(held.plugin, held.incarnation)
    const got = await this.turn(() => (live() ? this.options.read(caller, held.path, path => this.options.reads(caller, path)) : Promise.resolve(null)))
    const bytes = got?.bytes ?? null
    const type = imageTypeOf(held.path)
    // Asked again, since the plugin can stop while its note is read
    if (bytes === null || type === null || sniffed(bytes) !== type || !live()) return null
    return { bytes, type, csp: IMAGE_CSP }
  }

  // Drops the tokens past their time, answering now. At most IN_ALL are held, so a walk over them costs little
  private expired(): number {
    const now = this.now()
    for (const [token, held] of this.tokens) if (held.until < now) this.tokens.delete(token)
    return now
  }

  // Runs one read once fewer than READS_AT_ONCE run, a finished read handing its turn to the next waiting
  private async turn<T>(read: () => Promise<T>): Promise<T> {
    if (this.reading < READS_AT_ONCE) this.reading++
    else await new Promise<void>(resolve => this.waiting.push(resolve))
    try {
      return await read()
    } finally {
      const next = this.waiting.shift()
      if (next === undefined) this.reading--
      else next()
    }
  }
}

// The token of a hetu://images URL with no user, port, query, fragment or path past it
function tokenOf(url: string): string | null {
  const at = parsedUrl(url)
  if (at === null || at.protocol !== 'hetu:' || at.hostname !== 'images' || !hostOnly(at) || url.includes('?') || url.includes('#')) return null
  const match = /^\/([0-9a-f]{32})$/.exec(at.pathname)
  return match === null ? null : match[1] as string
}

const starts = (bytes: Uint8Array, at: number, text: string) => [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0))

// A BMP's reserved bytes are zero and its second header is one of the sizes the format has had, which text never is
function bmpHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 26 || [6, 7, 8, 9].some(at => bytes[at] !== 0)) return false
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(14, true)
  return [12, 40, 52, 56, 64, 108, 124].includes(size)
}

// An SVG document: a byte order mark, which \s takes, an XML declaration, comments and a doctype at most before its
// svg root
const SVG = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--(?:(?!-->)[^])*-->\s*)*(?:<!DOCTYPE svg[^>[]*(?:\[[^\]]*\])?\s*>\s*)?(?:<!--(?:(?!-->)[^])*-->\s*)*<svg[\s>/]/i

// The type the first bytes say the image is, null for none of the types a view may show. An SVG's root has to come
// within its first 4 KiB
export function sniffed(bytes: Uint8Array): string | null {
  if (starts(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'image/png'
  if (starts(bytes, 0, '\xff\xd8\xff')) return 'image/jpeg'
  if (starts(bytes, 0, 'GIF87a') || starts(bytes, 0, 'GIF89a')) return 'image/gif'
  if (starts(bytes, 0, 'RIFF') && starts(bytes, 8, 'WEBP')) return 'image/webp'
  if (starts(bytes, 4, 'ftypavif') || starts(bytes, 4, 'ftypavis')) return 'image/avif'
  if (starts(bytes, 0, 'BM') && bmpHeader(bytes)) return 'image/bmp'
  return SVG.test(new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096))) ? 'image/svg+xml' : null
}
