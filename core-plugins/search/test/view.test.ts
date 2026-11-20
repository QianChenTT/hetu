import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { checkManifest } from '@hetu/sdk/check-manifest'
import { buildPlugin } from '@hetu/sdk/esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_ROWS } from '../src/view.ts'
import search from '../src/worker.ts'
import { click, close, core, finds, manifest, nodes, query, row, rows, status, type, until, view } from './helpers.ts'

afterEach(close)

const root = path.join(import.meta.dirname, '..')

describe('search\'s manifest', () => {
  // ui.view for the view and editor.open, which needs a read from api 3 on
  it('asks for a view and nothing more than search had', async () => {
    const declared = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>
    expect(declared).toEqual({
      id: 'search',
      name: 'Search',
      version: '0.1.0',
      api: '^3',
      entries: { worker: 'dist/worker.js' },
      requires: ['luoshu'],
      views: { search: { title: 'Search', kind: 'view' } },
      provides: { actions: { query: {} }, topics: ['indexed'] },
      capabilities: [
        { type: 'luoshu.read', paths: ['**'] },
        { type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] },
        { type: 'ui.view' },
      ],
    })
  })

  it('passes the checks hetu\'s loader makes, built as its build script builds it', async () => {
    await buildPlugin(root, { entries: { 'dist/worker.js': 'src/worker.ts' }, workers: ['dist/worker.js'] })
    expect(await checkManifest(root, { built: true })).toEqual([])
  }, 15_000)
})

describe('the view', () => {
  it('draws an input and lists the notes holding every word typed', async () => {
    const { fake, drawer } = core({ notes: { 'b.md': 'fox otter', 'a.md': 'fox', 'c.md': 'heron' } })
    await fake.start(search)
    await until(() => nodes(view(drawer)).some(node => node.id === 'query' && node.kind === 'input'))
    expect(rows(drawer)).toEqual([])
    await finds(fake, 'fox', ['a.md', 'b.md'])
    type(drawer, 'query', 'fox')
    await until(() => rows(drawer).length === 2)
    expect(rows(drawer)).toEqual(['a.md', 'b.md'])
    expect(status(drawer)).toBe('2 notes')
    type(drawer, 'query', 'fox otter')
    await until(() => rows(drawer).length === 1)
    expect(rows(drawer)).toEqual(['b.md'])
    type(drawer, 'query', 'badger')
    await until(() => rows(drawer).length === 0)
    expect(status(drawer)).toBe('No note holds every word')
  })

  it('opens the note of the row clicked', async () => {
    const { fake, drawer } = core({ notes: { 'a.md': 'fox', 'b.md': 'fox' } })
    await fake.start(search)
    await finds(fake, 'fox', ['a.md', 'b.md'])
    type(drawer, 'query', 'fox')
    await until(() => rows(drawer).length === 2)
    click(drawer, row(drawer, 'b.md'))
    await until(() => drawer.opened.length === 1)
    expect(drawer.opened).toEqual(['b.md'])
  })

  // The human clicks a row drawn before the list changed under it
  it('opens the note a row was drawn for after the rows moved', async () => {
    const { fake, drawer } = core({ notes: { 'a.md': 'fox apple', 'b.md': 'fox berry', 'c.md': 'berry' } })
    await fake.start(search)
    await finds(fake, 'berry', ['b.md', 'c.md'])
    type(drawer, 'query', 'fox')
    await until(() => rows(drawer).length === 2)
    const drawnFor = row(drawer, 'b.md')
    type(drawer, 'query', 'berry')
    await until(() => rows(drawer).join() === 'b.md,c.md')
    click(drawer, drawnFor)
    await until(() => drawer.opened.length === 1)
    expect(drawer.opened).toEqual(['b.md'])
  })

  it('draws a control or bidi character in a path as U+FFFD', async () => {
    const { fake, drawer } = core({ notes: { 'notes/‮gnp.md': 'fox' } })
    await fake.start(search)
    await finds(fake, 'fox', ['notes/‮gnp.md'])
    type(drawer, 'query', 'fox')
    await until(() => rows(drawer).length === 1)
    expect(rows(drawer)).toEqual(['notes/�gnp.md'])
  })

  // As the human taking search's read on private/** away while its words are still in the index
  it('shows a refused open in the status line', async () => {
    const { fake, drawer } = core({ notes: { 'private/b.md': 'fox' } })
    await fake.start(search)
    await finds(fake, 'fox', ['private/b.md'])
    type(drawer, 'query', 'fox')
    await until(() => rows(drawer).length === 1)
    drawer.connect([{ type: 'ui.view' }, { type: 'luoshu.read', paths: ['public/**'] }], { search: { title: 'Search', kind: 'view' } })
    await until(() => drawer.instances().every(({ instance }) => drawer.tree(instance) !== null))
    click(drawer, row(drawer, 'private/b.md'))
    await until(() => status(drawer) !== '1 note')
    expect(status(drawer)).toBe('Can’t open private/b.md: not-granted')
    expect(drawer.opened).toEqual([])
  })

  it('draws again in a view opened on a new editor page', async () => {
    const { fake, drawer } = core({ notes: { 'a.md': 'fox' } })
    await fake.start(search)
    await finds(fake, 'fox', ['a.md'])
    type(drawer, 'query', 'fox')
    await until(() => rows(drawer).length === 1)
    drawer.connect([{ type: 'ui.view' }, { type: 'luoshu.read', paths: ['**'] }], { search: { title: 'Search', kind: 'view' } })
    const opened = drawer.instances().at(-1)!.instance
    await until(() => drawer.tree(opened) !== null)
    const input = nodes(drawer.tree(opened)).find(node => node.id === 'query') as { value: string }
    expect(input.value).toBe('fox')
    expect(nodes(drawer.tree(opened)).filter(node => (node as { text?: string }).text === 'a.md')).toHaveLength(1)
  })

  it('draws at most MAX_ROWS rows and says how many it left out', async () => {
    const notes: Record<string, string> = {}
    for (let i = 0; i < MAX_ROWS + 50; i++) notes[`notes/${String(i).padStart(3, '0')}.md`] = 'fox'
    const { fake, drawer } = core({ notes })
    await fake.start(search)
    await until(async () => (await query(fake, 'fox')).length === MAX_ROWS + 50, 5000)
    type(drawer, 'query', 'fox')
    await until(() => rows(drawer).length > 0 && status(drawer) === `First ${MAX_ROWS} of ${MAX_ROWS + 50} notes`, 5000)
    expect(rows(drawer)).toHaveLength(MAX_ROWS)
  }, 10_000)
})
