import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Session } from 'electron'
import { hostOnly, parsedUrl } from '../lib/url.ts'
import { SCHEME } from './before-ready.ts'
import type { ServedHost } from './lib.ts'
import { viewsOwner } from '../../api/ids.ts'

// Each role's own hosts. Every page of a role lives in its session and nothing in it reaches another role's hosts. The
// editor role also owns <id>.views for each plugin id, a host of its own for each plugin's views
export const ROLES = Object.freeze({
  editor: Object.freeze(['editor', 'images', 'content']),
  trusted: Object.freeze(['trusted']),
  workers: Object.freeze(['workers']),
})
export type Role = keyof typeof ROLES

// Without the persist: prefix a partition lives in memory, so nothing a page stores reaches the disk
export const partition = (role: Role): string => `hetu-${role}`

// The pages folder each host serves from. A views host is served from what main holds of its running plugin, images
// from the notes folder through the luoshu, content has none until its pages exist
const PAGES: Readonly<Record<string, string>> = Object.freeze({ editor: 'editor', trusted: 'trusted', workers: 'workers' })

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
})

// Lower case names, dashes and one known extension. No dot segment, backslash, colon or escape gets through, so a path
// can't leave its folder or name a stream, and nothing like a README is served
const SERVABLE = /^\/(?:(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\.(html|css|js|svg|png|woff2))?$/

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "font-src 'self'", "base-uri 'none'",
  "form-action 'none'", "frame-ancestors 'none'",
].join('; ')

// The editor page frames plugins' views and shows their icons, both from each plugin's own views host, and the images
// their nodes name from the images host. A frame's own policy names neither host. Its page gets a nonce for the style element
// CodeMirror makes, a fresh one each load, named only in that page's policy and on its script
const editorCsp = (nonce: string | null) => [
  "default-src 'none'", "script-src 'self'", nonce === null ? "style-src 'self'" : `style-src 'self' 'nonce-${nonce}'`,
  "img-src 'self' hetu://*.views hetu://images", "font-src 'self'", 'frame-src hetu://*.views', "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

// Where the editor page's markup takes its nonce: the page's script carries it and the page hands it to CodeMirror.
// Chromium hides a nonce from attribute reads and selectors once its element is in the page
export const NONCE_MARK = '{{style-nonce}}'
// 128 random bits, as CSP3 asks of a nonce
const freshNonce = () => randomBytes(16).toString('base64')

// The worker host page starts workers only from data: URLs, which take a copy of this policy: no eval, no network,
// WebAssembly allowed
const WORKERS_CSP = [
  "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", 'worker-src data:', "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

// Whether a request may leave a role's session: only to hetu on the role's own hosts, with no user or port. Whether a
// views host's plugin runs is for its handler to answer
export function allowed(role: Role, url: string): boolean {
  const at = parsedUrl(url)
  if (at === null || at.protocol !== `${SCHEME}:` || !hostOnly(at)) return false
  return (ROLES[role] as readonly string[]).includes(at.hostname) || (role === 'editor' && viewsOwner(at.hostname) !== null)
}

const answer = (status: number) => new Response(null, { status })

// A role's protocol handler: its own hosts' pages from the app, each with the CSP and its type, and the plugins' views
// hosts and the images host from what main answers
export async function serve(role: Role, request: { url: string, method: string }, root: string, views?: ServedHost, images?: ServedHost): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return answer(405)
  const at = parsedUrl(request.url)
  if (at === null || !allowed(role, request.url)) return answer(404)
  const ofViews = viewsOwner(at.hostname) !== null
  if (ofViews || at.hostname === 'images') {
    const found = (await (ofViews ? views : images)?.serve(request.url)) ?? null
    if (found === null) return answer(404)
    const headers = { 'content-type': found.type, 'content-security-policy': found.csp, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
    // The bytes main holds go out as they are, with no copy of a note's image beside the one read
    return new Response(request.method === 'HEAD' ? null : found.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers })
  }
  const folder = PAGES[at.hostname]
  const match = SERVABLE.exec(at.pathname)
  if (folder === undefined || match === null) return answer(404)
  const relative = at.pathname === '/' ? 'index.html' : at.pathname.slice(1)
  let bytes: Buffer
  try {
    bytes = await readFile(path.join(root, folder, ...relative.split('/')))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return answer(code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR' ? 404 : 500)
  }
  const type = match[1] ?? 'html'
  let nonce: string | null = null
  if (at.hostname === 'editor' && type === 'html') {
    const parts = bytes.toString('utf8').split(NONCE_MARK)
    // A page with no place for the nonce would load with no editor styles, one with two would hand it out twice
    if (parts.length !== 2) return answer(500)
    nonce = freshNonce()
    bytes = Buffer.from(parts.join(nonce), 'utf8')
  }
  const headers = {
    'content-type': TYPES[type],
    'content-security-policy': at.hostname === 'workers' ? WORKERS_CSP : at.hostname === 'editor' ? editorCsp(nonce) : CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  }
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers })
}

// A proxy that leads nowhere. Nothing in hetu loads over the network, and WebRTC, left only TCP through a proxy
// (guardContents), reaches no TURN server at an IP address through this one. A server named by host is never looked up,
// since Chromium resolves no host name (beforeReady). A single proxy with no direct:// means a request fails when
// the proxy does, and <-loopback> takes away Chromium's implicit bypass for localhost. hetu's own pages come from
// protocol.handle and never meet the proxy. Nothing listens on loopback port 1, and a program running as the user that
// binds it is out of scope
// https://www.electronjs.org/docs/latest/api/session#sessetproxyconfig
// https://www.electronjs.org/docs/latest/api/structures/proxy-config
// https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md
const PROXY_TO_NOWHERE = Object.freeze({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1', proxyBypassRules: '<-loopback>' } as const)

// Denies every permission and device, every download and every request but the role's own hosts, and puts the session
// behind the proxy to nowhere. Done once the proxy is set, and fails when it can't be. The default session gets role
// null, so nothing loads in it
export async function lockDown(ses: Session, role: Role | null, root: string, views?: ServedHost, images?: ServedHost): Promise<void> {
  const proxied = ses.setProxy({ ...PROXY_TO_NOWHERE })
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  // The spellchecker can fetch its dictionaries from the network
  ses.setSpellCheckerEnabled(false)
  ses.on('will-download', event => event.preventDefault())
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: role === null || !allowed(role, details.url) }))
  if (role !== null) ses.protocol.handle(SCHEME, request => serve(role, request, root, ...(role === 'editor' ? [views, images] : [])))
  await proxied
}
