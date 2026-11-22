// Main's one way to the network: a GET to GitHub's hosts over https with a byte cap and a time limit. Every window stays
// offline. Node's own fetch, not Electron's net, which goes through the default session that refuses every request
// and keeps cookies. Node's fetch keeps none and no cookie or credential is sent here

// The fetch main uses, Node's global one unless a test hands in its own
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

// The most bytes one answer may hold counted as read and the milliseconds the whole request may take, redirects and
// body included
export type FetchLimits = { bytes: number, ms: number }

// Why a fetch from GitHub was refused. not-github: the pasted text is no repo or release link on github.com
// off-github: a URL or a redirect to a host not listed in githubHosts, or not over https
// too-big: past the byte cap
// timed-out: past the time limit
// cancelled: the caller stopped it
// bad-answer: a status or a body GitHub doesn't answer for a release or a file
export type FetchProblem = 'not-github' | 'off-github' | 'too-big' | 'timed-out' | 'cancelled' | 'bad-answer'

export class FetchRefused extends Error {
  readonly problem: FetchProblem

  constructor(problem: FetchProblem) {
    super(problem)
    this.problem = problem
  }
}

const nodeFetch: Fetch = (url, init) => fetch(url, init)

// The API, github.com where a release's browser_download_url points and the hosts it redirects a download to:
// release-assets.githubusercontent.com, which GitHub's docs list as "Needed for downloading release assets" under
// accessible domains by function in docs.github.com/en/actions/reference/runners/self-hosted-runners. Also
// objects.githubusercontent.com, which served release downloads before it and still serves the runner's releases
export const githubHosts: readonly string[] = Object.freeze([
  'api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
])

// Whether main may fetch a URL: https to one of GitHub's hosts, with no user or port. The parser lowercases the host
// and drops the default port
export function onGitHub(url: string): boolean {
  let at: URL
  try {
    at = new URL(url)
  } catch {
    return false
  }
  return at.protocol === 'https:' && githubHosts.includes(at.hostname) && at.username === '' && at.password === '' && at.port === ''
}

// The name every request gives in its one header naming the client, which GitHub's API asks of every request. It
// names hetu's installer and no person
const CLIENT_NAME = 'hetu-installer'
const REDIRECTS: readonly number[] = Object.freeze([301, 302, 303, 307, 308])
const MOST_REDIRECTS = 5

// Rejects once the signal aborts, so a read waiting on a body that stalls ends with the time limit
function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

// The body's bytes, refused past the cap as counted, whatever its Content-Length said
async function bodyOf(response: Response, cap: number, stopped: Promise<never>): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let count = 0
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stopped])
      if (done) return Buffer.concat(chunks)
      count += value.byteLength
      if (count > cap) throw new FetchRefused('too-big')
      chunks.push(value)
    }
  } finally {
    // The body is left unread once refused or stopped and a cancel that fails has nothing more to free
    reader.cancel().catch(() => undefined)
  }
}

// Where a redirect points, refused off GitHub's hosts before anything follows it. A relative Location resolves against
// the URL it came from
function redirectedTo(response: Response, from: string): string {
  const location = response.headers.get('location')
  if (location === null) throw new FetchRefused('bad-answer')
  let next: string
  try {
    next = new URL(location, from).href
  } catch {
    throw new FetchRefused('bad-answer')
  }
  if (!onGitHub(next)) throw new FetchRefused('off-github')
  return next
}

// The answer's body, refused past the cap by its Content-Length before any byte is read
async function answered(response: Response, cap: number, stopped: Promise<never>): Promise<Buffer> {
  if (response.status !== 200) throw new FetchRefused('bad-answer')
  const length = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(length) && length > cap) throw new FetchRefused('too-big')
  return bodyOf(response, cap, stopped)
}

// What a request asks for: the type and, of the API, its version
export type Wanted = { accept: string, 'x-github-api-version'?: string }

// Each request in turn, every redirect checked and followed here, never by fetch
async function throughRedirects(url: string, wanted: Wanted, signal: AbortSignal, fetcher: Fetch, stopped: Promise<never>): Promise<Response> {
  if (!onGitHub(url)) throw new FetchRefused('off-github')
  const init: RequestInit = { method: 'GET', headers: { ...wanted, 'user-agent': CLIENT_NAME }, redirect: 'manual', credentials: 'omit', signal }
  let at = url
  for (let hops = 0; ; hops++) {
    const response = await Promise.race([fetcher(at, init), stopped])
    if (!REDIRECTS.includes(response.status)) return response
    // A redirect's own body is never read and a cancel that fails has nothing more to free
    response.body?.cancel().catch(() => undefined)
    if (hops === MOST_REDIRECTS) throw new FetchRefused('bad-answer')
    at = redirectedTo(response, at)
  }
}

// GETs a URL from GitHub's hosts, its body as bytes. Throws FetchRefused
export async function getFromGitHub(url: string, wanted: Wanted, limits: FetchLimits, options: { fetch?: Fetch, signal?: AbortSignal }): Promise<Buffer> {
  const deadline = AbortSignal.timeout(limits.ms)
  const signal = options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal])
  const stopped = abortion(signal)
  // Read only through the race, so a rejection nobody waits for isn't reported as unhandled
  stopped.catch(() => undefined)
  try {
    const response = await throughRedirects(url, wanted, signal, options.fetch ?? nodeFetch, stopped)
    return await answered(response, limits.bytes, stopped)
  } catch (err) {
    if (err instanceof FetchRefused) throw err
    if (options.signal?.aborted === true) throw new FetchRefused('cancelled')
    if (deadline.aborted) throw new FetchRefused('timed-out')
    throw err
  }
}
