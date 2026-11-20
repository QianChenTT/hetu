import { afterEach, describe, expect, it } from 'vitest'
import type { Call, Prepared, Provider } from '../api/policy-jobs.ts'
import { cleanup, code, harness, tick, worker, type HarnessOptions } from './router-fakes.ts'

afterEach(cleanup)

// An exec that runs until the test lets it go or its call's signal aborts, killed then as exec kills its process
class FakeExec implements Provider {
  readonly signals: AbortSignal[] = []
  private readonly running: (() => void)[] = []

  async prepare(call: Call): Promise<Prepared> {
    return { scope: { command: (call.args as { command: string[] }).command } }
  }

  async perform(call: Call): Promise<unknown> {
    const signal = call.signal as AbortSignal
    this.signals.push(signal)
    await new Promise<void>(resolve => {
      this.running.push(resolve)
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    if (signal.aborted) throw { code: 'stale' }
    return { code: 0, signal: null, stdout: 'built', stderr: '', truncated: false }
  }

  finish(): void {
    for (const done of this.running.splice(0)) done()
  }
}

const build = ['C:/tools/make.exe', 'all']

function made(over: HarnessOptions = {}) {
  const parts = harness(over)
  const exec = new FakeExec()
  parts.providers.exec = exec
  parts.gate.grants.search = [{ type: 'exec', commands: [build], env: [] }, { type: 'luoshu.write', paths: ['notes/**'] }]
  const search = parts.connect(worker('search'))
  // The first grants snapshot the router reads, as the plugins manager tells it at start, is where it starts
  parts.router.changed()
  // A new grants snapshot, as the plugins manager pushes one, then tells the router
  const snapshot = () => {
    parts.pluginsManager.current++
    parts.router.changed()
  }
  return { ...parts, exec, search, snapshot }
}

describe('open calls judged again on a new grants snapshot', () => {
  it('kills an exec run its grant no longer covers as stale, its retry not-granted', async () => {
    const { exec, search, gate, snapshot } = made()
    const id = search.call('exec.run', { command: build })
    await tick(20)
    expect(exec.signals).toHaveLength(1)
    gate.grants.search = []
    snapshot()
    expect(code(await search.reply(id))).toBe('stale')
    expect(exec.signals[0].aborted).toBe(true)
    expect(code(await search.ask('exec.run', { command: build }))).toBe('not-granted')
  })

  it('lets a write in perform finish on the grant it was judged on', async () => {
    const { luoshu, search, gate, snapshot } = made()
    let open!: () => void
    luoshu.hold.perform = new Promise<void>(resolve => { open = resolve })
    const id = search.call('luoshu.write', { path: 'notes/a.md', text: 'x' })
    await tick(20)
    expect(luoshu.performed).toHaveLength(1)
    gate.grants.search = []
    snapshot()
    await tick(10)
    expect(search.repliesTo(id)).toEqual([])
    open()
    const reply = await search.reply(id)
    expect([reply.ok, luoshu.files.get('notes/a.md')]).toEqual([true, 'x'])
    expect(luoshu.performed[0].call.signal?.aborted).toBe(true)
  })

  it('sends a plugin callee cancel and answers its caller stale', async () => {
    const parts = made()
    const { pluginsManager, gate, connect, snapshot } = parts
    pluginsManager.sandboxed('word-count', { count: {} })
    gate.grants.scribe = [{ type: 'plugin.call', targets: ['word-count'] }]
    const scribe = connect(worker('scribe'))
    const counter = connect(worker('word-count'))
    const id = scribe.call('word-count.count', {})
    const got = await counter.delivered('word-count.count')
    gate.grants.scribe = []
    snapshot()
    expect(code(await scribe.reply(id))).toBe('stale')
    await counter.waitFor(message => message.kind === 'cancel' && message.callId === got.callId)
  })

  it('stops nothing when the new grants snapshot widens a grant', async () => {
    const { exec, search, gate, snapshot } = made()
    const id = search.call('exec.run', { command: build })
    await tick(20)
    gate.grants.search = [...gate.grants.search, { type: 'luoshu.read', paths: ['**'] }]
    snapshot()
    await tick(10)
    expect(exec.signals[0].aborted).toBe(false)
    exec.finish()
    expect((await search.reply(id)).ok).toBe(true)
  })

  // A change told before the router could read a grants snapshot leaves the start to the first one it reads
  it('starts from the first grants snapshot it reads, not from a change told while none could be read', async () => {
    const parts = harness()
    const exec = new FakeExec()
    parts.providers.exec = exec
    parts.gate.grants.search = [{ type: 'exec', commands: [build], env: [] }]
    const search = parts.connect(worker('search'))
    parts.pluginsManager.current = Number.NaN
    parts.router.changed()
    parts.pluginsManager.current = 1
    const id = search.call('exec.run', { command: build })
    await tick(20)
    expect(exec.signals).toHaveLength(1)
    parts.gate.grants.search = []
    parts.router.changed()
    await tick(10)
    expect(exec.signals[0].aborted).toBe(false)
    exec.finish()
    expect((await search.reply(id)).ok).toBe(true)
  })

  it('judges nothing again while the grants snapshot stays the same', async () => {
    const { exec, search, gate, router } = made()
    search.call('exec.run', { command: build })
    await tick(20)
    const asked = gate.asked.length
    gate.grants.search = []
    router.changed()
    await tick(10)
    expect([gate.asked.length - asked, exec.signals[0].aborted]).toEqual([0, false])
    exec.finish()
  })

  it('judges a call not yet judged on the newest grants snapshot when it gets there, never as stale', async () => {
    const { luoshu, search, gate, snapshot } = made()
    let open!: () => void
    luoshu.hold.prepare = new Promise<void>(resolve => { open = resolve })
    const id = search.call('luoshu.write', { path: 'notes/a.md', text: 'x' })
    await tick(20)
    gate.grants.search = []
    snapshot()
    open()
    expect(code(await search.reply(id))).toBe('not-granted')
    expect(luoshu.performed).toEqual([])
  })

  // The gate judges a short name as written at precheck and only the name it resolves to at decide, so a call still in
  // prepare when the grants snapshot moves has nothing judged at the canonical stage to judge again
  it('leaves a call in prepare to its own decide on the newest grants snapshot, its own answer intact', async () => {
    const { luoshu, search, gate, snapshot } = made()
    luoshu.short.set('A~1', 'a.md')
    gate.decision = access => access.stage === 'raw' || !access.scope.paths?.some(path => path.includes('~')) ? gate.granted(access) : { allow: false, code: 'not-granted', view: gate.granted(access).view }
    gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**'] }]
    let open!: () => void
    luoshu.hold.prepare = new Promise<void>(resolve => { open = resolve })
    const id = search.call('luoshu.read', { path: 'notes/A~1' })
    await tick(20)
    snapshot()
    open()
    expect(code(await search.reply(id))).toBe('not-found')
  })

  // A gate that throws refuses that one call, so a call it can't judge again stops as one it refused, policy-down
  it('stops a run as policy-down with a fault when the gate throws on judging it again', async () => {
    const { exec, search, gate, snapshot, log, recording } = made()
    const id = search.call('exec.run', { command: build })
    await tick(20)
    gate.decision = () => { throw new Error('gate broke') }
    snapshot()
    expect(code(await search.reply(id))).toBe('policy-down')
    expect(exec.signals[0].aborted).toBe(true)
    await recording.flush()
    expect(log.events('fault').map(record => record.fields)).toContainEqual(expect.objectContaining({ plugin: 'gate', step: 'decide' }))
  })

  // The gate off lets everything pass while the log failing decides nothing of a call
  it('judges no open call again while the human has the gate off, the log failing included', async () => {
    let now = 0
    const { exec, search, gate, snapshot, pluginsManager, log, recording } = made({ clock: () => now })
    pluginsManager.policyJobs.gate = 'off'
    log.failing = true
    await search.ask('storage.get', { key: 'index' })
    const id = search.call('exec.run', { command: build })
    await tick(20)
    expect(exec.signals).toHaveLength(1)
    now = 30_000
    expect(recording.failing()).toBe(true)
    const asked = gate.asked.length
    gate.grants.search = []
    snapshot()
    await tick(10)
    expect([gate.asked.length - asked, exec.signals[0].aborted]).toEqual([0, false])
    exec.finish()
    expect((await search.reply(id)).ok).toBe(true)
  })

  it('carries a signal into perform that aborts once the call ends any other way', async () => {
    const { exec, search } = made()
    search.call('exec.run', { command: build })
    await tick(20)
    search.post({ v: 1, kind: 'cancel', id: 1 })
    await tick(10)
    expect(exec.signals[0].aborted).toBe(true)
  })
})

// scribe calls word-count, which makes its own calls under the one it was handed, each covered by its own grant
function under() {
  const parts = made()
  const { pluginsManager, gate, connect } = parts
  pluginsManager.sandboxed('word-count', { count: {} })
  pluginsManager.sandboxed('tagger', { tag: {} })
  gate.grants.scribe = [{ type: 'plugin.call', targets: ['word-count'] }]
  gate.grants['word-count'] = [
    { type: 'exec', commands: [build], env: [] }, { type: 'luoshu.write', paths: ['notes/**'] }, { type: 'plugin.call', targets: ['tagger'] },
  ]
  const scribe = connect(worker('scribe'))
  const counter = connect(worker('word-count'))
  const tagger = connect(worker('tagger'))
  return { ...parts, scribe, counter, tagger }
}

describe('the calls under a call a new grants snapshot no longer covers', () => {
  it('answers the call stale and lets a write under it finish and answer its result', async () => {
    const { luoshu, scribe, counter, gate, snapshot } = under()
    const id = scribe.call('word-count.count', {})
    const got = await counter.delivered('word-count.count')
    let open!: () => void
    luoshu.hold.perform = new Promise<void>(resolve => { open = resolve })
    const write = counter.call('luoshu.write', { path: 'notes/a.md', text: 'x' }, { parent: got.callId })
    await tick(20)
    expect(luoshu.performed).toHaveLength(1)
    gate.grants.scribe = []
    snapshot()
    expect(code(await scribe.reply(id))).toBe('stale')
    await tick(10)
    expect(counter.repliesTo(write)).toEqual([])
    open()
    const reply = await counter.reply(write)
    expect([reply.ok, luoshu.files.get('notes/a.md')]).toEqual([true, 'x'])
    expect(luoshu.performed[0].call.signal?.aborted).toBe(true)
  })

  it('kills an exec run under it, the run answering stale', async () => {
    const { exec, scribe, counter, gate, snapshot } = under()
    const id = scribe.call('word-count.count', {})
    const got = await counter.delivered('word-count.count')
    const run = counter.call('exec.run', { command: build }, { parent: got.callId })
    await tick(20)
    expect(exec.signals).toHaveLength(1)
    gate.grants.scribe = []
    snapshot()
    expect(code(await scribe.reply(id))).toBe('stale')
    expect(code(await counter.reply(run))).toBe('stale')
    expect(exec.signals[0].aborted).toBe(true)
  })

  it('cancels a plugin callee under it and answers that call stale at once', async () => {
    const { scribe, counter, tagger, gate, snapshot } = under()
    const id = scribe.call('word-count.count', {})
    const got = await counter.delivered('word-count.count')
    const tag = counter.call('tagger.tag', {}, { parent: got.callId })
    const delivered = await tagger.delivered('tagger.tag')
    gate.grants.scribe = []
    snapshot()
    expect(code(await scribe.reply(id))).toBe('stale')
    expect(code(await counter.reply(tag))).toBe('stale')
    await tagger.waitFor(message => message.kind === 'cancel' && message.callId === delivered.callId)
  })

  it('answers a call under it still in prepare stale, with nothing performed', async () => {
    const { luoshu, scribe, counter, gate, snapshot } = under()
    const id = scribe.call('word-count.count', {})
    const got = await counter.delivered('word-count.count')
    let open!: () => void
    luoshu.hold.prepare = new Promise<void>(resolve => { open = resolve })
    const write = counter.call('luoshu.write', { path: 'notes/a.md', text: 'x' }, { parent: got.callId })
    await tick(20)
    gate.grants.scribe = []
    snapshot()
    expect(code(await scribe.reply(id))).toBe('stale')
    expect(code(await counter.reply(write))).toBe('stale')
    open()
    await tick(20)
    expect([luoshu.performed, luoshu.files.has('notes/a.md')]).toEqual([[], false])
  })
})
