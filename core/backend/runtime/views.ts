import { randomBytes } from 'node:crypto'
import type { PluginFile } from '../../lib/hash-files.ts'

// The views host: each running plugin's frames and icons, served from the bytes the loader checked when it started the
// plugin's worker, never read from disk again. A frame loads once from a single-use hetu://views/<token>/<entry>: the
// entry page is served once, the plugin's other files under the token for as long as the frame lives, and no other
// page, so a frame that navigates finds nothing. Icons come from hetu://views/icon/<plugin>/<file>, svg or png only.
// Every token of an incarnation ends with it, and every token ends when the editor page unloads

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
})

// A path in the plugin: lower case names, digits, dots, dashes and underscores, one known extension. No segment starts
// with a dot, so none is . or .., and nothing escaped gets through
const PATH = /^(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*\.(html|css|js|svg|png|woff2)$/
const TOKEN = /^[0-9a-f]{32}$/
const PLUGIN = /^[a-z0-9][a-z0-9-]{0,63}$/

// The proposal's frame policy: everything only from the token's own path, no network, frames, forms or base, and
// embedded only by the editor page
export function frameCsp(token: string): string {
  const own = `hetu://views/${token}/`
  return [
    "default-src 'none'", `script-src ${own}`, `style-src ${own}`, `img-src ${own}`, `font-src ${own}`, "connect-src 'none'",
    "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'", 'frame-ancestors hetu://editor',
  ].join('; ')
}

// An icon is an image the editor page shows with an img element, where no script in it runs
const ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"

type Running = { incarnation: number, files: ReadonlyMap<string, Uint8Array>, frames: Readonly<Record<string, string>> }
type Token = { plugin: string, incarnation: number, entry: string, served: boolean }

export type Served = { bytes: Uint8Array, type: string, csp: string }

export class ViewFiles {
  private readonly running = new Map<string, Running>()
  private readonly tokens = new Map<string, Token>()
  private readonly token: () => string

  constructor(options: { token?: () => string } = {}) {
    this.token = options.token ?? (() => randomBytes(16).toString('hex'))
  }

  started(id: string, incarnation: number, files: readonly PluginFile[], frames: Readonly<Record<string, string>>): void {
    this.drop(id)
    this.running.set(id, { incarnation, files: new Map(files.map(file => [file.path, file.bytes])), frames: { ...frames } })
  }

  ended(id: string, incarnation: number): void {
    if (this.running.get(id)?.incarnation === incarnation) this.drop(id)
  }

  // A URL the frame loads from once, null when the plugin isn't running or has no such frame
  mint(plugin: string, frame: string): string | null {
    const held = this.running.get(plugin)
    const entry = held !== undefined && Object.hasOwn(held.frames, frame) ? held.frames[frame] : undefined
    if (held === undefined || entry === undefined || !PATH.test(entry) || !held.files.has(entry)) return null
    let token = this.token()
    while (this.tokens.has(token)) token = this.token()
    if (!TOKEN.test(token)) return null
    this.tokens.set(token, { plugin, incarnation: held.incarnation, entry, served: false })
    return `hetu://views/${token}/${entry}`
  }

  // The frame at url is gone: its token ends. Answers whose it was, null for a token already gone
  gone(url: string): { plugin: string } | null {
    const at = parts(url)
    if (at === null || !TOKEN.test(at.first)) return null
    const held = this.tokens.get(at.first)
    if (held === undefined) return null
    this.tokens.delete(at.first)
    return { plugin: held.plugin }
  }

  // The editor page went, and every frame with it
  unloaded(): void {
    this.tokens.clear()
  }

  serve(url: string): Served | null {
    const at = parts(url)
    if (at === null) return null
    if (at.first === 'icon') return this.icon(at.rest)
    const held = TOKEN.test(at.first) ? this.tokens.get(at.first) : undefined
    const path = at.rest.join('/')
    const match = PATH.exec(path)
    if (held === undefined || match === null) return null
    const running = this.running.get(held.plugin)
    if (running === undefined || running.incarnation !== held.incarnation) return null
    if (match[1] === 'html') {
      if (path !== held.entry || held.served) return null
      held.served = true
    }
    const bytes = running.files.get(path)
    if (bytes === undefined) return null
    return { bytes, type: TYPES[match[1] as string] as string, csp: frameCsp(at.first) }
  }

  private icon(rest: string[]): Served | null {
    const [plugin, ...way] = rest
    const path = way.join('/')
    const match = PATH.exec(path)
    if (plugin === undefined || !PLUGIN.test(plugin) || match === null || (match[1] !== 'svg' && match[1] !== 'png')) return null
    const bytes = this.running.get(plugin)?.files.get(path)
    return bytes === undefined ? null : { bytes, type: TYPES[match[1]] as string, csp: ICON_CSP }
  }

  private drop(id: string): void {
    this.running.delete(id)
    for (const [token, held] of this.tokens) if (held.plugin === id) this.tokens.delete(token)
  }
}

// The first segment and the rest of a hetu://views URL with no user, port, query or fragment
function parts(url: string): { first: string, rest: string[] } | null {
  let at: URL
  try {
    at = new URL(url)
  } catch {
    return null
  }
  if (at.protocol !== 'hetu:' || at.hostname !== 'views' || at.username !== '' || at.password !== '' || at.port !== '') return null
  if (at.search !== '' || at.hash !== '' || url.includes('?') || url.includes('#')) return null
  const [first, ...rest] = at.pathname.slice(1).split('/')
  return first === undefined || first === '' ? null : { first, rest }
}
