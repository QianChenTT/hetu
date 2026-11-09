import type { CoreLink } from './link.ts'

// The quick-open palette's logic: note names listed through the window's own luoshu.list and filtered as the human
// types. The page draws it in the core layer

// Pages listed each time the palette opens, 1,000 names each
export const PALETTE_PAGES = 20
// Names shown at once
export const PALETTE_SHOWN = 50

// How long a listing waits in all for the window's listing budget, a second at a time
export const LIST_WAIT_MS = 60_000

export type Listed = { names: string[], cut: boolean, refused?: string }

export type ListOptions = {
  pages?: number
  // A second's pause after a throttled page, then the same page is asked for again
  wait?: (ms: number) => Promise<void>
  // Each page as it comes, so the palette can show names while the rest are listed
  onPage?: (names: string[]) => void
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// Every name in the luoshu a page at a time, up to pages of them. cut says there were more. The core charges a listing
// to the window's own budget, so in a large luoshu a page comes back throttled: the same page is asked for again a
// second later, until the listing waited LIST_WAIT_MS in all
export async function listNames(link: CoreLink, options: ListOptions = {}): Promise<Listed> {
  const pages = options.pages ?? PALETTE_PAGES
  const wait = options.wait ?? pause
  const names: string[] = []
  let after: string | undefined
  let waited = 0
  for (let page = 0; page < pages;) {
    const got = await link.call('luoshu.list', after === undefined ? {} : { after })
    if (!got.ok) {
      const code = got.refusal?.code ?? 'failed'
      if (code !== 'throttled' || waited >= LIST_WAIT_MS) return { names, cut: false, refused: code }
      await wait(1000)
      waited += 1000
      continue
    }
    const { paths, next } = got.result as { paths: string[], next: string | null }
    names.push(...paths)
    options.onPage?.(paths)
    if (next === null) return { names, cut: false }
    after = next
    page++
  }
  return { names, cut: true }
}

type Scored = { name: string, rank: number, at: number }

// Where the query's letters fall in name in order, ignoring case: the whole query as a substring ranks first, then
// letters in order, each by where the match starts. Null when they don't
function score(name: string, query: string): Scored | null {
  const lower = name.toLowerCase()
  const whole = lower.indexOf(query)
  if (whole >= 0) return { name, rank: 0, at: whole }
  let from = 0
  let first = -1
  for (const letter of query) {
    const found = lower.indexOf(letter, from)
    if (found < 0) return null
    if (first < 0) first = found
    from = found + letter.length
  }
  return { name, rank: 1, at: first }
}

// The names matching query, best first, at most max. An empty query keeps name order
export function filterNames(names: readonly string[], query: string, max: number = PALETTE_SHOWN): string[] {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return names.slice(0, max)
  const scored: Scored[] = []
  for (const name of names) {
    const found = score(name, wanted)
    if (found !== null) scored.push(found)
  }
  scored.sort((a, b) => a.rank - b.rank || a.at - b.at || a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return scored.slice(0, max).map(found => found.name)
}
