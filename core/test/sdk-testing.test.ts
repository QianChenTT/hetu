import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type PluginContext } from '../sdk/plugin.ts'
import { type FakeCore, fakeCore, type FakeMode } from '../sdk/testing/index.ts'
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
  api: '^1',
  entries: { worker: 'dist/worker.js' },
  provides: { actions: { read: {}, list: {} } },
  capabilities: [{ type: 'vault.read', paths: ['notes/**'] }],
  ...over,
})

function core(mode?: FakeMode, over: object = {}, extra: { readyMs?: number } = {}): FakeCore {
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
      ctx.provide('read', async (call, args) => (await call.ctx.vault.read({ path: (args as { path: string }).path })).text)
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
    expect(await one.box.ctx!.vault.read({ path: 'secret/b.md' })).toMatchObject({ text: 'b' })
    const shut = core('deny-all')
    const two = reader()
    await shut.start(two.plugin)
    await expect(two.box.ctx!.vault.read({ path: 'notes/a.md' })).rejects.toMatchObject({ code: 'not-granted' })
    expect(await two.box.ctx!.storage.set({ key: 'k', value: 1 })).toBe(null)
    expect(shut.stored('storage', 'k')).toBe(1)
  })

  it('answers policy-down for every call with power while the gate failed, storage still served', async () => {
    const fake = core('gate-failed')
    const { plugin, box } = reader()
    expect(await fake.start(plugin)).toEqual({ state: 'ready' })
    await expect(box.ctx!.vault.read({ path: 'notes/a.md' })).rejects.toMatchObject({ code: 'policy-down' })
    expect(await box.ctx!.cache.set({ key: 'k', value: 'v' })).toBe(null)
    expect(fake.stored('cache', 'k')).toBe('v')
    expect(await fake.call('reader.read', { path: 'notes/a.md' })).toMatchObject({ ok: false, refusal: { code: 'policy-down' } })
  })

  it('holds a plugin waiting while a requirement is missing and starts it with lastStop once restored', async () => {
    const fake = core('dependency-missing', { requires: ['vault'] })
    const { plugin, box } = reader()
    expect(await fake.start(plugin)).toEqual({ state: 'waiting', reason: 'dependency:vault:absent' })
    expect(box.started).toBe(false)
    expect(await fake.restore()).toEqual({ state: 'ready' })
    expect(box.ctx!.lastStop).toBe('dependency:vault:absent')
    expect(await fake.call('reader.read', { path: 'notes/a.md' })).toEqual({ ok: true, result: 'a' })
  })

  it('refuses a manifest outside the schema', () => {
    expect(() => fakeCore({ manifest: manifest({ capabilities: [{ type: 'vault.teleport' }] }) })).toThrow()
  })

  it('publishes vault.changed for a note the test writes, vault.outside for one written outside', async () => {
    const fake = core(undefined, {
      capabilities: [{ type: 'vault.read', paths: ['**'] }, { type: 'events.subscribe', topics: ['vault.changed', 'vault.outside'] }],
    })
    const heard: string[] = []
    await fake.start(definePlugin({
      start: async ctx => {
        await ctx.events.on(['vault.changed', 'vault.outside'], event => { heard.push(`${event.topic} ${event.path}`) })
      },
    }))
    await fake.vault.write('notes/c.md', 'c')
    await fake.vault.write('notes/d.md', 'd', { outside: true })
    await until(() => heard.length === 2)
    expect(heard).toEqual(['vault.changed notes/c.md', 'vault.outside notes/d.md'])
    expect(fake.vault.read('notes/c.md')).toBe('c')
  })

  it('gives a test caller the grants it names', async () => {
    const fake = core(undefined, { capabilities: [{ type: 'vault.read', paths: ['**'] }] })
    await fake.start(reader().plugin)
    const reply = await fake.call('reader.list', {}, {
      grants: [{ type: 'plugin.call', targets: ['reader'] }, { type: 'vault.read', paths: ['public/**'] }],
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

describe('a vault that fails for a while', () => {
  it('refuses the next vault call with the code a test names, then answers again', async () => {
    const fake = core()
    const { plugin, box } = reader()
    await fake.start(plugin)
    fake.vault.refuseNext('unavailable')
    await expect(box.ctx!.vault.read({ path: 'notes/a.md' })).rejects.toMatchObject({ code: 'unavailable' })
    expect(await box.ctx!.vault.read({ path: 'notes/a.md' })).toMatchObject({ text: 'a' })
  })
})
