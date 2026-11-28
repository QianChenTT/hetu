import { expect, it } from 'vitest'
import type { Provider } from '../../api/policy-jobs.ts'
import { ask, editorCaller } from './ask.ts'

// A luoshu holding a note at each name, its text the name, a listing answering pageSize names a page
export type MakeLuoshu = (names: readonly string[], pageSize: number) => Promise<Provider>

const names = [
  'a.md', 'B.md', 'ﬁ.md', '\u{1f600}.md', 'journal/b.md', 'journal/c.md', 'journal/deep/d.md', 'journalx/e.md',
  ...Array.from({ length: 5 }, (_, i) => `journal/hidden-${i}.md`), 'journal/p1.md', 'journal/p2.md',
  '.hidden.md', '.obsidian/app.json', 'journal/.todo.md', 'journal/deep/.config/x.md',
]
// Every name but the dot names in code-unit order, the astral name before U+FB01
const ordered = [
  'B.md', 'a.md', 'journal/b.md', 'journal/c.md', 'journal/deep/d.md', ...Array.from({ length: 5 }, (_, i) => `journal/hidden-${i}.md`),
  'journal/p1.md', 'journal/p2.md', 'journalx/e.md', '\u{1f600}.md', 'ﬁ.md',
]
const all = () => true
const shown = (at: string) => !at.includes('hidden-')

// The pages a listing of these names answers, two at a time, each next naming its page's last name
function paged(listed: string[]): unknown[] {
  const pages = Array.from({ length: Math.max(1, Math.ceil(listed.length / 2)) }, (_, i) => listed.slice(i * 2, i * 2 + 2))
  return pages.map((paths, i) => ({ paths, next: i < pages.length - 1 ? paths.at(-1) : null }))
}

// luoshu.list as the editor asks it, the router's canList deciding which names fill a page
export function luoshuCases(make: MakeLuoshu): void {
  const list = (luoshu: Provider, args: object, canList?: (at: string) => boolean) =>
    ask(luoshu, 'luoshu.list', args, { caller: editorCaller, ...(canList === undefined ? {} : { canList }) })

  // Every page of a listing, following next
  async function pages(luoshu: Provider, args: { folder?: string }, canList: (at: string) => boolean): Promise<unknown[]> {
    const answers: unknown[] = []
    let after: string | undefined
    do {
      const answer = await list(luoshu, { ...args, ...(after === undefined ? {} : { after }) }, canList)
      answers.push(answer)
      after = (answer as { next?: string | null }).next ?? undefined
    } while (after !== undefined && answers.length < 20)
    return answers
  }

  it('pages every name canList allows under a folder at any depth in code-unit order, the dot names left out', async () => {
    const luoshu = await make(names, 2)
    expect(await pages(luoshu, {}, all)).toEqual(paged(ordered))
    expect(await pages(luoshu, {}, shown)).toEqual(paged(ordered.filter(shown)))
    expect(await pages(luoshu, { folder: 'journal' }, shown)).toEqual(paged(ordered.filter(at => at.startsWith('journal/') && shown(at))))
    expect(await pages(luoshu, { folder: 'journal/deep' }, all)).toEqual(paged(['journal/deep/d.md']))
    expect(await list(luoshu, { after: 'journal/c.md' }, all)).toEqual({ paths: ['journal/deep/d.md', 'journal/hidden-0.md'], next: 'journal/hidden-0.md' })
  })

  it('answers no names for a folder that is missing, a note or one canList allows nothing in', async () => {
    const luoshu = await make(names, 2)
    for (const [folder, canList] of [['missing', all], ['a.md', all], ['journal', () => false]] as const) {
      expect(await list(luoshu, { folder }, canList), folder).toEqual({ paths: [], next: null })
    }
  })

  it('refuses a dot folder not-granted and a listing with no canList failed', async () => {
    const luoshu = await make(names, 2)
    for (const folder of ['.obsidian', 'journal/deep/.config']) expect(await list(luoshu, { folder }, all), folder).toEqual({ refused: { code: 'not-granted' } })
    expect(await list(luoshu, {})).toEqual({ refused: { code: 'failed' } })
  })
}
