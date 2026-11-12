import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type PluginContext } from '../sdk/plugin.ts'
import { type FakeCore, fakeCore, type FakeCoreOptions, FakeDrawer, type FakeMode } from '../sdk/testing/index.ts'
import type { Capability } from '../api/capabilities.ts'
import { quotas } from '../api/storage.ts'
import type { Call } from '../api/slots.ts'
import { MemoryStorage } from '../sdk/testing/providers.ts'
import { tick } from './carrier-fakes.ts'

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
  api: '^2',
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

describe('a core that takes time and holds the floor lower', () => {
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
    // Past two in flight the carrier answers throttled, which the SDK tries again within the deadline
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
    const call: Call = { callId: `m${++n}`, caller: from, action, args, deadline: Date.now() + 30000 }
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
