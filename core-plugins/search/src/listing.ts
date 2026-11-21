import { Refused } from '@hetu/sdk'

// A throttled page is asked for again after RETRY_MS, until the listing waited WAIT_MS in all, as hetu's palette does
export const RETRY_MS = 1000
export const WAIT_MS = 60_000

export type Page = { paths: string[], next: string | null }
export type Lister = (args: { after?: string }) => Promise<Page>
// The names listed and the refusal that ended the listing early, null when every page came
export type Listed = { paths: string[], refused: string | null }

// Every page of a listing, each asked for after the last name of the one before. The luoshu charges a listing to the
// plugin's filter budget, so a page can come back throttled once the SDK's own retries ran out: the same page is asked
// for again. Any other refusal ends the listing with the names listed so far. wait is a timer but in tests
export async function listAll(list: Lister, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<Listed> {
  const paths: string[] = []
  let after: string | undefined
  let waited = 0
  for (;;) {
    let page: Page
    try {
      page = await list(after === undefined ? {} : { after })
    } catch (err) {
      if (!(err instanceof Refused)) throw err
      if (err.code !== 'throttled' || waited >= WAIT_MS) return { paths, refused: err.code }
      await wait(RETRY_MS)
      waited += RETRY_MS
      continue
    }
    paths.push(...page.paths)
    if (page.next === null) return { paths, refused: null }
    after = page.next
  }
}
