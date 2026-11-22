// Main's one way to the network: a GET to GitHub with a byte cap and a time limit. Every window stays offline. Node's
// own fetch, not Electron's net, which goes through the default session that refuses every request

// The fetch main uses, Node's global one unless a test hands in its own
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

// The most bytes one answer may hold counted as read and the milliseconds the whole request may take, redirects and
// body included
export type FetchLimits = { bytes: number, ms: number }

// Why a fetch from GitHub was refused. not-github: the pasted text is no repo or release link on github.com
// too-big: past the byte cap
// timed-out: past the time limit
// cancelled: the caller stopped it
// bad-answer: a status or a body GitHub doesn't answer for a release or a file
export type FetchProblem = 'not-github' | 'too-big' | 'timed-out' | 'cancelled' | 'bad-answer'

export class FetchRefused extends Error {
  readonly problem: FetchProblem

  constructor(problem: FetchProblem) {
    super(problem)
    this.problem = problem
  }
}

const nodeFetch: Fetch = (url, init) => fetch(url, init)

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

// The answer's body, refused past the cap by its Content-Length before any byte is read
async function answered(response: Response, cap: number, stopped: Promise<never>): Promise<Buffer> {
  if (response.status !== 200) throw new FetchRefused('bad-answer')
  const length = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(length) && length > cap) throw new FetchRefused('too-big')
  return bodyOf(response, cap, stopped)
}

// GETs a URL from GitHub, its body as bytes. Throws FetchRefused
export async function getFromGitHub(url: string, accept: string, limits: FetchLimits, options: { fetch?: Fetch, signal?: AbortSignal }): Promise<Buffer> {
  const deadline = AbortSignal.timeout(limits.ms)
  const signal = options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal])
  const stopped = abortion(signal)
  // Read only through the race, so a rejection nobody waits for isn't reported as unhandled
  stopped.catch(() => undefined)
  try {
    const response = await Promise.race([(options.fetch ?? nodeFetch)(url, { method: 'GET', headers: { accept }, signal }), stopped])
    return await answered(response, limits.bytes, stopped)
  } catch (err) {
    if (err instanceof FetchRefused) throw err
    if (options.signal?.aborted === true) throw new FetchRefused('cancelled')
    if (deadline.aborted) throw new FetchRefused('timed-out')
    throw err
  }
}
