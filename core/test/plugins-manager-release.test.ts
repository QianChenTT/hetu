import { describe, expect, it } from 'vitest'
import { fetchProblems, fetchProblemWords, type Fetch } from '../backend/plugins-manager/github.ts'
import { downloadZip, githubLink, releaseZips, type ReleaseZip } from '../backend/plugins-manager/release.ts'

type Call = { url: string, init: RequestInit }

// A fetch that answers from the test and records every request, so no test reaches the network
function fake(answer: (url: string, init: RequestInit) => Response | Promise<Response>): { fetch: Fetch, calls: Call[] } {
  const calls: Call[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    return answer(url, init)
  }
  return { fetch, calls }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const download = (name: string, tag = 'v1.0.0') => `https://github.com/o/r/releases/download/${tag}/${name}`
const asset = (name: string, size = 10, extra = {}) => ({ name, size, state: 'uploaded', browser_download_url: download(name), ...extra })
const release = (assets: unknown[], tag = 'v1.0.0') => ({ tag_name: tag, name: 'One', assets })

// A fetch that never answers until its request is aborted, as a server that never replies
const hanging: Fetch = (_url, init) => new Promise((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
})

// A body that hands out its first chunk and then never another
const stalled = () => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array(4))
  },
})

describe('a pasted GitHub link', () => {
  it('names a repo, with or without a trailing slash, .git or the releases page', () => {
    for (const pasted of ['https://github.com/o/r', 'https://github.com/o/r/', 'https://github.com/o/r.git', 'https://github.com/o/r/releases',
      'https://github.com/o/r/releases/latest', '  https://github.com/o/r  ', 'https://github.com/o/r?tab=readme#top', 'HTTPS://GitHub.com/o/r']) {
      expect(githubLink(pasted), pasted).toEqual({ owner: 'o', repo: 'r', tag: null })
    }
  })

  it('names a release by its tag, decoded from the path', () => {
    expect(githubLink('https://github.com/o/r/releases/tag/v1.2.0')).toEqual({ owner: 'o', repo: 'r', tag: 'v1.2.0' })
    expect(githubLink('https://github.com/o/r/releases/tag/v1%2B2')).toEqual({ owner: 'o', repo: 'r', tag: 'v1+2' })
    expect(githubLink('https://github.com/Some-Org/my.plugins_2/releases/tag/x')).toEqual({ owner: 'Some-Org', repo: 'my.plugins_2', tag: 'x' })
  })

  it('is refused for anything but a repo or release page on github.com over https', () => {
    for (const pasted of [
      'github.com/o/r', 'http://github.com/o/r', 'https://gitlab.com/o/r', 'https://api.github.com/repos/o/r', 'https://www.github.com/o/r',
      'https://github.com.example/o/r', 'https://user:pw@github.com/o/r', 'https://github.com:8443/o/r', 'https://github.com/o',
      'https://github.com/o/r/tree/main', 'https://github.com/o/r/releases/tag', 'https://github.com/o/r/releases/tag/',
      'https://github.com/o/r/releases/download/v1/a.zip', 'https://github.com/-o/r', 'https://github.com/o/..', 'https://github.com/o/.',
      'https://github.com/o/r/releases/tag/%E0%A4%A', 'not a link', '',
    ]) {
      expect(githubLink(pasted), pasted).toBeNull()
    }
  })
})

describe('a release\'s zips', () => {
  it('asks the API for the latest release and answers each uploaded .zip with its name, size and download link', async () => {
    const { fetch, calls } = fake(() => json(release([
      asset('outline.zip', 1200), asset('Notes.ZIP', 30), asset('source.tar.gz'), asset('half.zip', 5, { state: 'starter' }),
    ])))
    expect(await releaseZips('https://github.com/o/r', { fetch })).toEqual({
      problem: null,
      tag: 'v1.0.0',
      zips: [
        { name: 'outline.zip', size: 1200, url: download('outline.zip') },
        { name: 'Notes.ZIP', size: 30, url: download('Notes.ZIP') },
      ],
    })
    expect(calls.map(call => call.url)).toEqual(['https://api.github.com/repos/o/r/releases/latest'])
  })

  it('asks for the release a tag names, the tag encoded as one path segment', async () => {
    const { fetch, calls } = fake(() => json(release([asset('a.zip')], 'v1+2')))
    expect(await releaseZips('https://github.com/o/r/releases/tag/v1%2B2', { fetch })).toMatchObject({ problem: null, tag: 'v1+2' })
    expect(calls.map(call => call.url)).toEqual(['https://api.github.com/repos/o/r/releases/tags/v1%2B2'])
  })

  it('refuses a link that is no GitHub repo or release without asking anything', async () => {
    const { fetch, calls } = fake(() => json(release([])))
    expect(await releaseZips('https://example.com/o/r', { fetch })).toEqual({ problem: 'not-github' })
    expect(calls).toEqual([])
  })

  it('refuses an answer that isn\'t a release', async () => {
    for (const body of ['{', '[]', JSON.stringify({ tag_name: 'v1' }), JSON.stringify(release([{ name: 'a.zip', size: -1 }]))]) {
      const { fetch } = fake(() => new Response(body, { status: 200 }))
      expect(await releaseZips('https://github.com/o/r', { fetch }), body).toEqual({ problem: 'bad-answer' })
    }
  })

  it('refuses an answer past its byte cap, by its declared length or as counted', async () => {
    const big = JSON.stringify(release([asset('a.zip')]))
    const declared = fake(() => new Response(big, { status: 200, headers: { 'content-length': String(big.length) } }))
    expect(await releaseZips('https://github.com/o/r', { fetch: declared.fetch, limits: { bytes: big.length - 1 } })).toEqual({ problem: 'too-big' })
    const counted = fake(() => new Response(big, { status: 200 }))
    expect(await releaseZips('https://github.com/o/r', { fetch: counted.fetch, limits: { bytes: big.length - 1 } })).toEqual({ problem: 'too-big' })
    const exact = fake(() => new Response(big, { status: 200 }))
    expect(await releaseZips('https://github.com/o/r', { fetch: exact.fetch, limits: { bytes: big.length } })).toMatchObject({ problem: null })
  })

  it('gives up past its time limit, waiting for an answer or for the rest of a body', async () => {
    expect(await releaseZips('https://github.com/o/r', { fetch: hanging, limits: { ms: 20 } })).toEqual({ problem: 'timed-out' })
    const { fetch } = fake(() => new Response(stalled(), { status: 200 }))
    expect(await releaseZips('https://github.com/o/r', { fetch, limits: { ms: 20 } })).toEqual({ problem: 'timed-out' })
  })

  it('stops when the caller cancels', async () => {
    const controller = new AbortController()
    const asked = releaseZips('https://github.com/o/r', { fetch: hanging, signal: controller.signal })
    controller.abort()
    expect(await asked).toEqual({ problem: 'cancelled' })
  })
})

describe('a picked zip', () => {
  const zip: ReleaseZip = { name: 'outline.zip', size: 6, url: download('outline.zip') }

  it('is downloaded from its link and answered as its bytes', async () => {
    const { fetch, calls } = fake(() => new Response(new Uint8Array([80, 75, 3, 4, 0, 0]), { status: 200 }))
    const got = await downloadZip(zip, { fetch })
    expect(got.problem).toBeNull()
    expect(got.problem === null && [...got.bytes]).toEqual([80, 75, 3, 4, 0, 0])
    expect(calls.map(call => call.url)).toEqual([zip.url])
  })

  it('is refused unfetched when the release says it is past the cap', async () => {
    const { fetch, calls } = fake(() => new Response(new Uint8Array(6), { status: 200 }))
    expect(await downloadZip(zip, { fetch, limits: { bytes: 5 } })).toEqual({ problem: 'too-big' })
    expect(calls).toEqual([])
  })

  it('is refused past the cap by its Content-Length, and by the bytes counted when the length says less or nothing', async () => {
    const declared = fake(() => new Response(new Uint8Array(6), { status: 200, headers: { 'content-length': '6' } }))
    expect(await downloadZip({ ...zip, size: 1 }, { fetch: declared.fetch, limits: { bytes: 5 } })).toEqual({ problem: 'too-big' })
    const understated = fake(() => new Response(new Uint8Array(6), { status: 200, headers: { 'content-length': '1' } }))
    expect(await downloadZip({ ...zip, size: 1 }, { fetch: understated.fetch, limits: { bytes: 5 } })).toEqual({ problem: 'too-big' })
    const unstated = fake(() => new Response(new Uint8Array(6), { status: 200 }))
    expect(await downloadZip({ ...zip, size: 1 }, { fetch: unstated.fetch, limits: { bytes: 5 } })).toEqual({ problem: 'too-big' })
  })

  it('gives up past its time limit', async () => {
    expect(await downloadZip(zip, { fetch: hanging, limits: { ms: 20 } })).toEqual({ problem: 'timed-out' })
    const { fetch } = fake(() => new Response(stalled(), { status: 200 }))
    expect(await downloadZip(zip, { fetch, limits: { ms: 20 } })).toEqual({ problem: 'timed-out' })
  })
})

describe('a failed fetch', () => {
  const failing = (answer: () => Response | Promise<Response>) => fake(answer).fetch
  const zip: ReleaseZip = { name: 'a.zip', size: 1, url: download('a.zip') }
  const status = (code: number, headers: Record<string, string> = {}) => () => new Response('{"message":"x"}', { status: code, headers })

  it('answers no-release for a repo or a tag GitHub doesn\'t have', async () => {
    expect(await releaseZips('https://github.com/o/r', { fetch: failing(status(404)) })).toEqual({ problem: 'no-release' })
    expect(await releaseZips('https://github.com/o/r/releases/tag/v9', { fetch: failing(status(404)) })).toEqual({ problem: 'no-release' })
  })

  it('answers not-found for a picked file GitHub no longer has', async () => {
    expect(await downloadZip(zip, { fetch: failing(status(404)) })).toEqual({ problem: 'not-found' })
  })

  it('answers no-zip for a release with no uploaded .zip', async () => {
    const assets = [asset('source.tar.gz'), asset('half.zip', 5, { state: 'starter' })]
    expect(await releaseZips('https://github.com/o/r', { fetch: failing(() => json(release(assets))) })).toEqual({ problem: 'no-zip' })
  })

  it('answers rate-limited for a 429, or a 403 with no requests left or a time to wait', async () => {
    for (const answer of [
      status(429), status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767225600' }), status(403, { 'retry-after': '60' }),
      status(429, { 'retry-after': '60' }),
    ]) {
      expect(await releaseZips('https://github.com/o/r', { fetch: failing(answer) })).toEqual({ problem: 'rate-limited' })
      expect(await downloadZip(zip, { fetch: failing(answer) })).toEqual({ problem: 'rate-limited' })
    }
  })

  it('answers bad-answer for a 403 that isn\'t the rate limit and any other status', async () => {
    for (const answer of [status(403), status(403, { 'x-ratelimit-remaining': '12' }), status(500), status(401), status(202), status(410)]) {
      expect(await releaseZips('https://github.com/o/r', { fetch: failing(answer) })).toEqual({ problem: 'bad-answer' })
    }
  })

  it('answers offline when no connection is made or one breaks mid-body', async () => {
    const refused: Fetch = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }) })
    }
    expect(await releaseZips('https://github.com/o/r', { fetch: refused })).toEqual({ problem: 'offline' })
    expect(await downloadZip(zip, { fetch: refused })).toEqual({ problem: 'offline' })
    const broken = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4))
        controller.error(new TypeError('terminated'))
      },
    }), { status: 200 })
    expect(await downloadZip({ ...zip, size: 8 }, { fetch: failing(broken) })).toEqual({ problem: 'offline' })
  })

  it('has plain words for every problem the trusted window shows', () => {
    expect(Object.keys(fetchProblemWords).sort()).toEqual([...fetchProblems].sort())
    for (const problem of fetchProblems) {
      expect(fetchProblemWords[problem], problem).toMatch(/^[A-Z][^\n]{9,}[^.]$/)
    }
  })
})
