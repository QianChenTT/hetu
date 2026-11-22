import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type PluginContext } from '../sdk/plugin.ts'
import { type FakeCore, fakeCore, type FakeCoreOptions, FakeDrawer, type FakeMode, type StandIn } from '../sdk/testing/index.ts'
import type { Capability } from '../api/capabilities.ts'
import { LIST_PAGE } from '../api/actions.ts'
import { API_VERSION } from '../api/manifest.ts'
import { quotas } from '../api/storage.ts'
import type { Call, Provider } from '../api/policy-jobs.ts'
import { MemoryHistory, MemoryLuoshu, MemoryStorage } from '../sdk/testing/providers.ts'
import { createLuoshu } from '../backend/providers/luoshu/luoshu.ts'
import { tick } from './router-fakes.ts'
import { Drawer, type Instance, type PortLike } from '../frontend/editor/bridge.ts'
import { CoreLink } from '../frontend/editor/link.ts'
import { Versions } from '../frontend/editor/versions.ts'
import { Editor, type EditorClient } from '../sdk/editor.ts'
import { fakeCore as editorCore } from './editor-fakes.ts'
import { callOf as historyCall, cleanup as historyCleanup, place as historyPlace, started as historyStarted, type Asking as HistoryAsking } from './modules/history/helpers.ts'

const cores: FakeCore[] = []
afterEach(async () => {
  for (const core of cores.splice(0)) await core.close()
})

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(5)
  }
}

const manifest = (over: object = {}) => ({
  id: 'reader',
  name: 'Reader',
  version: '1.0.0',
  api: '^3',
  entries: { worker: 'dist/worker.js' },
  provides: { actions: { read: {}, list: {} } },
  capabilities: [{ type: 'luoshu.read', paths: ['notes/**'] }],
  ...over,
})

function core(mode?: FakeMode, over: object = {}, extra: Omit<FakeCoreOptions, 'manifest' | 'notes' | 'mode'> = {}): FakeCore {
  const made = fakeCore({ manifest: manifest(over), notes: { 'notes/a.md': 'a', 'secret/b.md': 'b' }, ...(mode === undefined ? {} : { mode }), ...extra })
  cores.push(made)
  return made
}

// Reads a note for whoever calls read. Keeps its ctx for the test
function reader() {
  const box: { ctx: PluginContext | null, started: boolean } = { ctx: null, started: false }
  const plugin = definePlugin({
    start: ctx => {
      box.ctx = ctx
      box.started = true
      ctx.provide('read', async (call, args) => (await call.ctx.luoshu.read({ path: (args as { path: string }).path })).text)
      ctx.provide('list', call => ctx.filterReadable(call, ['public/a.md', 'private/b.md']))
    },
  })
  return { plugin, box }
}

describe('the fake core', () => {
  it('starts a plugin and reports ready', async () => {
    expect(await core().start(reader().plugin)).toEqual({ state: 'ready' })
  })

  it('grants exactly the manifest by default', async () => {
    const fake = core()
    await fake.start(reader().plugin)
    expect(await fake.call('reader.read', { path: 'notes/a.md' })).toEqual({ ok: true, result: 'a' })
    expect(await fake.call('reader.read', { path: 'secret/b.md' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it('allows everything in allow-all and nothing in deny-all, free actions still passing', async () => {
    const open = core('allow-all')
    const one = reader()
    await open.start(one.plugin)
    expect(await one.box.ctx!.luoshu.read({ path: 'secret/b.md' })).toMatchObject({ text: 'b' })
    const shut = core('deny-all')
    const two = reader()
    await shut.start(two.plugin)
    await expect(two.box.ctx!.luoshu.read({ path: 'notes/a.md' })).rejects.toMatchObject({ code: 'not-granted' })
    expect(await two.box.ctx!.storage.set({ key: 'k', value: 1 })).toBe(null)
    expect(shut.stored('storage', 'k')).toBe(1)
  })

  it('answers policy-down for every call with power while the gate failed, storage still served', async () => {
    const fake = core('gate-failed')
    const { plugin, box } = reader()
    expect(await fake.start(plugin)).toEqual({ state: 'ready' })
    await expect(box.ctx!.luoshu.read({ path: 'notes/a.md' })).rejects.toMatchObject({ code: 'policy-down' })
    expect(await box.ctx!.cache.set({ key: 'k', value: 'v' })).toBe(null)
    expect(fake.stored('cache', 'k')).toBe('v')
    expect(await fake.call('reader.read', { path: 'notes/a.md' })).toMatchObject({ ok: false, refusal: { code: 'policy-down' } })
  })

  it('holds a plugin waiting while a requirement is missing and starts it with lastStop once restored', async () => {
    const fake = core('dependency-missing', { requires: ['luoshu'] })
    const { plugin, box } = reader()
    expect(await fake.start(plugin)).toEqual({ state: 'waiting', reason: 'dependency:luoshu:absent' })
    expect(box.started).toBe(false)
    expect(await fake.restore()).toEqual({ state: 'ready' })
    expect(box.ctx!.lastStop).toBe('dependency:luoshu:absent')
    expect(await fake.call('reader.read', { path: 'notes/a.md' })).toEqual({ ok: true, result: 'a' })
  })

  it('refuses a manifest outside the schema', () => {
    expect(() => fakeCore({ manifest: manifest({ capabilities: [{ type: 'luoshu.teleport' }] }) })).toThrow()
  })

  // As the plugins manager refuses it with api, so a plugin's own tests fail where hetu would
  it('refuses a manifest whose api range leaves out this core, and takes an older one this core only added to', () => {
    expect(() => fakeCore({ manifest: manifest({ api: '^1' }) })).toThrow(/api/)
    expect(() => fakeCore({ manifest: manifest({ api: '^2', capabilities: [{ type: 'ui.edit', paths: ['**'] }] }) })).toThrow(/api/)
    cores.push(fakeCore({ manifest: manifest({ api: '^2' }) }))
  })

  // The fake luoshu serves both actions and the router judges them as hetu's does: write on both ends of a move and
  // read on the end it leaves
  it('serves luoshu.remove and luoshu.move, a move judged on both ends and on read where it leaves', async () => {
    const fake = core(undefined, {
      capabilities: [{ type: 'luoshu.write', paths: ['**'] }, { type: 'luoshu.read', paths: ['notes/**'] }],
    })
    const { plugin, box } = reader()
    await fake.start(plugin)
    const ctx = box.ctx!
    await expect(ctx.luoshu.move({ from: 'secret/b.md', to: 'notes/b.md' })).rejects.toMatchObject({ code: 'not-granted' })
    expect(fake.luoshu.read('secret/b.md')).toBe('b')
    await fake.luoshu.write('notes/c.md', 'c')
    await expect(ctx.luoshu.move({ from: 'notes/a.md', to: 'notes/c.md' })).rejects.toMatchObject({ code: 'stale' })
    expect(await ctx.luoshu.move({ from: 'notes/a.md', to: 'notes/old/a.md' })).toBe(null)
    expect(fake.luoshu.read('notes/old/a.md')).toBe('a')
    expect(fake.luoshu.read('notes/a.md')).toBeUndefined()
    await expect(ctx.luoshu.remove({ path: 'notes/c.md', baseVersion: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'stale' })
    // The version is required, as hetu's schema holds it
    await expect(ctx.luoshu.remove({ path: 'notes/c.md' } as never)).rejects.toMatchObject({ code: 'invalid' })
    const { version } = await ctx.luoshu.read({ path: 'notes/c.md' })
    expect(await ctx.luoshu.remove({ path: 'notes/c.md', baseVersion: version })).toBe(null)
    expect(fake.luoshu.read('notes/c.md')).toBeUndefined()
    await expect(ctx.luoshu.remove({ path: 'notes/c.md', baseVersion: version })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('publishes luoshu.changed for a note the test writes, luoshu.outside for one written outside', async () => {
    const fake = core(undefined, {
      capabilities: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] }],
    })
    const heard: string[] = []
    await fake.start(definePlugin({
      start: async ctx => {
        await ctx.events.on(['luoshu.changed', 'luoshu.outside'], event => { heard.push(`${event.topic} ${event.path}`) })
      },
    }))
    await fake.luoshu.write('notes/c.md', 'c')
    await fake.luoshu.write('notes/d.md', 'd', { outside: true })
    await until(() => heard.length === 2)
    expect(heard).toEqual(['luoshu.changed notes/c.md', 'luoshu.outside notes/d.md'])
    expect(fake.luoshu.read('notes/c.md')).toBe('c')
  })

  it('gives a test caller the grants it names', async () => {
    const fake = core(undefined, { capabilities: [{ type: 'luoshu.read', paths: ['**'] }] })
    await fake.start(reader().plugin)
    const reply = await fake.call('reader.list', {}, {
      grants: [{ type: 'plugin.call', targets: ['reader'] }, { type: 'luoshu.read', paths: ['public/**'] }],
    })
    expect(reply).toEqual({ ok: true, result: ['public/a.md'] })
  })

  // A test caller that names onBehalf roots a chain for that pair, so what the plugin does under its call is judged on
  // the pair's items too, keyed by the field up to its first #
  it('judges a call under a test caller\'s call for a pair on the pair\'s grants as well', async () => {
    const fake = core(undefined, { capabilities: [{ type: 'luoshu.read', paths: ['**'] }] })
    await fake.start(reader().plugin)
    expect(await fake.call('reader.read', { path: 'notes/a.md' }, { onBehalf: 'client-1#1' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await fake.call('reader.list', {}, { onBehalf: 'client-1#1' })).toEqual({ ok: true, result: [] })
    const pairGrants: Capability[] = [{ type: 'luoshu.read', paths: ['notes/**', 'public/**'] }]
    expect(await fake.call('reader.read', { path: 'notes/a.md' }, { onBehalf: 'client-1#1', pairGrants })).toEqual({ ok: true, result: 'a' })
    expect(await fake.call('reader.list', {}, { onBehalf: 'client-1#2' })).toEqual({ ok: true, result: ['public/a.md'] })
    expect(await fake.call('reader.read', { path: 'secret/b.md' }, { onBehalf: 'client-1#2' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await fake.call('reader.read', { path: 'notes/a.md' }, { onBehalf: 'client-2' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await fake.call('reader.read', { path: 'secret/b.md' })).toEqual({ ok: true, result: 'b' })
  })

  it('reports crashed with start-timeout when ready never comes', async () => {
    const fake = core(undefined, {}, { readyMs: 100 })
    expect(await fake.start(definePlugin({ start: () => new Promise(() => {}) }))).toEqual({ state: 'crashed', reason: 'start-timeout' })
  })

  it('stops the plugin within its grace', async () => {
    const fake = core()
    let stopped = false
    await fake.start(definePlugin({ start: ctx => { ctx.onStop(() => { stopped = true }) } }))
    await fake.stop()
    expect(stopped).toBe(true)
    expect((await fake.call('reader.read', { path: 'notes/a.md' })).ok).toBe(false)
  })
})

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

describe('the fake core\'s luoshu listing', () => {
  // More than two pages of notes with a file the grant leaves out beside each, so a page fills only with names the
  // plugin may list. Names that sort apart by code unit and by code point, dot names and a folder whose name starts as
  // the listed one's
  it('pages every name the plugin may list under a folder at any depth, LIST_PAGE at a time in code-unit order, each once', async () => {
    const notes: Record<string, string> = {}
    const listable: string[] = []
    for (let i = 0; i < 2500; i++) {
      const name = `notes/${i % 3 === 0 ? 'deep/er/' : ''}${String(i).padStart(4, '0')}.md`
      notes[name] = 'n'
      notes[name.replace(/\.md$/, '.png')] = 'p'
      listable.push(name)
    }
    const odd = ['notes/B.md', 'notes/a.md', 'notes/ﬁ.md', 'notes/\u{1f600}.md']
    for (const name of [...odd, 'notes/.hidden.md', 'notes/.obsidian/x.md', 'notes/deep/.cache/y.md', 'notesx/n.md', 'secret/s.md']) notes[name] = 'x'
    listable.push(...odd)
    const fake = fakeCore({ manifest: manifest({ capabilities: [{ type: 'luoshu.list', paths: ['**/*.md'] }] }), notes })
    cores.push(fake)
    const { plugin, box } = reader()
    await fake.start(plugin)
    const ctx = box.ctx!
    const pages: string[][] = []
    let after: string | undefined
    for (;;) {
      const page = await ctx.luoshu.list({ folder: 'notes', ...(after === undefined ? {} : { after }) })
      pages.push(page.paths)
      if (page.next === null) break
      expect(page.next).toBe(page.paths.at(-1))
      after = page.next
    }
    expect(pages.map(page => page.length)).toEqual([LIST_PAGE, LIST_PAGE, 2504 - 2 * LIST_PAGE])
    expect(pages.flat()).toEqual([...listable].sort(byCodeUnit))
    // The whole luoshu with no folder, the astral name before U+FB01 as code units order them
    expect(await ctx.luoshu.list({ after: 'notes/deep/er/2499.md' })).toEqual({ paths: ['notes/\u{1f600}.md', 'notes/ﬁ.md', 'notesx/n.md', 'secret/s.md'], next: null })
    expect((await ctx.luoshu.list({ folder: 'notes/deep' })).paths).toEqual(listable.filter(name => name.startsWith('notes/deep/')).sort(byCodeUnit))
    for (const folder of ['notes/dee', 'missing', 'notes/a.md']) expect(await ctx.luoshu.list({ folder })).toEqual({ paths: [], next: null })
    for (const folder of ['notes/.obsidian', 'notes/deep/.cache']) await expect(ctx.luoshu.list({ folder })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('lists nothing for a plugin that may list nothing', async () => {
    const fake = core(undefined, { capabilities: [] })
    const { plugin, box } = reader()
    await fake.start(plugin)
    expect(await box.ctx!.luoshu.list({})).toEqual({ paths: [], next: null })
  })
})

describe('the fake luoshu against the luoshu plugin', () => {
  let base: string
  afterEach(async () => {
    if (base !== undefined) await rm(base, { recursive: true, force: true })
  })

  // The same files on disk and in memory, a page of two names in both. Every name allowed is how the gate off by the
  // human lets a listing through, so the dot names are left out by each luoshu itself
  it('answers each listing as the luoshu plugin does', async () => {
    const names = [
      'a.md', 'B.md', 'ﬁ.md', '\u{1f600}.md', 'journal/b.md', 'journal/c.md', 'journal/deep/d.md', 'journalx/e.md',
      ...Array.from({ length: 5 }, (_, i) => `journal/hidden-${i}.md`), 'journal/p1.md', 'journal/p2.md',
      '.hidden.md', '.obsidian/app.json', 'journal/.todo.md', 'journal/deep/.config/x.md',
    ]
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-fake-list-')))
    const folder = path.join(base, 'notes')
    await mkdir(path.join(base, 'data'))
    await mkdir(path.join(base, 'install'))
    for (const name of names) {
      await mkdir(path.dirname(path.join(folder, name)), { recursive: true })
      await writeFile(path.join(folder, name), name)
    }
    const real = createLuoshu({ pageSize: 2 })
    real.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
    const memory = new MemoryLuoshu(async () => {}, 0, 2)
    for (const name of names) memory.notes.set(name, name)

    let n = 0
    async function ask(provider: Provider, args: object, canList: ((at: string) => boolean) | null): Promise<unknown> {
      const call: Call = {
        callId: `l${++n}`, caller: { kind: 'window', role: 'editor', n: 0 }, root: { kind: 'window', role: 'editor', n: 0 }, action: 'luoshu.list', args, deadline: Date.now() + 30000,
        ...(canList === null ? {} : { canList }),
      }
      const prepared = await provider.prepare(call)
      if (!('scope' in prepared)) return { refused: prepared }
      try {
        return await provider.perform(call, prepared)
      } catch (err) {
        return { refused: err }
      }
    }
    // Every page of a listing, following next
    async function pages(provider: Provider, args: { folder?: string }, canList: (at: string) => boolean): Promise<unknown[]> {
      const answers: unknown[] = []
      let after: string | undefined
      do {
        const answer = await ask(provider, { ...args, ...(after === undefined ? {} : { after }) }, canList)
        answers.push(answer)
        after = (answer as { next?: string | null }).next ?? undefined
      } while (after !== undefined && answers.length < 20)
      return answers
    }

    const all = () => true
    const shown = (at: string) => !at.includes('hidden-')
    for (const [args, canList] of [[{}, all], [{}, shown], [{ folder: 'journal' }, shown], [{ folder: 'journal/deep' }, all]] as const) {
      const expected = await pages(real.provider, args, canList)
      expect(await pages(memory, args, canList), JSON.stringify(args)).toEqual(expected)
    }
    expect((await pages(real.provider, {}, all)).flatMap(page => (page as { paths: string[] }).paths)).toEqual([
      'B.md', 'a.md', 'journal/b.md', 'journal/c.md', 'journal/deep/d.md',
      ...Array.from({ length: 5 }, (_, i) => `journal/hidden-${i}.md`), 'journal/p1.md', 'journal/p2.md', 'journalx/e.md', '\u{1f600}.md', 'ﬁ.md',
    ])
    for (const [args, canList] of [
      [{ after: 'journal/c.md' }, all], [{ folder: 'missing' }, all], [{ folder: 'a.md' }, all], [{ folder: 'journal' }, () => false],
      [{ folder: '.obsidian' }, all], [{ folder: 'journal/deep/.config' }, all], [{}, null],
    ] as const) {
      expect(await ask(memory, args, canList), JSON.stringify(args)).toEqual(await ask(real.provider, args, canList))
    }
  })
})

describe('a luoshu that fails for a while', () => {
  it('refuses the next luoshu call with the code a test names, then answers again', async () => {
    const fake = core()
    const { plugin, box } = reader()
    await fake.start(plugin)
    fake.luoshu.refuseNext('unavailable')
    await expect(box.ctx!.luoshu.read({ path: 'notes/a.md' })).rejects.toMatchObject({ code: 'unavailable' })
    expect(await box.ctx!.luoshu.read({ path: 'notes/a.md' })).toMatchObject({ text: 'a' })
  })
})

describe('a core that takes time and holds the limits lower', () => {
  it('answers the luoshu, storage and cache after latencyMs', async () => {
    const fake = core(undefined, {}, { latencyMs: 60 })
    const { plugin, box } = reader()
    await fake.start(plugin)
    for (const call of [() => box.ctx!.luoshu.read({ path: 'notes/a.md' }), () => box.ctx!.storage.set({ key: 'k', value: 1 }), () => box.ctx!.cache.get({ key: 'k' })]) {
      const started = performance.now()
      await call()
      expect(performance.now() - started).toBeGreaterThanOrEqual(55)
    }
  })

  it('tells the most luoshu calls in flight at once since a test last asked', async () => {
    const fake = core(undefined, {}, { latencyMs: 30 })
    const { plugin, box } = reader()
    await fake.start(plugin)
    await Promise.all(Array.from({ length: 5 }, () => box.ctx!.luoshu.read({ path: 'notes/a.md' })))
    expect(fake.luoshu.busiest()).toBe(5)
    await box.ctx!.luoshu.read({ path: 'notes/a.md' })
    expect(fake.luoshu.busiest()).toBe(1)
    expect(fake.luoshu.busiest()).toBe(0)
  })

  it('holds the plugin to the human\'s limits for all, read each time', async () => {
    const fake = core(undefined, {}, { latencyMs: 30, limits: { callsInFlight: 2 } })
    const { plugin, box } = reader()
    await fake.start(plugin)
    // Past two in flight the router answers throttled, which the SDK tries again within the deadline
    const reads = () => Promise.all(Array.from({ length: 4 }, () => box.ctx!.luoshu.read({ path: 'notes/a.md' })))
    expect(await reads()).toHaveLength(4)
    expect(fake.luoshu.busiest()).toBe(2)
    fake.limits.callsInFlight = 3
    expect(await reads()).toHaveLength(4)
    expect(fake.luoshu.busiest()).toBe(3)
  })
})

describe('the fake core\'s storage', () => {
  const caller = { kind: 'plugin', id: 'reader', half: 'worker', incarnation: 1 } as const
  let n = 0
  async function ask(store: MemoryStorage, action: string, args: object, from: Call['caller'] = caller): Promise<unknown> {
    const call: Call = { callId: `m${++n}`, caller: from, root: from, action, args, deadline: Date.now() + 30000 }
    const prepared = await store.prepare(call)
    if (!('scope' in prepared)) return { refused: prepared }
    try {
      return await store.perform(call)
    } catch (err) {
      return { refused: err }
    }
  }

  it('refuses undefined as the storage plugin does, since JSON can\'t hold it', async () => {
    const store = new MemoryStorage()
    expect(await ask(store, 'storage.set', { key: 'k', value: undefined })).toEqual({ refused: { code: 'invalid' } })
    expect(await ask(store, 'cache.set', { key: 'k' })).toEqual({ refused: { code: 'invalid' } })
  })

  it('holds each space to core/api\'s quotas, counted as the storage plugin counts its files', async () => {
    const store = new MemoryStorage()
    for (let i = 0; i < quotas.storage.keys; i++) expect(await ask(store, 'storage.set', { key: `k${i}`, value: 1 })).toBeNull()
    expect(await ask(store, 'storage.set', { key: 'more', value: 1 })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(store, 'storage.set', { key: 'k0', value: 2 })).toBeNull()
    expect(await ask(store, 'storage.set', { key: 'more', value: 1 }, { kind: 'window', role: 'editor', n: 0 })).toBeNull()
    // A value as large as the cache's bytes, with its line around it, is past them
    const big = 'x'.repeat(quotas.cache.bytes - '{"space":"reader","key":"big","value":""}\n'.length)
    expect(await ask(store, 'cache.set', { key: 'big', value: big })).toBeNull()
    expect(await ask(store, 'cache.set', { key: 'big', value: `${big}x` })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(store, 'cache.get', { key: 'big' })).toBe(big)
  })

  it('refuses a content caller, which has no space', async () => {
    const content = { kind: 'content', plugin: 'reader', token: 'a'.repeat(32) } as const
    expect(await ask(new MemoryStorage(), 'storage.get', { key: 'k' }, content)).toEqual({ refused: { code: 'not-granted' } })
  })
})

describe('the fake core\'s gate', () => {
  it('matches a list grant\'s paths, as the gate plugin does', async () => {
    const { holds } = await import('../sdk/testing/gate.ts')
    const granted: Capability[] = [{ type: 'luoshu.list', paths: ['notes/**'] }]
    expect(holds(granted, { capability: 'luoshu.list', scope: { paths: ['notes/a.md'] } })).toBe(true)
    expect(holds(granted, { capability: 'luoshu.list', scope: { paths: ['secret/b.md'] } })).toBe(false)
  })
})

describe('the fake drawer', () => {
  const drawn = (over: object = {}) => manifest({
    capabilities: [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'ui.edit', paths: ['notes/**'] }, { type: 'ui.view' }, { type: 'ui.layout' }],
    views: { board: { title: 'Board', kind: 'view' } },
    ...over,
  })

  it('opens the first instance of each declared view and tells the plugin', async () => {
    const drawer = new FakeDrawer()
    const made = fakeCore({ manifest: drawn(), drawer })
    cores.push(made)
    const opened: unknown[] = []
    await made.start(definePlugin({ start(ctx) { ctx.ui.on('view.opened', event => opened.push(event)) } }))
    await until(() => opened.length === 1)
    expect(drawer.instances()).toEqual([{ instance: 'v1', view: 'board' }])
    expect(opened[0]).toMatchObject({ topic: 'view.opened', instance: 'v1', view: 'board' })
  })

  it('draws through ctx.ui and refuses a skeleton without ui.layout', async () => {
    const drawer = new FakeDrawer()
    const made = fakeCore({ manifest: drawn(), drawer })
    cores.push(made)
    let given: PluginContext | null = null
    await made.start(definePlugin({ start(ctx) { given = ctx } }))
    const ctx = given as unknown as PluginContext
    await ctx.ui.views.draw('v1', { kind: 'text', id: 'a', text: 'cards' })
    await ctx.ui.layout.draw({ kind: 'box', id: 'root', children: [{ kind: 'slot', id: 's', instance: 'v1' }] })
    expect(drawer.tree('v1')).toEqual({ kind: 'text', id: 'a', text: 'cards' })
    expect(drawer.tree('layout')).toMatchObject({ kind: 'box', id: 'root' })

    const plain = new FakeDrawer()
    const other = fakeCore({ manifest: drawn({ id: 'other', capabilities: [{ type: 'ui.view' }] }), drawer: plain })
    cores.push(other)
    let second: PluginContext | null = null
    await other.start(definePlugin({ start(ctx2) { second = ctx2 } }))
    await expect((second as unknown as PluginContext).ui.layout.draw({ kind: 'box', id: 'root' })).rejects.toMatchObject({ code: 'not-granted' })
  })

  it('serves editor.read and editor.edit on a note it holds, at its version, and editor.open inside the read scope', async () => {
    const drawer = new FakeDrawer()
    const made = fakeCore({ manifest: drawn(), drawer })
    cores.push(made)
    let given: PluginContext | null = null
    await made.start(definePlugin({ start(ctx) { given = ctx } }))
    const ctx = given as unknown as PluginContext
    const instance = drawer.openNote('notes/a.md', 'hello')
    expect(await ctx.editor.instances()).toEqual([{ instance, path: 'notes/a.md', version: 0 }])
    expect(await ctx.editor.read(instance)).toMatchObject({ text: 'hello', version: 0 })
    expect(await ctx.editor.edit(instance, 0, [5, [0, ' world']])).toEqual({ version: 1 })
    expect(drawer.text(instance)).toBe('hello world')
    await expect(ctx.editor.edit(instance, 0, [5, [0, '!']])).rejects.toMatchObject({ code: 'stale' })
    await ctx.editor.open('notes/b.md')
    await expect(ctx.editor.open('secret/b.md')).rejects.toMatchObject({ code: 'not-granted' })
    expect(drawer.opened).toEqual(['notes/b.md'])
  })

  // As hetu's drawer does: luoshu.write reaches the disk and never the editor, and ui.edit reaches only the notes it names
  it.each([
    ['luoshu.write on every note', [{ type: 'luoshu.read', paths: ['**'] }, { type: 'luoshu.write', paths: ['**'] }]],
    ['ui.edit on another folder', [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.edit', paths: ['other/**'] }]],
  ])('refuses editor.edit with %s', async (_name, capabilities) => {
    const drawer = new FakeDrawer()
    const made = fakeCore({ manifest: drawn({ capabilities }), drawer })
    cores.push(made)
    let given: PluginContext | null = null
    await made.start(definePlugin({ start(ctx) { given = ctx } }))
    const instance = drawer.openNote('notes/a.md', 'hello')
    await expect((given as unknown as PluginContext).editor.edit(instance, 0, [5, [0, '!']])).rejects.toMatchObject({ code: 'not-granted' })
    expect(drawer.text(instance)).toBe('hello')
  })

  // A note the test opens is the human's. editor.open needs a real read, as hetu's drawer does
  it('serves editor.read on ui.read for a note the test opened, and editor.open on luoshu.read alone', async () => {
    const drawer = new FakeDrawer()
    const capabilities = [{ type: 'ui.read', paths: ['**'] }, { type: 'luoshu.list', paths: ['**'] }, { type: 'ui.view' }]
    const made = fakeCore({ manifest: drawn({ capabilities }), drawer })
    cores.push(made)
    let given: PluginContext | null = null
    await made.start(definePlugin({ start(ctx) { given = ctx } }))
    const ctx = given as unknown as PluginContext
    const instance = drawer.openNote('secret/a.md', 'hello')
    expect(await ctx.editor.read(instance)).toMatchObject({ text: 'hello' })
    await expect(ctx.editor.open('secret/b.md')).rejects.toMatchObject({ code: 'not-granted' })
    expect(drawer.opened).toEqual([])
  })

  it('hands events from the test to the plugin\'s handlers', async () => {
    const drawer = new FakeDrawer()
    const made = fakeCore({ manifest: drawn(), drawer })
    cores.push(made)
    const heard: unknown[] = []
    await made.start(definePlugin({ start(ctx) { ctx.ui.on('layout.drop', event => heard.push(event)) } }))
    drawer.emit({ topic: 'layout.drop', instance: 'v1', zone: 'left', x: 0, y: 0.5 })
    await until(() => heard.length === 1)
    expect(heard[0]).toMatchObject({ topic: 'layout.drop', zone: 'left' })
  })
})

// Where the human is, as hetu's drawer tells it: a range only after the plugin asked with editor.viewports and only of a
// note it reads, the range drawn then at the ask and at an open, none after a stop. A bound command comes with the note,
// its version and the selection at the key
describe("the fake drawer's ranges and commands", () => {
  type Heard = Record<string, unknown>
  const capabilities = [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'ui.edit', paths: ['notes/**'] }, { type: 'ui.command' }, { type: 'ui.decoration' }]
  const range = (instance: string, version: number, from: number, to: number) => ({ v: 1, kind: 'event', topic: 'editor.viewport', instance, version, from, to })
  const opened = (instance: string) => ({ v: 1, kind: 'event', topic: 'editor.opened', instance })
  const ranges = (heard: Heard[]) => heard.filter(event => event.topic === 'editor.viewport')

  // A plugin that keeps each editor event it hears
  async function listening(drawer: FakeDrawer) {
    const made = fakeCore({ manifest: manifest({ capabilities }), drawer })
    cores.push(made)
    const heard: Heard[] = []
    let given: PluginContext | null = null
    await made.start(definePlugin({
      start(ctx) {
        given = ctx
        for (const topic of ['opened', 'viewport', 'command', 'changed', 'closed'] as const) ctx.editor.on(topic, event => heard.push({ ...event }))
      },
    }))
    return { heard, ctx: given as unknown as PluginContext }
  }

  it('sends no range to a plugin that never asked, as a note opens and its view moves', async () => {
    const drawer = new FakeDrawer()
    const { heard } = await listening(drawer)
    const instance = drawer.openNote('notes/a.md', 'hello world')
    drawer.viewport(instance, 2, 11)
    await tick(5)
    expect(heard).toEqual([opened(instance)])
  })

  it('sends a plugin that asked the range drawn at its ask, each move after with its version and the whole of a short note opened since', async () => {
    const drawer = new FakeDrawer()
    const { heard, ctx } = await listening(drawer)
    const first = drawer.openNote('notes/a.md', 'hello world')
    await ctx.editor.viewports(true)
    await until(() => ranges(heard).length === 1)
    await ctx.editor.edit(first, 0, [11, [0, '!']])
    drawer.viewport(first, 2, 12)
    const second = drawer.openNote('notes/b.md', 'two')
    await until(() => ranges(heard).length === 3)
    expect(heard).toEqual([opened(first), range(first, 0, 0, 11), expect.objectContaining({ topic: 'editor.changed' }), range(first, 1, 2, 12), opened(second), range(second, 0, 0, 3)])
  })

  it("sends the range the editor still draws in the note's version when sent, after an edit past it", async () => {
    const drawer = new FakeDrawer()
    const { heard, ctx } = await listening(drawer)
    const instance = drawer.openNote('notes/a.md', 'hello world', { from: 0, to: 5 })
    await ctx.editor.edit(instance, 0, [11, [0, '!']])
    await ctx.editor.viewports(true)
    await until(() => ranges(heard).length === 1)
    expect(ranges(heard)).toEqual([range(instance, 1, 0, 5)])
  })

  it("sends no range of a note the plugin can't read", async () => {
    const drawer = new FakeDrawer()
    const { heard, ctx } = await listening(drawer)
    const secret = drawer.openNote('secret/a.md', 'hidden')
    await ctx.editor.viewports(true)
    drawer.viewport(secret, 1, 6)
    await tick(5)
    expect(heard).toEqual([])
  })

  it('sends no range after the plugin stopped them and the range drawn then once it asks again', async () => {
    const drawer = new FakeDrawer()
    const { heard, ctx } = await listening(drawer)
    const instance = drawer.openNote('notes/a.md', 'hello world')
    await ctx.editor.viewports(true)
    await ctx.editor.viewports(false)
    drawer.viewport(instance, 2, 11)
    drawer.viewport(instance, 3, 11)
    await tick(5)
    expect(ranges(heard)).toEqual([range(instance, 0, 0, 11)])
    await ctx.editor.viewports(true)
    await until(() => ranges(heard).length === 2)
    expect(ranges(heard)).toEqual([range(instance, 0, 0, 11), range(instance, 0, 3, 11)])
  })

  it("tells a plugin that reads the note each change the human makes, as CodeMirror's change list at the note's new version, unless the change is lost", async () => {
    const drawer = new FakeDrawer()
    const { heard, ctx } = await listening(drawer)
    const instance = drawer.openNote('notes/a.md', 'hello')
    const secret = drawer.openNote('secret/a.md', 'hidden')
    drawer.type(instance, { from: 5, insert: '!' })
    drawer.type(instance, { from: 0, to: 1, insert: 'H' }, false)
    drawer.type(instance, [{ from: 0, insert: '>' }, { from: 6, insert: '?' }])
    drawer.type(secret, { from: 0, insert: 'x' })
    await until(() => heard.filter(event => event.topic === 'editor.changed').length === 2)
    await tick(5)
    expect(heard.filter(event => event.topic === 'editor.changed')).toEqual([
      { v: 1, kind: 'event', topic: 'editor.changed', instance, version: 1, changes: [5, [0, '!']] },
      { v: 1, kind: 'event', topic: 'editor.changed', instance, version: 3, changes: [[0, '>'], 6, [0, '?']] },
    ])
    expect(drawer.text(instance)).toBe('>Hello!?')
    expect(await ctx.editor.read(instance)).toEqual({ text: '>Hello!?', version: 3, selection: [{ anchor: 0, head: 0 }] })
  })

  it('holds the answers to a verb until let go, refuses the next call of one with the code given, keeps the version marks came for and tells a closed note only to a plugin that marked it', async () => {
    const drawer = new FakeDrawer()
    const { heard, ctx } = await listening(drawer)
    const first = drawer.openNote('notes/a.md', 'hello')
    const second = drawer.openNote('notes/b.md', 'two')
    const release = drawer.delay('editor.read')
    let read: unknown = null
    void ctx.editor.read(first).then(got => (read = got))
    drawer.type(first, { from: 5, insert: '!' })
    await tick(5)
    expect(read).toBeNull()
    release()
    await until(() => read !== null)
    expect(read).toEqual({ text: 'hello', version: 0, selection: [{ anchor: 0, head: 0 }] })
    drawer.refuseNext('editor.read', 'unavailable')
    await expect(ctx.editor.read(first)).rejects.toMatchObject({ code: 'unavailable' })
    expect((await ctx.editor.read(first)).text).toBe('hello!')
    expect(drawer.calls.filter(verb => verb === 'editor.read')).toHaveLength(3)
    drawer.closeNote(second)
    await ctx.editor.decorate(first, 0, 'set', [])
    expect(drawer.versions.get(`${first} set`)).toBe(0)
    drawer.closeNote(first)
    await until(() => heard.some(event => event.topic === 'editor.closed'))
    expect(heard.filter(event => event.topic === 'editor.closed')).toEqual([{ v: 1, kind: 'event', topic: 'editor.closed', instance: first }])
    expect(drawer.text(first)).toBeNull()
  })

  it('sends each range once to a plugin that asked twice', async () => {
    const drawer = new FakeDrawer()
    const { heard, ctx } = await listening(drawer)
    const instance = drawer.openNote('notes/a.md', 'hello world')
    await ctx.editor.viewports(true)
    await ctx.editor.viewports(true)
    drawer.viewport(instance, 2, 11)
    await until(() => ranges(heard).length === 2)
    await tick(5)
    expect(ranges(heard)).toEqual([range(instance, 0, 0, 11), range(instance, 0, 2, 11)])
  })

  it('fires a bound command with the note, its version and the selection only for a note the plugin reads and never one left unbound', async () => {
    const drawer = new FakeDrawer()
    const { heard, ctx } = await listening(drawer)
    const instance = drawer.openNote('notes/a.md', 'hello')
    const secret = drawer.openNote('secret/a.md', 'hidden')
    expect(drawer.command('kill', instance)).toBe(false)
    await ctx.editor.bind([{ key: 'Mod-k', command: 'kill' }])
    await ctx.editor.edit(instance, 0, [5, [0, '!']])
    expect(drawer.command('kill', instance, [{ anchor: 1, head: 4 }])).toBe(true)
    expect(drawer.command('kill', secret)).toBe(true)
    expect(drawer.command('kill')).toBe(true)
    await until(() => heard.filter(event => event.topic === 'editor.command').length === 3)
    expect(heard.filter(event => event.topic === 'editor.command')).toEqual([
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance, version: 1, selection: [{ anchor: 1, head: 4 }] },
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: null },
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: null },
    ])
  })

  it('starts each run of the plugin with no ask and no binding, as each new port in hetu', async () => {
    const drawer = new FakeDrawer()
    const made = fakeCore({ manifest: manifest({ capabilities }), drawer })
    cores.push(made)
    const runs: Heard[][] = []
    const plugin = definePlugin({
      async start(ctx) {
        const heard: Heard[] = []
        runs.push(heard)
        ctx.editor.on('viewport', event => heard.push({ ...event }))
        if (runs.length > 1) return
        await ctx.editor.viewports(true)
        await ctx.editor.bind([{ key: 'Mod-k', command: 'kill' }])
      },
    })
    await made.start(plugin)
    const instance = drawer.openNote('notes/a.md', 'hello world')
    await until(() => runs[0].length === 1)
    await made.stop()
    await made.start(plugin)
    drawer.viewport(instance, 2, 11)
    await tick(5)
    expect(runs).toEqual([[range(instance, 0, 0, 11)], []])
    expect(drawer.command('kill', instance)).toBe(false)
  })

  // The same plugin code against hetu's drawer and against the fake, the human doing the same before each
  it("hands a plugin the same ranges and commands as hetu's drawer, in the same order", async () => {
    type Human = { open(path: string, text: string): string, move(instance: string, from: number, to: number): void, key(instance: string, selection: { anchor: number, head: number }[]): void }
    const play = async (editor: EditorClient, human: Human) => {
      const heard: Heard[] = []
      for (const topic of ['opened', 'viewport', 'command'] as const) editor.on(topic, event => heard.push({ ...event }))
      await editor.bind([{ key: 'Mod-k', command: 'kill' }])
      human.open('notes/early.md', 'before the ask')
      await tick(5)
      await editor.viewports(true)
      const a = human.open('notes/a.md', 'hello world')
      await tick(5)
      human.move(a, 2, 11)
      human.open('secret/b.md', 'hidden')
      await tick(5)
      await editor.viewports(false)
      human.move(a, 3, 11)
      await tick(5)
      await editor.viewports(true)
      await editor.viewports(true)
      await tick(5)
      human.key(a, [{ anchor: 1, head: 4 }])
      await tick(5)
      return heard
    }

    // hetu's drawer, the plugin's client on a port to it
    const notes: Instance[] = []
    const selections = new Map<string, { anchor: number, head: number }[]>()
    const core = editorCore({
      'events.subscribe': () => ({ ok: true, result: { standing: [] } }),
      'gate.reach': args => {
        const { path: asked } = args as { path?: string }
        return { ok: true, result: { read: asked !== undefined && asked.startsWith('notes/'), edit: false, uiRead: false, list: false, verbs: ['ui.command'] } }
      },
    })
    const link = new CoreLink(core.bridge)
    link.start()
    const real = new Drawer(link, () => notes, () => {})
    real.start()
    let toPlugin: ((message: unknown) => void) | null = null
    const port: PortLike = { onmessage: null, close() {}, postMessage: message => toPlugin?.(JSON.parse(message as string)) }
    real.connect('reader', 1, port)
    const client = new Editor()
    client.connect({ post: message => port.onmessage?.({ data: JSON.stringify(message) }), listen: next => { toPlugin = next } })
    const find = (id: string) => notes.find(each => each.id === id) as Instance
    const fromReal = await play(client, {
      open(at, text) {
        const id = `n${notes.length + 1}`
        const made: Instance = {
          id, path: at, versions: new Versions(text.length), text: () => text, selection: () => selections.get(id) ?? [{ anchor: 0, head: 0 }],
          apply() {}, setMarks() {}, clearMarks() {},
        }
        notes.push(made)
        real.opened(made)
        real.viewport(made, 0, text.length)
        return id
      },
      move: (id, from, to) => real.viewport(find(id), from, to),
      key(id, selection) {
        selections.set(id, selection)
        real.key(id, 'Mod-k')
      },
    })

    const drawer = new FakeDrawer()
    const made = fakeCore({ manifest: manifest({ capabilities }), drawer })
    cores.push(made)
    let given: PluginContext | null = null
    await made.start(definePlugin({ start(ctx) { given = ctx } }))
    const fromFake = await play((given as unknown as PluginContext).editor, {
      open: (at, text) => drawer.openNote(at, text),
      move: (id, from, to) => drawer.viewport(id, from, to),
      key: (id, selection) => void drawer.command('kill', id, selection),
    })

    expect(fromReal).toEqual([
      // The ask after a stop sends the range of every note it reads again
      opened('n1'), range('n1', 0, 0, 14), opened('n2'), range('n2', 0, 0, 11), range('n2', 0, 2, 11), range('n1', 0, 0, 14), range('n2', 0, 3, 11),
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: 'n2', version: 0, selection: [{ anchor: 1, head: 4 }] },
    ])
    expect(fromFake).toEqual(fromReal)
  })
})

describe('the fake core playing another plugin', () => {
  const callerManifest = {
    id: 'caller', name: 'Caller', version: '1.0.0', api: `^${API_VERSION}`, entries: { worker: 'dist/worker.js' },
    capabilities: [{ type: 'plugin.call', targets: ['mcp'] }],
  }
  const started = async (manifest: object, standIns: (made: FakeCore) => void = () => {}) => {
    const made = fakeCore({ manifest })
    cores.push(made)
    standIns(made)
    const box: { ctx: PluginContext | null } = { ctx: null }
    const state = await made.start(definePlugin({ start(ctx) { box.ctx = ctx } }))
    return { made, ctx: box.ctx as unknown as PluginContext, state }
  }

  it('delivers a call to a stand-in\'s handle with the caller and the onBehalf sent, and hands its answer back', async () => {
    let mcp: StandIn | null = null
    const { ctx } = await started(callerManifest, made => {
      mcp = made.standIn('mcp', {
        actions: { handle: { from: ['caller'] } },
        handle: call => ({ args: call.args, caller: call.caller, onBehalf: call.onBehalf ?? null }),
      })
    })
    const answer = await ctx.call('mcp', 'handle', { body: '{"x":1}' }, { onBehalf: 'agent-1' })
    const caller = { kind: 'plugin', id: 'caller', half: 'worker', incarnation: 1 }
    expect(answer).toEqual({ args: { body: '{"x":1}' }, caller, onBehalf: 'agent-1' })
    expect(mcp!.delivered).toEqual([{ action: 'mcp.handle', args: { body: '{"x":1}' }, caller, onBehalf: 'agent-1' }])
  })

  it('passes on a refusal the stand-in throws and refuses a caller its from leaves out, as the real router does', async () => {
    let mcp: StandIn | null = null
    const { ctx } = await started(callerManifest, made => {
      mcp = made.standIn('mcp', {
        actions: { handle: { from: ['caller'] }, admin: { from: ['mcp-http-handler'] } },
        handle: () => { throw { code: 'invalid' } },
      })
    })
    await expect(ctx.call('mcp', 'handle', {})).rejects.toMatchObject({ code: 'invalid' })
    await expect(ctx.call('mcp', 'admin', {})).rejects.toMatchObject({ code: 'not-granted' })
    expect(mcp!.delivered.map(call => call.action)).toEqual(['mcp.handle'])
  })

  it('sends deps when a test sets a stand-in\'s state, so has and the onDeps hooks follow it', async () => {
    const seen: boolean[] = []
    const made = fakeCore({ manifest: callerManifest })
    cores.push(made)
    made.standIn('mcp', { actions: {}, state: 'unavailable' })
    await made.start(definePlugin({ start(ctx) { seen.push(ctx.has('mcp')); ctx.onDeps(() => { seen.push(ctx.has('mcp')) }) } }))
    made.setState('mcp', 'starting')
    await until(() => seen.length === 2)
    made.setState('mcp', 'ready')
    await until(() => seen.length === 3)
    made.setState('mcp', 'unavailable')
    await until(() => seen.length === 4)
    expect(seen).toEqual([false, true, true, false])
  })

  // http runs in a utility process, so the fake core places it there on a port, as the plugins manager does
  it('places http under test in a utility process on a port, where the floor takes its two core actions', async () => {
    const http = { id: 'mcp-http-handler', name: 'HTTP', version: '1.0.0', api: `^${API_VERSION}`, entries: { host: 'dist/host.js' }, node: ['http'] }
    const { made, ctx } = await started(http)
    expect(await ctx.call('core', 'refused', { reason: 'host', count: 4 })).toBeNull()
    await until(() => made.coreRecords.some(record => record.event === 'mcp-http-handler.refused'))
    expect(made.coreRecords.filter(record => record.event === 'mcp-http-handler.refused').map(record => record.fields)).toEqual([{ reason: 'host', count: 4 }])
    // The core ends the half before any answer, as the plugins manager ends the process, so the call never settles
    void ctx.bindFailed('port-taken').catch(() => {})
    await until(() => made.coreCalls.length === 1)
    expect(made.coreCalls).toEqual([{ action: 'core.bindFailed', args: { reason: 'port-taken' }, caller: { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 } }])
    expect(made.status()).toEqual({ state: 'failed', reason: 'port-taken' })
  })

  it('places any other host plugin in main, where the floor refuses both', async () => {
    const net = { id: 'net', name: 'Net', version: '1.0.0', api: `^${API_VERSION}`, entries: { host: 'dist/host.js' } }
    const { made, ctx } = await started(net)
    await expect(ctx.call('core', 'refused', { reason: 'host', count: 4 })).rejects.toMatchObject({ code: 'not-granted' })
    await expect(ctx.bindFailed('port-taken')).rejects.toMatchObject({ code: 'not-granted' })
    expect(made.coreCalls).toEqual([])
    expect(made.status()).toEqual({ state: 'ready', reason: null })
  })
})

describe('the fake core\'s history', () => {
  const commitGrant: Capability = { type: 'history', access: 'commit', paths: ['notes/**'] }
  const readGrant: Capability = { type: 'history', access: 'read', paths: ['notes/**'] }
  async function historian(capabilities: object[]) {
    const fake = core(undefined, { capabilities })
    const { plugin, box } = reader()
    await fake.start(plugin)
    return { fake, ctx: box.ctx! }
  }

  it('commits the notes as the luoshu holds them, lists the commit and reads the text back at it', async () => {
    const { fake, ctx } = await historian([commitGrant, readGrant])
    const first = (await ctx.history.commit({ paths: ['notes/a.md'], message: 'first save' })).commit!
    expect(first).toMatch(/^[0-9a-f]{40}$/)
    await fake.luoshu.write('notes/a.md', 'a, edited')
    const second = (await ctx.history.commit({ paths: ['notes/a.md'], message: 'second save\n' })).commit!
    const date = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
    expect(await ctx.history.log({ path: 'notes/a.md' })).toEqual({
      commits: [
        { commit: second, author: 'reader', committer: 'reader', date, message: 'second save' },
        { commit: first, author: 'reader', committer: 'reader', date, message: 'first save' },
      ],
    })
    expect(await ctx.history.log({ path: 'notes/a.md', limit: 1 })).toMatchObject({ commits: [{ commit: second }] })
    expect(await ctx.history.read({ path: 'notes/a.md', commit: first })).toEqual({ text: 'a', version: createHash('sha256').update('a').digest('hex') })
    expect(await ctx.history.read({ path: 'notes/a.md', commit: second })).toMatchObject({ text: 'a, edited' })
  })

  it('answers a commit that changes nothing with null and writes nothing', async () => {
    const { ctx } = await historian([commitGrant, readGrant])
    const { commit } = await ctx.history.commit({ paths: ['notes/a.md'], message: 'save' })
    expect(await ctx.history.commit({ paths: ['notes/a.md'], message: 'again' })).toEqual({ commit: null })
    expect(await ctx.history.commit({ paths: ['notes/none.md'], message: 'nothing there' })).toEqual({ commit: null })
    expect((await ctx.history.log({ path: 'notes/a.md' })).commits.map(entry => entry.commit)).toEqual([commit])
  })

  // Commits notes/a.md under each call to save, so a test caller's onBehalf makes it a call for a pair
  async function saver(capabilities: object[]) {
    const fake = core(undefined, { capabilities, provides: { actions: { save: {} } } })
    const box: { ctx: PluginContext | null } = { ctx: null }
    await fake.start(definePlugin({
      start: ctx => {
        box.ctx = ctx
        ctx.provide('save', async call => (await call.ctx.history.commit({ paths: ['notes/a.md'], message: 'for a client' })).commit)
      },
    }))
    return { fake, ctx: box.ctx! }
  }

  // The plugin's own call carries no pair, so its own grant holds it. A call under a test caller's call for a client
  // needs the pair's commit grant too and names that caller as the committer
  it('names the caller as the committer and the onBehalf it set as the author', async () => {
    const { fake, ctx } = await saver([commitGrant, readGrant])
    await ctx.history.commit({ paths: ['notes/a.md'], message: 'for an agent' }, { onBehalf: 'agent <x@example.com>' })
    await fake.luoshu.write('notes/a.md', 'a, edited')
    expect(await fake.call('reader.save', {}, { onBehalf: 'client-1', pairGrants: [commitGrant] })).toMatchObject({ ok: true })
    expect((await ctx.history.log({ path: 'notes/a.md' })).commits.map(entry => [entry.author, entry.committer])).toEqual([
      ['client-1', 'tester'],
      ['agent x@example.com', 'reader'],
    ])
  })

  it('refuses a commit under a call for a pair that holds no commit grant and writes nothing', async () => {
    const { fake, ctx } = await saver([commitGrant, readGrant])
    expect(await fake.call('reader.save', {}, { onBehalf: 'client-1' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await fake.call('reader.save', {}, { onBehalf: 'client-1', pairGrants: [readGrant] })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await ctx.history.log({ path: 'notes/a.md' })).toEqual({ commits: [] })
  })

  it('commits under a call for a pair once the test names the pair\'s commit grant', async () => {
    const { fake } = await saver([commitGrant, readGrant])
    const reply = await fake.call('reader.save', {}, { onBehalf: 'client-1#1', pairGrants: [commitGrant] })
    expect(reply).toEqual({ ok: true, result: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(await fake.call('reader.save', {}, { onBehalf: 'client-2' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it('refuses a commit of a path outside the commit grant and writes nothing', async () => {
    const { ctx } = await historian([commitGrant, { ...readGrant, paths: ['**'] }])
    await expect(ctx.history.commit({ paths: ['notes/a.md', 'secret/b.md'], message: 'both' })).rejects.toMatchObject({ code: 'not-granted' })
    expect(await ctx.history.log({ path: 'notes/a.md' })).toEqual({ commits: [] })
  })

  it('answers not-found for a commit it never made', async () => {
    const { ctx } = await historian([commitGrant, readGrant])
    await expect(ctx.history.read({ path: 'notes/a.md', commit: 'f'.repeat(40) })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses a commit to a plugin that holds only the read grant', async () => {
    const { ctx } = await historian([readGrant])
    await expect(ctx.history.commit({ paths: ['notes/a.md'], message: 'save' })).rejects.toMatchObject({ code: 'not-granted' })
  })

  it('refuses a log and a read to a plugin that holds only the commit grant', async () => {
    const { ctx } = await historian([commitGrant])
    const commit = (await ctx.history.commit({ paths: ['notes/a.md'], message: 'save' })).commit!
    await expect(ctx.history.log({ path: 'notes/a.md' })).rejects.toMatchObject({ code: 'not-granted' })
    await expect(ctx.history.read({ path: 'notes/a.md', commit })).rejects.toMatchObject({ code: 'not-granted' })
  })
})

describe('the fake history against the history module', () => {
  afterEach(historyCleanup)

  // The same calls on both. Ids are named by the order they first came in and each date is checked and then set aside,
  // so the answers equal field for field
  it('answers each call as the history module does', async () => {
    const where = await historyPlace()
    const real = (await historyStarted(where)).provider
    const memory = new MemoryHistory(new Map())
    const write = async (name: string, text: string) => {
      memory.notes.set(name, text)
      await mkdir(path.dirname(path.join(where.notes, name)), { recursive: true })
      await writeFile(path.join(where.notes, name), text)
    }
    // Each provider's own commits in the order it made them, for the reads that name one
    const made = new Map<Provider, string[]>([[real, []], [memory, []]])
    const answers = new Map<Provider, unknown[]>([[real, []], [memory, []]])
    async function both(action: string, args: (ids: string[]) => object, as: HistoryAsking = {}): Promise<void> {
      for (const provider of [real, memory]) {
        const call = historyCall(action, args(made.get(provider)!), as)
        const prepared = await provider.prepare(call)
        const answer = 'scope' in prepared ? await provider.perform(call, prepared).catch((err: unknown) => ({ refused: err })) : { refused: prepared }
        const id = (answer as { commit?: unknown }).commit
        if (typeof id === 'string') made.get(provider)!.push(id)
        answers.get(provider)!.push(answer)
      }
    }
    const agent: Call['caller'] = { kind: 'plugin', id: 'mcp', half: 'worker', incarnation: 1 }
    const handler: Call['caller'] = { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 }
    await both('history.log', () => ({ path: 'a.md' }))
    await both('history.commit', () => ({ paths: ['none.md'], message: 'nothing yet' }))
    await write('a.md', 'note a')
    await write('journal/b.md', 'note b')
    await both('history.commit', () => ({ paths: ['a.md', 'journal/b.md', 'a.md'], message: 'both\n\n' }))
    await write('a.md', 'note a, edited')
    await both('history.commit', () => ({ paths: ['a.md'], message: 'for an agent' }), { onBehalf: 'agent <x@example.com>' })
    await both('history.commit', () => ({ paths: ['a.md'], message: 'again' }))
    memory.notes.delete('journal/b.md')
    await rm(path.join(where.notes, 'journal', 'b.md'))
    await write('journal/c.md', 'note c')
    await both('history.commit', () => ({ paths: ['journal/b.md', 'journal/c.md'], message: 'b gone' }), { caller: agent, root: handler, onBehalf: 'claude-code#1' })
    for (const at of ['a.md', 'journal', 'journal/b.md', 'none.md']) await both('history.log', () => ({ path: at }))
    await both('history.log', () => ({ path: 'a.md', limit: 1 }))
    await both('history.read', ids => ({ path: 'a.md', commit: ids[0] }))
    await both('history.read', ids => ({ path: 'journal/b.md', commit: ids[0] }))
    await both('history.read', ids => ({ path: 'journal/b.md', commit: ids[2] }))
    await both('history.read', ids => ({ path: 'journal', commit: ids[0] }))
    await both('history.read', () => ({ path: 'a.md', commit: 'f'.repeat(40) }))
    const named = (list: unknown[]) => {
      const order: string[] = []
      return JSON.parse(JSON.stringify(list, (key, value: unknown) => {
        if (key === 'date') {
          // git's %aI writes UTC as Z on some builds and +00:00 on others
          expect(value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/)
          return 'date'
        }
        if (key !== 'commit' || typeof value !== 'string') return value
        if (!order.includes(value)) order.push(value)
        return order.indexOf(value)
      })) as unknown[]
    }
    const expected = named(answers.get(real)!)
    expect(named(answers.get(memory)!)).toEqual(expected)
    expect(made.get(real)).toHaveLength(3)
  })
})
