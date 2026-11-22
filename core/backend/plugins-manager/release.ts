import { z } from 'zod'
import { FetchRefused, getFromGitHub, onGitHub, type Fetch, type FetchLimits, type FetchProblem, type Wanted } from './github.ts'

// A GitHub release's zips: a pasted repo or release link resolved through GitHub's API to the release's .zip assets,
// and the bytes of the one the human picks. Nothing here unpacks or installs

const MiB = 1024 * 1024

// A release's answer from the API, every asset with its uploader included. GitHub holds at most 1,000 assets a release
export const releaseLimits: FetchLimits = Object.freeze({ bytes: 8 * MiB, ms: 20_000 })

// 64 MiB is the most unpack.ts writes from one zip (unpackLimits.bytes there). A zip is its entries' data, stored or
// deflated, never more than written, plus a local header and a central record for each of its 2,000 entries at most,
// each holding the name up to 1,024 characters and extra fields: 8 MiB covers about 4 KiB an entry. Ten minutes take
// the whole cap at about 1 Mbit/s and the human can cancel sooner
export const zipLimits: FetchLimits = Object.freeze({ bytes: 64 * MiB + 8 * MiB, ms: 600_000 })

export type FetchOptions = { fetch?: Fetch, signal?: AbortSignal, limits?: Partial<FetchLimits> }

// A repo on github.com and the tag of the release a link names, or null for the latest
export type GitHubLink = { owner: string, repo: string, tag: string | null }

// GitHub's own rules for an account name and a repo name
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

// What a pasted link names: https://github.com/<owner>/<repo>, its releases page, its latest release or a release by
// tag, or null. The query and the fragment are ignored
export function githubLink(pasted: string): GitHubLink | null {
  let at: URL
  try {
    at = new URL(pasted.trim())
  } catch {
    return null
  }
  if (at.protocol !== 'https:' || at.hostname !== 'github.com' || at.username !== '' || at.password !== '' || at.port !== '') return null
  const segments = at.pathname.split('/').slice(1)
  if (segments.at(-1) === '') segments.pop()
  const [owner, named, ...rest] = segments
  const repo = named?.endsWith('.git') === true ? named.slice(0, -4) : named
  if (owner === undefined || repo === undefined || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null
  if (rest.length === 0 || (rest.length === 1 && rest[0] === 'releases') || (rest.length === 2 && rest[0] === 'releases' && rest[1] === 'latest')) {
    return { owner, repo, tag: null }
  }
  if (rest.length < 3 || rest[0] !== 'releases' || rest[1] !== 'tag') return null
  const tag = rest.slice(2).map(decoded)
  if (tag.some(segment => segment === null || segment === '')) return null
  return { owner, repo, tag: tag.join('/') }
}

// A .zip asset of a release, as the human picks it
export type ReleaseZip = { name: string, size: number, url: string }

export type Release = { problem: null, tag: string, zips: ReleaseZip[] } | { problem: FetchProblem }

const releaseAnswer = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({
    name: z.string(),
    size: z.number().int().nonnegative(),
    // uploaded once whole. An upload under way is starter
    state: z.string(),
    browser_download_url: z.string(),
  })),
})

const API = 'https://api.github.com'
// The answer GitHub's docs ask a client to accept and the API version whose release shape is read here
const RELEASE_WANTED: Wanted = Object.freeze({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' })
const ZIP_WANTED: Wanted = Object.freeze({ accept: 'application/octet-stream' })

function parsedRelease(bytes: Buffer): z.infer<typeof releaseAnswer> {
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new FetchRefused('bad-answer')
  }
  const checked = releaseAnswer.safeParse(body)
  if (!checked.success) throw new FetchRefused('bad-answer')
  return checked.data
}

async function answer<T>(work: () => Promise<T>): Promise<T | { problem: FetchProblem }> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof FetchRefused) return { problem: err.problem }
    throw err
  }
}

// The .zip assets of the release a pasted link names, the latest when it names none
export async function releaseZips(pasted: string, options: FetchOptions = {}): Promise<Release> {
  const link = githubLink(pasted)
  if (link === null) return { problem: 'not-github' }
  const which = link.tag === null ? 'latest' : `tags/${encodeURIComponent(link.tag)}`
  const url = `${API}/repos/${link.owner}/${link.repo}/releases/${which}`
  return answer(async () => {
    const bytes = await getFromGitHub(url, RELEASE_WANTED, { ...releaseLimits, ...options.limits }, options)
    const release = parsedRelease(bytes)
    const zips = release.assets
      .filter(asset => asset.state === 'uploaded' && asset.name.toLowerCase().endsWith('.zip'))
      .map(asset => ({ name: asset.name, size: asset.size, url: asset.browser_download_url }))
    // An answer that points a download off GitHub's hosts would steer main elsewhere, so none of it is offered
    if (zips.some(zip => !onGitHub(zip.url))) throw new FetchRefused('off-github')
    return { problem: null, tag: release.tag_name, zips }
  })
}

export type Downloaded = { problem: null, bytes: Buffer } | { problem: FetchProblem }

// The bytes of a picked zip, refused before any request when the release says it is past the cap
export async function downloadZip(zip: ReleaseZip, options: FetchOptions = {}): Promise<Downloaded> {
  const limits = { ...zipLimits, ...options.limits }
  if (zip.size > limits.bytes) return { problem: 'too-big' }
  return answer(async () => ({ problem: null, bytes: await getFromGitHub(zip.url, ZIP_WANTED, limits, options) }))
}
