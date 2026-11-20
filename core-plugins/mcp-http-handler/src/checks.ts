// The door's checks as plain functions over a request as Node's parser handed it over, so each is tested without a
// socket. They run in a fixed order before anything else reads a request: the Host, the Origin, Sec-Fetch-Site, the
// route and method, then size and rate, then the token

// The one address and port the door listens on. The port is part of every URL a harness keeps, so it never moves
export const HOST = '127.0.0.1'
export const PORT = 4747

// The door's own policy, fixed in the plugin
export const doorLimits = Object.freeze({
  // Node's server
  headerBytes: 8 * 1024,
  headersMs: 5000,
  requestMs: 35_000,
  keepAliveMs: 5000,
  requestsPerSocket: 100,
  connections: 64,
  // Bodies on /mcp and on the routes a token is traded on
  mcpBodyBytes: 512 * 1024,
  tokenBodyBytes: 8 * 1024,
  // Requests a second in all and on the routes that need no token. Every client is 127.0.0.1, so a limit by address
  // would mean nothing
  perSecond: 50,
  openPerSecond: 10,
  // Calls in flight to MCP, for one client and in all, under the router's limit for http as one caller
  callsPerClient: 8,
  callsInAll: 32,
  // The largest answer passed back from MCP
  answerBytes: 4 * 1024 * 1024,
  // The mcp- headers handed on: how many, the longest name and the longest value, in bytes
  mcpHeaders: 32,
  mcpHeaderNameBytes: 64,
  mcpHeaderValueBytes: 256,
})

// What a refusal at the door is recorded under, the reasons core.agentRefused takes. malformed is bytes Node's parser
// or the door's own reading of the body and the mcp- headers refused and timeout a request too slow. Never the text of
// a header, a body or a target
export const refusalReasons = Object.freeze(['host', 'origin', 'method', 'size', 'rate', 'token', 'malformed', 'timeout'] as const)
export type RefusalReason = typeof refusalReasons[number]
export type Refusal = { status: number, reason: RefusalReason, allow?: 'POST' }

// A request as Node's parser hands it over: the method, the target exactly as sent, the version and the raw header
// list, each name as sent followed by its value. Node keeps only the first of some repeated headers, Host among them,
// so the checks read this list and never Node's joined headers
export type Seen = { method: string, target: string, version: string, headers: readonly string[] }

// Every value sent under one header name, which compares without case
export function valuesOf(seen: Seen, name: string): string[] {
  const values: string[] = []
  for (let i = 0; i + 1 < seen.headers.length; i += 2) if (seen.headers[i].toLowerCase() === name) values.push(seen.headers[i + 1])
  return values
}

// The DNS rebinding check: a page on a name that resolves to 127.0.0.1 sends that name. Exactly one Host header whose
// text is the literal and the port, compared as sent with nothing folded, trimmed or parsed, and a target that is a
// path, since an absolute target names a host of its own
export function hostOk(seen: Seen, port: number): boolean {
  const hosts = valuesOf(seen, 'host')
  return hosts.length === 1 && hosts[0] === `${HOST}:${port}` && seen.target.startsWith('/')
}

// Agents are not browsers. Any Origin header at all is refused, null and the door's own origin included
export function originOk(seen: Seen): boolean {
  return valuesOf(seen, 'origin').length === 0
}

// A browser's own word on where a request came from. When sent it must be one header reading none or same-origin, so a
// page on another site can't even link to the door
export function fetchSiteOk(seen: Seen): boolean {
  const values = valuesOf(seen, 'sec-fetch-site')
  return values.length === 0 || (values.length === 1 && (values[0] === 'none' || values[0] === 'same-origin'))
}

export type Route = { route: 'mcp' }

// The fixed route list: POST /mcp over HTTP/1.1 with the exact path and no query. GET and DELETE on /mcp answer 405
// naming POST, every other method or target 404. Another version answers 505 and a request asking to upgrade 400
export function routeOf(seen: Seen): Route | Refusal {
  if (valuesOf(seen, 'upgrade').length > 0) return { status: 400, reason: 'method' }
  if (seen.version !== '1.1') return { status: 505, reason: 'method' }
  if (seen.target !== '/mcp') return { status: 404, reason: 'method' }
  if (seen.method === 'POST') return { route: 'mcp' }
  if (seen.method === 'GET' || seen.method === 'DELETE') return { status: 405, reason: 'method', allow: 'POST' }
  return { status: 404, reason: 'method' }
}

// The checks that read only the request line and the headers, in their order. The first that fails answers
export function checkDoor(seen: Seen, port: number): Route | Refusal {
  if (!hostOk(seen, port)) return { status: 403, reason: 'host' }
  if (!originOk(seen) || !fetchSiteOk(seen)) return { status: 403, reason: 'origin' }
  return routeOf(seen)
}

// The token check: from the Authorization header's text to the client it names, or null for no client
export type TokenSeam = (authorization: string | null) => { client: string } | null

// The build that ships issues no token yet, so every request is refused at the token check
export const refuseEveryToken: TokenSeam = () => null

// The Authorization header's text when exactly one was sent, else null, which no seam takes
export function authorizationOf(seen: Seen): string | null {
  const values = valuesOf(seen, 'authorization')
  return values.length === 1 ? values[0] : null
}
