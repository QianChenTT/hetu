import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchRefused, getFromGitHub, githubHosts, onGitHub, type Fetch } from '../backend/lib/github.ts'
import { releaseZips } from '../backend/plugins-manager/release.ts'

type Call = { url: string, init: RequestInit }

// A fetch answering from a table of URLs, every request recorded, so no test reaches the network
function routes(table: Record<string, () => Response>): { fetch: Fetch, calls: Call[] } {
  const calls: Call[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    const answer = table[url]
    if (answer === undefined) throw new Error(`no route for ${url}`)
    return answer()
  }
  return { fetch, calls }
}

const ok = (text = 'zip') => () => new Response(text, { status: 200 })
const moved = (location: string, status = 302, headers = {}) => () => new Response(null, { status, headers: { location, ...headers } })
const limits = { bytes: 1024, ms: 1000 }
const want = { accept: 'application/octet-stream' }

async function problemOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (err) {
    if (err instanceof FetchRefused) return err.problem
    throw err
  }
  return 'none'
}

const ASSET = 'https://github.com/o/r/releases/download/v1/a.zip'

describe('the hosts main fetches from', () => {
  it('are GitHub\'s API, github.com and its release asset host, over https with no user or port', () => {
    expect([...githubHosts].sort()).toEqual(['api.github.com', 'github.com', 'release-assets.githubusercontent.com'])
    for (const host of githubHosts) expect(onGitHub(`https://${host}/x`), host).toBe(true)
    expect(onGitHub('https://GITHUB.com:443/x')).toBe(true)
    for (const url of [
      'http://github.com/x', 'https://gist.github.com/x', 'https://github.com.example/x', 'https://github.com./x', 'https://evil.com/github.com',
      'https://u:p@github.com/x', 'https://u@github.com/x', 'https://github.com:8443/x', 'ftp://github.com/x', 'file:///C:/x', 'not a url',
      'https://objects.githubusercontent.com/x', 'https://raw.githubusercontent.com/x',
    ]) {
      expect(onGitHub(url), url).toBe(false)
    }
  })

  it('refuse a first URL off them without any request', async () => {
    for (const url of ['http://github.com/o/r', 'https://example.com/a.zip', 'https://github.com:444/a.zip']) {
      const { fetch, calls } = routes({})
      expect(await problemOf(getFromGitHub(url, want, limits, { fetch })), url).toBe('off-github')
      expect(calls).toEqual([])
    }
  })
})

describe('a redirect', () => {
  it('is followed to a release asset host, a relative one resolved against the URL it came from', async () => {
    const { fetch, calls } = routes({
      [ASSET]: moved('https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x'),
      'https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x': moved('/github-production-release-asset/2', 307),
      'https://release-assets.githubusercontent.com/github-production-release-asset/2': moved('https://release-assets.githubusercontent.com/3', 301),
      'https://release-assets.githubusercontent.com/3': ok('PK'),
    })
    expect((await getFromGitHub(ASSET, want, limits, { fetch })).toString()).toBe('PK')
    expect(calls.map(call => call.url)).toEqual([
      ASSET, 'https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x',
      'https://release-assets.githubusercontent.com/github-production-release-asset/2', 'https://release-assets.githubusercontent.com/3',
    ])
  })

  it('is refused off GitHub\'s hosts or https before it is followed, whichever status it comes with', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      for (const location of [
        'https://example.com/a.zip', 'http://release-assets.githubusercontent.com/a', 'https://github.com:8443/a', '//evil.example/a',
        'https://objects.githubusercontent.com/a',
      ]) {
        const { fetch, calls } = routes({ [ASSET]: moved(location, status) })
        expect(await problemOf(getFromGitHub(ASSET, want, limits, { fetch })), `${status} ${location}`).toBe('off-github')
        expect(calls.map(call => call.url)).toEqual([ASSET])
      }
    }
  })

  it('is refused with no Location, and after five in a row', async () => {
    const bare = routes({ [ASSET]: () => new Response(null, { status: 302 }) })
    expect(await problemOf(getFromGitHub(ASSET, want, limits, { fetch: bare.fetch }))).toBe('bad-answer')
    const loop = routes({ [ASSET]: moved(ASSET) })
    expect(await problemOf(getFromGitHub(ASSET, want, limits, { fetch: loop.fetch }))).toBe('bad-answer')
    expect(loop.calls).toHaveLength(6)
  })
})

describe('a request that ended', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // A fetch that never answers and rejects once its request is aborted. Each fetch here keeps the signal it was handed
  const handed: AbortSignal[] = []
  const hangs: Fetch = (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal) handed.push(init.signal)
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
  const answering = (answer: () => Response): Fetch => async (url, init) => {
    if (init.signal) handed.push(init.signal)
    return routes({ [ASSET]: answer }).fetch(url, init)
  }

  it('leaves no listener on the signal of its caller or the one it handed fetch, answered, refused or past its time limit', async () => {
    const caller = new AbortController()
    for (const [fetch, ms] of [[answering(ok()), 1000], [answering(() => new Response(null, { status: 500 })), 1000], [hangs, 10]] as const) {
      handed.length = 0
      await problemOf(getFromGitHub(ASSET, want, { bytes: 1024, ms }, { fetch, signal: caller.signal }))
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
      expect(handed).toHaveLength(1)
      expect(getEventListeners(handed[0], 'abort'), String(ms)).toHaveLength(0)
    }
  })

  it('leaves no timer running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await getFromGitHub(ASSET, want, limits, { fetch: routes({ [ASSET]: ok() }).fetch })
    await problemOf(getFromGitHub(ASSET, want, limits, { fetch: routes({ [ASSET]: () => new Response(null, { status: 500 }) }).fetch }))
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('every request', () => {
  it('handles redirects itself, sends no credentials, no cookie a redirect set and a fixed user agent', async () => {
    const { fetch, calls } = routes({
      [ASSET]: moved('https://release-assets.githubusercontent.com/1', 302, { 'set-cookie': 'session=1' }),
      'https://release-assets.githubusercontent.com/1': ok(),
    })
    await getFromGitHub(ASSET, { accept: 'application/octet-stream' }, limits, { fetch })
    expect(calls).toHaveLength(2)
    for (const { init } of calls) {
      expect(init.method).toBe('GET')
      expect(init.redirect).toBe('manual')
      expect(init.credentials).toBe('omit')
      expect(init.headers).toEqual({ accept: 'application/octet-stream', 'user-agent': 'hetu' })
    }
  })

  it('frees the body of an answer refused before it is read', async () => {
    for (const [status, headers] of [[404, {}], [429, {}], [500, {}], [200, { 'content-length': '5000' }]] as const) {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
      })
      const { fetch } = routes({ [ASSET]: () => new Response(body, { status, headers }) })
      await problemOf(getFromGitHub(ASSET, want, limits, { fetch }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(cancelled, String(status)).toBe(true)
    }
  })

  it('to the API names the API version it reads', async () => {
    const { fetch, calls } = routes({
      'https://api.github.com/repos/o/r/releases/latest': () => new Response(JSON.stringify({ tag_name: 'v1', assets: [] }), { status: 200 }),
    })
    await releaseZips('https://github.com/o/r', { fetch })
    expect(calls[0].init.headers).toEqual({
      accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'hetu',
    })
  })
})

describe('a release answer', () => {
  it('is refused whole when a zip\'s download link leaves GitHub\'s hosts or https', async () => {
    for (const url of ['https://example.com/a.zip', 'http://github.com/o/r/releases/download/v1/a.zip']) {
      const { fetch } = routes({
        'https://api.github.com/repos/o/r/releases/latest': () => new Response(JSON.stringify({
          tag_name: 'v1', assets: [{ name: 'a.zip', size: 1, state: 'uploaded', browser_download_url: url }],
        }), { status: 200 }),
      })
      expect(await releaseZips('https://github.com/o/r', { fetch }), url).toEqual({ problem: 'off-github' })
    }
  })
})
