import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { checkManifest } from '@hetu/sdk/check-manifest'
import { buildPlugin } from '@hetu/sdk/esbuild'
import type { PluginContext } from '@hetu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ROWS } from '../src/view.ts'
import search from '../src/worker.ts'
import { click, close, core, finds, manifest, nodes, query, row, rows, status, tick, type, until, view, wrapped } from './helpers.ts'

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

  it('draws again once the reads at start end, for words typed while they ran', async () => {
    const notes: Record<string, string> = {}
    for (let i = 0; i < 50; i++) notes[`notes/${i}.md`] = 'fox'
    const { fake, drawer } = core({ notes, latencyMs: 20 })
    await fake.start(search)
    type(drawer, 'query', 'fox')
    await until(() => status(drawer) !== null)
    expect(rows(drawer).length).toBeLessThan(50)
    await until(() => rows(drawer).length === 50)
    expect(status(drawer)).toBe('50 notes')
  })

  // The refusal answers after the human typed again, so the line says what the newer search found
  it('keeps the status of a search typed after a click whose open is refused', async () => {
    const { fake, drawer } = core({ notes: { 'private/b.md': 'fox', 'public/c.md': 'heron' } })
    await fake.start(search)
    await finds(fake, 'heron', ['public/c.md'])
    type(drawer, 'query', 'fox')
    await until(() => rows(drawer).length === 1)
    drawer.connect([{ type: 'ui.view' }, { type: 'luoshu.read', paths: ['public/**'] }], { search: { title: 'Search', kind: 'view' } })
    await until(() => drawer.instances().every(({ instance }) => drawer.tree(instance) !== null))
    click(drawer, row(drawer, 'private/b.md'))
    type(drawer, 'query', 'heron')
    await until(() => rows(drawer).join() === 'public/c.md')
    await tick(50)
    expect(status(drawer)).toBe('1 note')
  })
})

describe('a throw that is no refusal', () => {
  const unhandled: unknown[] = []
  const heard = (err: unknown) => void unhandled.push(err)
  beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', heard)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    process.off('unhandledRejection', heard)
    vi.restoreAllMocks()
  })
  const broken = () => Promise.reject(new TypeError('broken'))

  it('in the listing is logged and not left unhandled', async () => {
    const { fake } = core({ notes: { 'a.md': 'fox' } })
    expect(await fake.start(wrapped(ctx => ({ luoshu: { ...ctx.luoshu, list: broken } })))).toEqual({ state: 'ready' })
    await tick(100)
    expect(unhandled).toEqual([])
    expect(console.error).toHaveBeenCalledWith('search: a task threw', expect.any(TypeError))
  })

  it('in a draw or an open is logged and not left unhandled', async () => {
    const { fake, drawer } = core({ notes: { 'a.md': 'fox' } })
    const ui = (ctx: PluginContext) => ({ ...ctx.ui, on: ctx.ui.on.bind(ctx.ui), views: { ...ctx.ui.views, draw: broken } })
    await fake.start(wrapped(ctx => ({ ui: ui(ctx), editor: { open: broken } as unknown as PluginContext['editor'] })))
    await finds(fake, 'fox', ['a.md'])
    type(drawer, 'query', 'fox')
    await tick(50)
    click(drawer, 'r1')
    await tick(100)
    expect(unhandled).toEqual([])
    expect(vi.mocked(console.error).mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})
