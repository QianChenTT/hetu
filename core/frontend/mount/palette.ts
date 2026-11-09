import type { CoreLink } from './link.ts'

// The quick-open palette's logic: note names listed through the window's own luoshu.list and filtered as the human
// types. The page draws it in the core layer

// Pages listed each time the palette opens, 1,000 names each
export const PALETTE_PAGES = 20
// Names shown at once
export const PALETTE_SHOWN = 50

export type Listed = { names: string[], cut: boolean, refused?: string }

// Every name in the luoshu a page at a time, up to pages of them. cut says there were more
export async function listNames(link: CoreLink, pages: number = PALETTE_PAGES): Promise<Listed> {
  const names: string[] = []
  let after: string | undefined
  for (let page = 0; page < pages; page++) {
    const got = await link.call('luoshu.list', after === undefined ? {} : { after })
    if (!got.ok) return { names, cut: false, refused: got.refusal?.code ?? 'failed' }
    const { paths, next } = got.result as { paths: string[], next: string | null }
    names.push(...paths)
    if (next === null) return { names, cut: false }
    after = next
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
