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
// no-release: the API answered 404, for a repo that is missing or private, one with no published release or a tag
// with no release
// not-found: a picked file answered 404, gone since its release was read
// no-zip: the release holds no .zip asset uploaded whole
// too-big: past the byte cap
// digest-mismatch: the downloaded bytes don't hash to the sha256 the release gave for them
// rate-limited: GitHub's rate limit for this address, 60 API requests an hour with no token
// offline: no connection to GitHub, or one that broke
// timed-out: past the time limit
// cancelled: the caller stopped it
// bad-answer: a status or a body GitHub doesn't answer for a release or a file
export const fetchProblems = Object.freeze([
  'not-github', 'off-github', 'no-release', 'not-found', 'no-zip', 'too-big', 'digest-mismatch', 'rate-limited', 'offline',
  'timed-out', 'cancelled', 'bad-answer',
] as const)
export type FetchProblem = typeof fetchProblems[number]

// Each problem as the trusted window says it
export const fetchProblemWords: Readonly<Record<FetchProblem, string>> = Object.freeze({
  'not-github': 'That is not a link to a GitHub repo or release. Paste one like https://github.com/owner/repo',
  'off-github': "The download pointed away from the hosts hetu fetches from, so nothing was fetched. An older release may still use GitHub's old download host, which hetu no longer fetches from",
  'no-release': "GitHub has no published release there. The repo may be private or missing or the tag may have no release. A repo link finds only the latest full release, so paste a prerelease's own tag link to install it",
  'not-found': 'GitHub no longer has that file. Paste the link again to see what the release holds now',
  'no-zip': 'That release holds no .zip file to install from',
  'too-big': 'That zip is bigger than a plugin may be',
  'digest-mismatch': 'The downloaded zip does not match the checksum GitHub lists for it, so it was not kept. Try again',
  'rate-limited': 'GitHub is limiting requests from this network for now. Try again in an hour or install from a downloaded zip',
  'offline': 'GitHub could not be reached. Check the connection and try again',
  'timed-out': 'GitHub took too long to answer. Try again',
  'cancelled': 'The download was stopped',
  'bad-answer': 'GitHub answered in a way hetu does not read. Try again later or install from a downloaded zip',
})

export class FetchRefused extends Error {
  readonly problem: FetchProblem

  constructor(problem: FetchProblem) {
    super(problem)
    this.problem = problem
  }
}

const nodeFetch: Fetch = (url, init) => fetch(url, init)

// The API, github.com where a release's browser_download_url points and the host it redirects a download to:
// release-assets.githubusercontent.com, which GitHub's docs list as "Needed for downloading release assets" under
// accessible domains by function in docs.github.com/en/actions/reference/runners/self-hosted-runners
export const githubHosts: readonly string[] = Object.freeze(['api.github.com', 'github.com', 'release-assets.githubusercontent.com'])

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

// A wait on the fetch or on a body read, started inside so a fetch that throws at once counts as one that rejects. A
// rejection is the connection's, unless the request was stopped, which the caller tells apart
async function waitOnNetwork<T>(work: () => Promise<T>, signal: AbortSignal, stopped: Promise<never>): Promise<T> {
  try {
    return await Promise.race([work(), stopped])
  } catch (err) {
    if (signal.aborted) throw err
    throw new FetchRefused('offline')
  }
}

// One request's stop: the caller's signal or the time limit, whichever comes first. stopped rejects then, so a read
// waiting on a body that stalls ends too. end removes every listener and the timer once the request is over
type Stop = { signal: AbortSignal, stopped: Promise<never>, timedOut: () => boolean, end: () => void }

function stopFor(ms: number, caller: AbortSignal | undefined): Stop {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('past the time limit', 'TimeoutError'))
  }, ms)
  const onCaller = () => controller.abort(caller?.reason)
  if (caller?.aborted === true) onCaller()
  else caller?.addEventListener('abort', onCaller, { once: true })
  let onStop: () => void = () => undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    onStop = () => reject(controller.signal.reason)
    if (controller.signal.aborted) onStop()
    else controller.signal.addEventListener('abort', onStop, { once: true })
  })
  // Read only through the race, so a rejection nobody waits for isn't reported as unhandled
  stopped.catch(() => undefined)
  const end = () => {
    clearTimeout(timer)
    caller?.removeEventListener('abort', onCaller)
    controller.signal.removeEventListener('abort', onStop)
  }
  return { signal: controller.signal, stopped, timedOut: () => timedOut, end }
}

// The body's bytes, refused past the cap as counted, whatever its Content-Length said
async function bodyOf(response: Response, cap: number, signal: AbortSignal, stopped: Promise<never>): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let count = 0
  try {
    for (;;) {
      const { done, value } = await waitOnNetwork(() => reader.read(), signal, stopped)
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

// GitHub's rate limits answer 429, or 403 with no requests left or a time to wait, as
// docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api says. A 403 with neither is another refusal
const rateLimited = (response: Response) => response.status === 429
  || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after') !== null))

// Why an answer is refused before its body is read, past the cap by its Content-Length among them, or null. A gzip
// answer's Content-Length is its compressed size, never more than decoded, so it can't refuse one the count would take
function refusal(response: Response, cap: number): FetchProblem | null {
  if (response.status === 404) return 'not-found'
  if (rateLimited(response)) return 'rate-limited'
  if (response.status !== 200) return 'bad-answer'
  const length = Number(response.headers.get('content-length') ?? Number.NaN)
  return Number.isFinite(length) && length > cap ? 'too-big' : null
}

// Frees the connection under a body never read. A cancel that fails has nothing more to free
const dropBody = (response: Response) => response.body?.cancel().catch(() => undefined)

// The answer's body, or its refusal with the body left unread
async function bodyOrRefusal(response: Response, cap: number, signal: AbortSignal, stopped: Promise<never>): Promise<Buffer> {
  const problem = refusal(response, cap)
  if (problem === null) return bodyOf(response, cap, signal, stopped)
  void dropBody(response)
  throw new FetchRefused(problem)
}

// What a request asks for: the type and, of the API, its version
export type Wanted = { accept: string, 'x-github-api-version'?: string }

// Each request in turn, every redirect checked and followed here, never by fetch
async function throughRedirects(url: string, wanted: Wanted, signal: AbortSignal, fetcher: Fetch, stopped: Promise<never>): Promise<Response> {
  if (!onGitHub(url)) throw new FetchRefused('off-github')
  const init: RequestInit = { method: 'GET', headers: { ...wanted, 'user-agent': CLIENT_NAME }, redirect: 'manual', credentials: 'omit', signal }
  let at = url
  for (let hops = 0; ; hops++) {
    const response = await waitOnNetwork(() => fetcher(at, init), signal, stopped)
    if (!REDIRECTS.includes(response.status)) return response
    void dropBody(response)
    if (hops === MOST_REDIRECTS) throw new FetchRefused('bad-answer')
    at = redirectedTo(response, at)
  }
}

// GETs a URL from GitHub's hosts, its body as bytes. Throws FetchRefused
export async function getFromGitHub(url: string, wanted: Wanted, limits: FetchLimits, options: { fetch?: Fetch, signal?: AbortSignal }): Promise<Buffer> {
  const stop = stopFor(limits.ms, options.signal)
  try {
    const response = await throughRedirects(url, wanted, stop.signal, options.fetch ?? nodeFetch, stop.stopped)
    return await bodyOrRefusal(response, limits.bytes, stop.signal, stop.stopped)
  } catch (err) {
    if (err instanceof FetchRefused) throw err
    if (options.signal?.aborted === true) throw new FetchRefused('cancelled')
    if (stop.timedOut()) throw new FetchRefused('timed-out')
    throw err
  } finally {
    stop.end()
  }
}
