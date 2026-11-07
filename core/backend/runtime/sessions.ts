import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Session } from 'electron'
import { SCHEME } from './before-ready.ts'

// Each role's own hosts. Every page of a role lives in its session and nothing in it reaches another role's hosts
export const ROLES = Object.freeze({
  editor: Object.freeze(['editor', 'views', 'content']),
  trusted: Object.freeze(['trusted']),
})
export type Role = keyof typeof ROLES

// Without the persist: prefix a partition lives in memory, so nothing a page stores reaches the disk
export const partition = (role: Role): string => `hetu-${role}`

// The pages folder each host serves from. views and content have none until their pages exist
const PAGES: Readonly<Record<string, string>> = Object.freeze({ editor: 'mount', trusted: 'trusted' })

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

function parsed(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

// Whether a request may leave a role's session: only to hetu on the role's own hosts, with no user or port
export function allowed(role: Role, url: string): boolean {
  const at = parsed(url)
  return at !== null && at.protocol === `${SCHEME}:` && (ROLES[role] as readonly string[]).includes(at.hostname)
    && at.username === '' && at.password === '' && at.port === ''
}

const answer = (status: number) => new Response(null, { status })

// A role's protocol handler: its own hosts' pages from the app, each with the CSP and its type
export async function serve(role: Role, request: { url: string, method: string }, root: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return answer(405)
  const at = parsed(request.url)
  if (at === null || !allowed(role, request.url)) return answer(404)
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
  const headers = {
    'content-type': TYPES[match[1] ?? 'html'],
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  }
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers })
}

// Denies every permission and device, every download and every request but the role's own hosts. The default session
// gets role null, so nothing loads in it
export function lockDown(ses: Session, role: Role | null, root: string): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  // The spellchecker can fetch its dictionaries from the network
  ses.setSpellCheckerEnabled(false)
  ses.on('will-download', event => event.preventDefault())
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: role === null || !allowed(role, details.url) }))
  if (role !== null) ses.protocol.handle(SCHEME, request => serve(role, request, root))
}
