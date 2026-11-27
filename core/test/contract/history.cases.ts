import { expect, it } from 'vitest'
import type { Provider } from '../../api/policy-jobs.ts'
import { ask, editorCaller, pluginCaller, type Asking } from './ask.ts'

// history.* over a notes folder, write and remove changing a note in it as the luoshu would
export type HistorySubject = { provider: Provider, write(name: string, text: string): Promise<void>, remove(name: string): Promise<void> }

const date = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/)
const entry = (commit: string, message: string, author = 'reader', committer = author) => ({ commit, author, committer, date, message })

export function historyCases(make: () => Promise<HistorySubject>): void {
  async function commit(history: HistorySubject, paths: string[], message: string, as?: Asking): Promise<string> {
    const answer = await ask(history.provider, 'history.commit', { paths, message }, as)
    expect(answer).toEqual({ commit: expect.stringMatching(/^[0-9a-f]{40}$/) })
    return (answer as { commit: string }).commit
  }
  const log = (history: HistorySubject, path: string, limit?: number) =>
    ask(history.provider, 'history.log', limit === undefined ? { path } : { path, limit })
  const read = (history: HistorySubject, path: string, at: string) => ask(history.provider, 'history.read', { path, commit: at })

  it('logs nothing for a note never committed and makes no commit when nothing changed', async () => {
    const history = await make()
    expect(await log(history, 'a.md')).toEqual({ commits: [] })
    expect(await ask(history.provider, 'history.commit', { paths: ['none.md'], message: 'nothing yet' })).toEqual({ commit: null })
    await history.write('a.md', 'note a')
    await commit(history, ['a.md'], 'first')
    expect(await ask(history.provider, 'history.commit', { paths: ['a.md'], message: 'same' })).toEqual({ commit: null })
  })

  it('commits each path once with its message less its last newlines and logs a note or a folder newest first', async () => {
    const history = await make()
    await history.write('a.md', 'note a')
    await history.write('journal/b.md', 'note b')
    const both = await commit(history, ['a.md', 'journal/b.md', 'a.md'], 'both\n\n')
    await history.write('a.md', 'note a, edited')
    const again = await commit(history, ['a.md'], 'again')
    expect(await log(history, 'a.md')).toEqual({ commits: [entry(again, 'again'), entry(both, 'both')] })
    expect(await log(history, 'journal')).toEqual({ commits: [entry(both, 'both')] })
    expect(await log(history, 'a.md', 1)).toEqual({ commits: [entry(again, 'again')] })
  })

  it('records a path with no note as removed and reads a note\'s text and version at a commit', async () => {
    const history = await make()
    await history.write('journal/b.md', 'note b')
    const first = await commit(history, ['journal/b.md'], 'b')
    await history.remove('journal/b.md')
    await history.write('journal/c.md', 'note c')
    const gone = await commit(history, ['journal/b.md', 'journal/c.md'], 'b gone')
    expect(await log(history, 'journal/b.md')).toEqual({ commits: [entry(gone, 'b gone'), entry(first, 'b')] })
    // The version is the SHA-256 hex of the note's UTF-8 bytes
    expect(await read(history, 'journal/b.md', first)).toEqual({ text: 'note b', version: 'd3f530389119ea7da8eab35f264572cfc6a6b03ec5f73e48bae35a36ecc03d96' })
    for (const [path, at] of [['journal/b.md', gone], ['journal', first], ['journal/b.md', 'f'.repeat(40)]]) {
      expect(await read(history, path, at), path).toEqual({ refused: { code: 'not-found' } })
    }
  })

  it('names a commit by signatureOf: a pair\'s field over its root plugin, else the caller with a window\'s onBehalf', async () => {
    const history = await make()
    const handler = pluginCaller('mcp-http-handler', 'host')
    const asked: [Asking, string, string][] = [
      [{ onBehalf: 'agent <x@example.com>' }, 'agent x@example.com', 'reader'],
      [{ caller: pluginCaller('mcp'), root: handler, onBehalf: 'claude-code#1' }, 'claude-code#1', 'mcp-http-handler'],
      [{ caller: editorCaller, onBehalf: 'a person' }, 'a person', 'window.editor'],
    ]
    const made: string[] = []
    for (const [i, [as]] of asked.entries()) {
      await history.write('a.md', `text ${i}`)
      made.push(await commit(history, ['a.md'], `by ${i}`, as))
    }
    expect(await log(history, 'a.md')).toEqual({ commits: asked.map(([, author, committer], i) => entry(made[i], `by ${i}`, author, committer)).reverse() })
  })
}
