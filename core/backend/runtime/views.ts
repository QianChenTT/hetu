import { randomBytes } from 'node:crypto'
import { frameOwner, viewsHost } from '../../api/ids.ts'
import type { PluginFile } from '../../lib/hash-files.ts'
import { IMAGE_CSP, type Served } from './lib.ts'

// Each running plugin's frames and icons, on a host of the plugin's own, hetu://<id>.views with each _ in the id
// written -- (viewsHost in api/ids.ts), so Chromium gives each plugin's frames a renderer of their own. Served from the
// bytes the plugins manager checked when it started the plugin's worker, never read from disk again. A frame loads once
// from a single-use hetu://<id>.views/<token>/<entry>: the entry page is served once, the plugin's other files under
// the token for as long as the frame lives, and no other page, so a frame that navigates finds nothing. A token is
// served only on its own plugin's host. Icons come from hetu://<id>.views/icon/<file>, svg or png only, so a plugin's
// host shows no other plugin's icons.
// Every token of an incarnation ends with it, and every token ends when the editor page unloads. At the root of each
// token, hetu-theme.css holds hetu's theme as the editor page last set it, offered to the frame and never checked

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
const THEME_FILE = 'hetu-theme.css'

// The variables as one rule on :root. editor.theme's schema holds names and values to text that stays inside it
function sheetOf(variables: Readonly<Record<string, string>>): Uint8Array {
  const lines = Object.entries(variables).map(([name, value]) => `\n  ${name}: ${value};`).join('')
  return new TextEncoder().encode(`:root {${lines}${lines === '' ? '' : '\n'}}\n`)
}

// The proposal's frame policy: everything only from the token's own path on the plugin's host, no network, frames,
// forms or base, and embedded only by the editor page
export function frameCsp(plugin: string, token: string): string {
  const own = `hetu://${viewsHost(plugin)}/${token}/`
  return [
    "default-src 'none'", `script-src ${own}`, `style-src ${own}`, `img-src ${own}`, `font-src ${own}`, "connect-src 'none'",
    "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'", 'frame-ancestors hetu://editor',
  ].join('; ')
}


type Running = { incarnation: number, files: ReadonlyMap<string, Uint8Array>, frames: Readonly<Record<string, string>> }
type Token = { plugin: string, incarnation: number, entry: string, served: boolean }

export class ViewFiles {
  private readonly running = new Map<string, Running>()
  private readonly tokens = new Map<string, Token>()
  private readonly token: () => string
  // hetu opens one editor window per run, so the theme its page last set is the one every frame gets
  private themeSheet = sheetOf({})

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

  // The incarnation the plugin runs as with a ui item, null when it doesn't
  incarnation(id: string): number | null {
    return this.running.get(id)?.incarnation ?? null
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
    return `hetu://${viewsHost(plugin)}/${token}/${entry}`
  }

  // The frame at url is gone: its token ends. Answers whose it was, null for a token already gone
  gone(url: string): { plugin: string } | null {
    const at = parts(url)
    if (at === null || !TOKEN.test(at.first)) return null
    const held = this.tokens.get(at.first)
    if (held === undefined || held.plugin !== at.plugin) return null
    this.tokens.delete(at.first)
    return { plugin: held.plugin }
  }

  // The theme's variables the editor page set
  theme(variables: Readonly<Record<string, string>>): void {
    this.themeSheet = sheetOf(variables)
  }

  // The editor page went, and every frame with it
  unloaded(): void {
    this.tokens.clear()
  }

  serve(url: string): Served | null {
    const at = parts(url)
    if (at === null) return null
    if (at.first === 'icon') return this.icon(at.plugin, at.rest)
    const held = TOKEN.test(at.first) ? this.tokens.get(at.first) : undefined
    const path = at.rest.join('/')
    const match = PATH.exec(path)
    if (held === undefined || held.plugin !== at.plugin || match === null) return null
    const running = this.running.get(held.plugin)
    if (running === undefined || running.incarnation !== held.incarnation) return null
    if (path === THEME_FILE) return { bytes: this.themeSheet, type: TYPES.css as string, csp: frameCsp(held.plugin, at.first) }
    if (match[1] === 'html') {
      if (path !== held.entry || held.served) return null
      held.served = true
    }
    const bytes = running.files.get(path)
    if (bytes === undefined) return null
    return { bytes, type: TYPES[match[1] as string] as string, csp: frameCsp(held.plugin, at.first) }
  }

  private icon(plugin: string, rest: string[]): Served | null {
    const path = rest.join('/')
    const match = PATH.exec(path)
    if (match === null || (match[1] !== 'svg' && match[1] !== 'png')) return null
    const bytes = this.running.get(plugin)?.files.get(path)
    return bytes === undefined ? null : { bytes, type: TYPES[match[1]] as string, csp: IMAGE_CSP }
  }

  private drop(id: string): void {
    this.running.delete(id)
    for (const [token, held] of this.tokens) if (held.plugin === id) this.tokens.delete(token)
  }
}

// The plugin whose frames a host serves, the first segment and the rest of a hetu://<id>.views URL with no user, port, query
// or fragment
function parts(url: string): { plugin: string, first: string, rest: string[] } | null {
  let at: URL
  try {
    at = new URL(url)
  } catch {
    return null
  }
  const plugin = at.protocol === 'hetu:' ? frameOwner(at.hostname) : null
  if (plugin === null || at.username !== '' || at.password !== '' || at.port !== '') return null
  if (at.search !== '' || at.hash !== '' || url.includes('?') || url.includes('#')) return null
  const [first, ...rest] = at.pathname.slice(1).split('/')
  return first === undefined || first === '' ? null : { plugin, first, rest }
}
