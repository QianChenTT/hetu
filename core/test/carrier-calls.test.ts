import { afterEach, describe, expect, it } from 'vitest'
import { delivery, token, type Caller } from '../api/envelope.ts'
import { MAX_FILTER_PATHS } from '../api/actions.ts'
import { MAX_TIMER_MS } from '../api/floor.ts'
import type { CarrierOptions } from '../backend/carrier/seams.ts'
import { cleanup, code, editor, FakeGuard, harness, host, hostHalf, tick, windowWay, worker, type Side } from './carrier-fakes.ts'

afterEach(cleanup)

// search serves query, git serves log and mcp serves handle for http only
function plugins(over: Partial<CarrierOptions> = {}) {
  const parts = harness(over)
  const { loader, gate, connect } = parts
  loader.sandboxed('search', { query: {} })
  loader.sandboxed('git', { log: {} })
  loader.sandboxed('mcp', { handle: { from: ['http'] } })
  gate.grants.http = [{ type: 'plugin.call', targets: ['mcp'] }]
  gate.grants.mcp = [{ type: 'plugin.call', targets: ['search', 'git'] }, { type: 'vault.read', paths: ['notes/**'] }]
  gate.grants.search = [{ type: 'plugin.call', targets: ['git'] }, { type: 'vault.read', paths: ['notes/**', 'private/**'] }]
  return { ...parts, http: connect(worker('http')), mcp: connect(worker('mcp')), search: connect(worker('search')), git: connect(worker('git')) }
}

// The delivery a callee got for the nth call of an action
const deliveries = (side: Side, action: string) => side.inbox.filter(message => message.kind === 'call' && message.action === action)

describe('plugin.call', () => {
  it('mints a random call id in the token grammar for every call', async () => {
    const { mcp } = plugins()
    const replies = await Promise.all(Array.from({ length: 50 }, () => mcp.ask('core.self')))
    const ids = replies.map(reply => reply.callId)
    expect(ids.every(id => token.safeParse(id).success)).toBe(true)
    expect(new Set(ids).size).toBe(50)
  })

  it('hands the callee the caller and onBehalf with the call id the caller\'s reply carries', async () => {
    const { http, mcp } = plugins()
    const started = Date.now()
    const id = http.call('mcp.handle', { tool: 'read' }, { onBehalf: 'https://client.example/agent-a' })
    const got = await mcp.delivered('mcp.handle')
    expect(delivery.safeParse(got).success).toBe(true)
    expect(got).toMatchObject({ caller: worker('http'), onBehalf: 'https://client.example/agent-a', args: { tool: 'read' } })
    expect(got.deadline).toBeGreaterThanOrEqual(started + 30000)
    expect(got.deadline).toBeLessThan(started + 31000)
    mcp.answer(got.callId, { ok: 1 })
    const reply = await http.reply(id)
    expect(reply).toMatchObject({ ok: true, result: { ok: 1 }, callId: got.callId })
  })

  it('lets only the callers a declared from names reach the action, the plugin\'s own halves aside', async () => {
    const { http, search, mcp, connect, loader, carrier } = plugins()
    expect(code(await search.ask('mcp.handle'))).toBe('not-granted')
    http.call('mcp.handle')
    await mcp.delivered('mcp.handle')
    const panel = connect({ kind: 'plugin', id: 'mcp', half: 'consent', incarnation: 1 })
    panel.call('mcp.handle')
    await tick()
    expect(deliveries(mcp, 'mcp.handle')).toHaveLength(2)
    // A window is never in from, even with the gate off
    loader.slots.gate = 'off'
    const way = windowWay(carrier, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'mcp.handle'))).toBe('not-granted')
  })

  it.each([
    ['starting', 'starting'],
    ['unresponsive', 'timeout'],
    ['stopped', 'unavailable'],
    ['off', 'unavailable'],
    ['waiting', 'unavailable'],
    ['crashed', 'unavailable'],
  ] as const)('answers a call to a %s target %s at once', async (state, expected) => {
    const { mcp, git, loader } = plugins()
    loader.sandboxed('git', { log: {} }, state)
    const started = Date.now()
    expect(code(await mcp.ask('git.log'))).toBe(expected)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(deliveries(git, 'git.log')).toEqual([])
  })

  it('answers unavailable for a ready target whose serving half has no way in', async () => {
    const { mcp, loader } = plugins()
    loader.sandboxed('git', { log: {} }, 'ready', 2)
    expect(code(await mcp.ask('git.log'))).toBe('unavailable')
  })

  it('ignores a reply on any port but the one the call was delivered on', async () => {
    const { mcp, search, git } = plugins()
    const id = mcp.call('search.query', { text: 'x' })
    const got = await search.delivered('search.query')
    git.answer(got.callId, ['forged.md'])
    mcp.answer(got.callId, ['mine.md'])
    git.post({ v: 1, kind: 'reply', callId: got.callId, ok: false, refusal: { code: 'not-granted', action: 'search.query' } })
    await tick(20)
    expect(mcp.repliesTo(id)).toEqual([])
    search.answer(got.callId, ['a.md'])
    expect((await mcp.reply(id)).result).toEqual(['a.md'])
  })

  it('ignores a reply from a new incarnation for a call the old one was given', async () => {
    const { mcp, search, connect, loader } = plugins()
    const id = mcp.call('search.query')
    const got = await search.delivered('search.query')
    loader.sandboxed('search', { query: {} }, 'ready', 2)
    const again = connect(worker('search', 2))
    again.answer(got.callId, ['forged.md'])
    await tick(20)
    expect(mcp.repliesTo(id)).toEqual([])
    search.answer(got.callId, ['a.md'])
    expect((await mcp.reply(id)).result).toEqual(['a.md'])
  })

  it('drops a second answer and an answer outside the schema fails the call', async () => {
    const { mcp, search } = plugins()
    const one = mcp.call('search.query')
    const first = await search.delivered('search.query')
    search.answer(first.callId, 1)
    search.answer(first.callId, 2)
    expect((await mcp.reply(one)).result).toBe(1)
    const two = mcp.call('search.query')
    await tick(10)
    const second = deliveries(search, 'search.query')[1]
    search.post({ v: 1, kind: 'reply', callId: second.callId, ok: true, result: 1, extra: true })
    expect(code(await mcp.reply(two))).toBe('failed')
    await tick(10)
    expect(mcp.repliesTo(one)).toHaveLength(1)
  })

  it('hands on a callee\'s refusal code and reason, never a request id it made up', async () => {
    const { mcp, search } = plugins()
    const id = mcp.call('search.query')
    const got = await search.delivered('search.query')
    search.post({
      v: 1, kind: 'reply', callId: got.callId, ok: false,
      refusal: { code: 'needs-confirm', action: 'vault.write', reason: 'declined', request: 'fake-request' },
    })
    expect((await mcp.reply(id)).refusal).toEqual({ code: 'needs-confirm', action: 'search.query', reason: 'declined' })
  })

  it('fails a callee result past its cap with too-large', async () => {
    const { mcp, search, loader } = plugins()
    loader.human.plugins.search = { resultBytes: 64 }
    const id = mcp.call('search.query')
    const got = await search.delivered('search.query')
    search.answer(got.callId, 'x'.repeat(100))
    expect((await mcp.reply(id)).refusal).toEqual({ code: 'failed', action: 'search.query', reason: 'too-large' })
  })

  // A loader whose actions is not an object throws outside every step's own try
  it('answers failed at once for a call that threw in flight', async () => {
    const { connect, loader } = harness()
    loader.slots.gate = 'off'
    loader.plugins.git = { state: 'ready', place: 'sandboxed', incarnation: 1, serves: 'worker', actions: null as never, topics: [] }
    connect(worker('git'))
    const started = Date.now()
    expect(code(await connect(worker('search')).ask('git.log'))).toBe('failed')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('parent', () => {
  it('takes a parent only for a live call delivered on the same port', async () => {
    const { http, mcp, git, search } = plugins()
    const id = http.call('mcp.handle')
    const got = await mcp.delivered('mcp.handle')
    // Foreign: delivered to mcp, named by others
    expect(code(await git.ask('search.query', undefined, { parent: got.callId }))).toBe('invalid')
    expect(code(await http.ask('core.self', undefined, { parent: got.callId }))).toBe('invalid')
    expect(code(await search.ask('git.log', undefined, { parent: got.callId }))).toBe('invalid')
    expect(code(await mcp.ask('core.self', undefined, { parent: 'no-such-call' }))).toBe('invalid')
    expect((await mcp.ask('core.self', undefined, { parent: got.callId })).ok).toBe(true)
    mcp.answer(got.callId, null)
    await http.reply(id)
    // Over once answered
    expect(code(await mcp.ask('core.self', undefined, { parent: got.callId }))).toBe('invalid')
  })

  it('shrinks the deadline along parent', async () => {
    const { http, mcp, git, loader } = plugins()
    loader.human.plugins.http = { callDeadlineMs: 5000 }
    http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    mcp.call('git.log', undefined, { parent: parent.callId })
    const child = await git.delivered('git.log')
    expect(child.deadline).toBe(parent.deadline)
    expect(parent.deadline as number).toBeLessThan(Date.now() + 5001)
  })

  it('stops at a depth of 4', async () => {
    const { connect, loader } = harness()
    loader.slots.gate = 'off'
    const chain = ['p1', 'p2', 'p3', 'p4', 'p5']
    for (const id of chain) loader.sandboxed(id, { go: {} })
    const sides = chain.map(id => connect(worker(id)))
    const root = connect(worker('p0'))
    root.call('p1.go')
    let parent = await sides[0].delivered('p1.go')
    for (let i = 1; i < 4; i++) {
      sides[i - 1].call(`${chain[i]}.go`, undefined, { parent: parent.callId })
      parent = await sides[i].delivered(`${chain[i]}.go`)
    }
    // p4 holds a call at depth 4, so its sub-call would be the fifth
    const reply = await sides[3].ask('p5.go', undefined, { parent: parent.callId })
    expect(code(reply)).toBe('invalid')
    expect(deliveries(sides[4], 'p5.go')).toEqual([])
  })

  it('holds a plugin to its own lower depth', async () => {
    const { connect, loader } = harness()
    loader.slots.gate = 'off'
    loader.sandboxed('p1', { go: {} })
    loader.sandboxed('p2', { go: {} })
    loader.human.plugins.p1 = { parentDepth: 1 }
    const p1 = connect(worker('p1'))
    const p2 = connect(worker('p2'))
    connect(worker('p0')).call('p1.go')
    const parent = await p1.delivered('p1.go')
    expect(code(await p1.ask('p2.go', undefined, { parent: parent.callId }))).toBe('invalid')
    expect(p2.inbox).toEqual([])
  })

  it('names the caller itself in core.self under a parent, never the root', async () => {
    const { http, mcp } = plugins()
    http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    expect((await mcp.ask('core.self', undefined, { parent: parent.callId })).result).toEqual(worker('mcp'))
  })

  it('hands a provider the parent of a sub-call', async () => {
    const { http, mcp, vault } = plugins()
    vault.files.set('notes/a.md', 'x')
    http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    expect((await mcp.ask('vault.read', { path: 'notes/a.md' }, { parent: parent.callId })).ok).toBe(true)
    expect(vault.prepared[0].parent).toBe(parent.callId)
  })

  // The parent's timer may not have run yet, say when a host half kept main busy past the deadline
  it('refuses a sub-call under a parent already past its deadline', async () => {
    let clock = 1_000_000
    const { http, mcp, git, loader } = plugins({ clock: () => clock })
    loader.human.plugins.http = { callDeadlineMs: 5000 }
    http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    clock += 5000
    expect(code(await mcp.ask('git.log', undefined, { parent: parent.callId }))).toBe('invalid')
    expect(deliveries(git, 'git.log')).toEqual([])
  })
})

describe('deadlines and cancel', () => {
  it('times a call out, cancels its sub-calls and drops their late replies', async () => {
    const { http, mcp, git, loader } = plugins()
    loader.human.plugins.http = { callDeadlineMs: 80 }
    const id = http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    const sub = mcp.call('git.log', undefined, { parent: parent.callId })
    const child = await git.delivered('git.log')
    expect(code(await http.reply(id, 1000))).toBe('timeout')
    expect(code(await mcp.reply(sub))).toBe('timeout')
    await mcp.waitFor(message => message.kind === 'cancel' && message.callId === parent.callId)
    await git.waitFor(message => message.kind === 'cancel' && message.callId === child.callId)
    git.answer(child.callId, 'late')
    mcp.answer(parent.callId, 'late')
    await tick(20)
    expect(mcp.repliesTo(sub)).toHaveLength(1)
    expect(http.repliesTo(id)).toHaveLength(1)
  })

  it('cancels a call by its own id, with every sub-call under it', async () => {
    const { http, mcp, git, search } = plugins()
    const id = http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    const toSearch = mcp.call('search.query', undefined, { parent: parent.callId })
    const atSearch = await search.delivered('search.query')
    const toGit = search.call('git.log', undefined, { parent: atSearch.callId })
    const atGit = await git.delivered('git.log')
    // Not mcp's own call, so this cancel finds nothing
    mcp.post({ v: 1, kind: 'cancel', id })
    await tick(10)
    expect(http.repliesTo(id)).toEqual([])
    http.post({ v: 1, kind: 'cancel', id })
    expect(code(await http.reply(id))).toBe('stopped')
    expect(code(await mcp.reply(toSearch))).toBe('stopped')
    expect(code(await search.reply(toGit))).toBe('stopped')
    for (const [side, callId] of [[mcp, parent.callId], [search, atSearch.callId], [git, atGit.callId]] as const) {
      await side.waitFor(message => message.kind === 'cancel' && message.callId === callId)
    }
    git.answer(atGit.callId, 'late')
    search.answer(atSearch.callId, 'late')
    await tick(20)
    expect(search.repliesTo(toGit)).toHaveLength(1)
    expect(mcp.repliesTo(toSearch)).toHaveLength(1)
  })

  it('cancels the sub-calls a crashed plugin had in flight', async () => {
    const { http, mcp, git } = plugins()
    http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    mcp.call('git.log', undefined, { parent: parent.callId })
    const child = await git.delivered('git.log')
    mcp.port.close()
    await git.waitFor(message => message.kind === 'cancel' && message.callId === child.callId)
  })

  // Nothing done under a call outlives it: work a callee wants to keep doing after answering runs as its own calls
  it('cancels the live sub-calls of a call once it is answered', async () => {
    const { http, mcp, git } = plugins()
    const id = http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    const sub = mcp.call('git.log', undefined, { parent: parent.callId })
    const child = await git.delivered('git.log')
    mcp.answer(parent.callId, 'done')
    expect((await http.reply(id)).ok).toBe(true)
    expect(code(await mcp.reply(sub))).toBe('stopped')
    await git.waitFor(message => message.kind === 'cancel' && message.callId === child.callId)
    git.answer(child.callId, 'late')
    await tick(20)
    expect(mcp.repliesTo(sub)).toHaveLength(1)
  })

  it('frees the root caller\'s ceiling once the answered call\'s sub-calls are cancelled', async () => {
    const { http, mcp, loader } = plugins()
    loader.human.plugins.http = { callsInFlight: 2 }
    const id = http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    mcp.call('git.log', undefined, { parent: parent.callId })
    await tick(10)
    mcp.answer(parent.callId, 'done')
    await http.reply(id)
    http.call('mcp.handle')
    http.call('mcp.handle')
    for (let i = 0; i < 100 && deliveries(mcp, 'mcp.handle').length < 3; i++) await tick(5)
    expect(deliveries(mcp, 'mcp.handle')).toHaveLength(3)
    expect(http.inbox.filter(message => code(message) === 'throttled')).toEqual([])
  })

  it('leaves the sub-calls of other calls from the same caller running', async () => {
    const { http, mcp, git } = plugins()
    const first = http.call('mcp.handle')
    http.call('mcp.handle')
    for (let i = 0; i < 100 && deliveries(mcp, 'mcp.handle').length < 2; i++) await tick(5)
    const [one, two] = deliveries(mcp, 'mcp.handle')
    mcp.call('git.log', undefined, { parent: one.callId })
    const kept = mcp.call('git.log', undefined, { parent: two.callId })
    for (let i = 0; i < 100 && deliveries(git, 'git.log').length < 2; i++) await tick(5)
    mcp.answer(one.callId, 'done')
    await http.reply(first)
    const atGit = deliveries(git, 'git.log')[1]
    git.answer(atGit.callId, 'entries')
    expect((await mcp.reply(kept)).result).toBe('entries')
  })

  it('still lets a callee make calls of its own with no parent after it answered', async () => {
    const { http, mcp, git } = plugins()
    const id = http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    mcp.answer(parent.callId, 'done')
    await http.reply(id)
    const own = mcp.call('git.log')
    const atGit = await git.delivered('git.log')
    git.answer(atGit.callId, 'entries')
    expect((await mcp.reply(own)).result).toBe('entries')
  })

  // A call with no parent, which only the list of calls the way made can reach
  it.each([
    ['crashes', (parts: ReturnType<typeof plugins>) => parts.mcp.port.close()],
    ['is stopped', (parts: ReturnType<typeof plugins>) => parts.carrier.end(worker('mcp'))],
  ])('tells the callee at once when the plugin that made a call %s', async (_name, end) => {
    const parts = plugins()
    parts.mcp.call('search.query')
    const got = await parts.search.delivered('search.query')
    end(parts)
    await parts.search.waitFor(message => message.kind === 'cancel' && message.callId === got.callId, 500)
  })

  it('lets go of no lock for a prepare that refused after its call was stopped', async () => {
    const { connect, gate, vault } = harness()
    gate.grants.search = [{ type: 'vault.read', paths: ['**'] }]
    let open!: () => void
    const held = new Promise<void>(resolve => { open = resolve })
    vault.prepare = async () => {
      await held
      return { code: 'not-found' } as never
    }
    const search = connect(worker('search'))
    const id = search.call('vault.read', { path: 'a.md' })
    await tick(10)
    search.post({ v: 1, kind: 'cancel', id })
    expect(code(await search.reply(id))).toBe('stopped')
    open()
    await tick(10)
    expect(vault.released).toEqual([])
  })

  // Past the longest delay a timer takes, Node would fire the timer at once
  it('holds a deadline raised past the longest timer to the longest timer', async () => {
    const { http, mcp, loader } = plugins()
    loader.human.plugins.http = { callDeadlineMs: 30 * 24 * 3600 * 1000 }
    const id = http.call('mcp.handle')
    const got = await mcp.delivered('mcp.handle')
    await tick(50)
    expect(http.repliesTo(id)).toEqual([])
    expect(got.deadline as number).toBeLessThanOrEqual(Date.now() + MAX_TIMER_MS)
    mcp.answer(got.callId, null)
    expect((await http.reply(id)).ok).toBe(true)
  })

  it('keeps a delivered deadline a safe integer whatever deadline the human\'s limits hold', async () => {
    const { http, mcp, loader } = plugins()
    loader.human.all = { callDeadlineMs: Number.MAX_SAFE_INTEGER }
    const id = http.call('mcp.handle')
    const got = await mcp.delivered('mcp.handle')
    expect(delivery.safeParse(got).success).toBe(true)
    await tick(20)
    expect(http.repliesTo(id)).toEqual([])
  })

  // The timer can't stop a call whose steps never yield to it. A gate's decide is never timed and a guard is timed only
  // against its own limit
  it.each([
    ['the gate at decide', (parts: ReturnType<typeof harness>, late: () => void) => {
      parts.gate.decision = access => {
        if (access.stage === 'canonical') late()
        return parts.gate.granted(access)
      }
    }],
    ['a guard', (parts: ReturnType<typeof harness>, late: () => void) => {
      parts.loader.slots.leases = 'on'
      parts.loader.human.plugins.leases = { guardAnswerMs: 10000 }
      parts.guards.leases = new FakeGuard()
      parts.guards.leases.answer = () => {
        late()
        return 'allow'
      }
    }],
  ])('performs no provider call that %s ran past its deadline and lets go of the lock', async (_name, slow) => {
    let clock = 1_000_000
    const parts = harness({ clock: () => clock, guardsFor: () => ['leases'] })
    const { connect, gate, vault, loader } = parts
    gate.grants.search = [{ type: 'vault.write', paths: ['**'] }]
    loader.slots.leases = 'off'
    loader.human.plugins.search = { callDeadlineMs: 5000 }
    slow(parts, () => { clock += 5000 })
    expect(code(await connect(worker('search')).ask('vault.write', { path: 'a.md', text: 'x' }))).toBe('timeout')
    expect(vault.performed).toEqual([])
    expect(vault.files.size).toBe(0)
    expect(vault.released).toHaveLength(1)
  })

  it('delivers no plugin call the gate ran past its deadline', async () => {
    let clock = 1_000_000
    const { mcp, search, gate, loader } = plugins({ clock: () => clock })
    loader.human.plugins.mcp = { callDeadlineMs: 5000 }
    gate.decision = access => {
      if (access.stage === 'canonical') clock += 5000
      return gate.granted(access)
    }
    expect(code(await mcp.ask('search.query'))).toBe('timeout')
    expect(deliveries(search, 'search.query')).toEqual([])
  })

  it('leaves a provider call to finish when it is cancelled and lets go of the lock it took', async () => {
    const { mcp, vault } = plugins()
    vault.files.set('notes/a.md', 'x')
    let open!: () => void
    vault.hold.prepare = new Promise<void>(resolve => { open = resolve })
    const id = mcp.call('vault.read', { path: 'notes/a.md' })
    for (let i = 0; i < 100 && vault.prepared.length === 0; i++) await tick(2)
    mcp.post({ v: 1, kind: 'cancel', id })
    expect(code(await mcp.reply(id))).toBe('stopped')
    open()
    await tick(10)
    expect(vault.performed).toEqual([])
    expect(vault.released).toHaveLength(1)
  })
})

describe('filterReadable', () => {
  async function incoming(over: Partial<CarrierOptions> = {}) {
    const parts = plugins(over)
    const id = parts.mcp.call('search.query', { text: 'x' })
    const got = await parts.search.delivered('search.query')
    return { ...parts, id, got }
  }

  it('gives back the paths the callee may read that the caller may read too, asking about the caller only for those', async () => {
    const { search, got, gate } = await incoming()
    const reply = await search.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md', 'private/b.md', 'other/c.md'] })
    expect(reply.result).toEqual(['notes/a.md'])
    const asked = gate.reads.map(read => `${(read.caller as { id: string }).id} ${read.path}`)
    expect(asked).toEqual(['search notes/a.md', 'mcp notes/a.md', 'search private/b.md', 'mcp private/b.md', 'search other/c.md'])
  })

  it('works only during a live call delivered on the same port', async () => {
    const { search, git, mcp, got, id } = await incoming()
    expect(code(await git.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('invalid')
    expect(code(await mcp.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('invalid')
    search.answer(got.callId, [])
    await mcp.reply(id)
    expect(code(await search.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('invalid')
  })

  it('gives back every path with the gate off and refuses policy-down while it starts or is failed', async () => {
    const { search, got, loader, gate } = await incoming()
    loader.slots.gate = 'off'
    const paths = ['notes/a.md', 'other/c.md']
    expect((await search.ask('core.filterReadable', { call: got.callId, paths })).result).toEqual(paths)
    for (const state of ['starting', 'failed', 'absent'] as const) {
      loader.slots.gate = state
      expect(code(await search.ask('core.filterReadable', { call: got.callId, paths }))).toBe('policy-down')
    }
    expect(gate.reads).toEqual([])
  })

  it('refuses policy-down when canRead throws and counts only an exact true', async () => {
    const { search, got, gate } = await incoming()
    const id = (caller: Caller) => (caller as { id: string }).id
    // On either side, with the other side's answer true
    gate.readable = caller => id(caller) === 'search' ? 1 : true
    expect((await search.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md'] })).result).toEqual([])
    gate.readable = caller => id(caller) === 'search' ? true : 1
    expect((await search.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md'] })).result).toEqual([])
    gate.readable = () => { throw new Error('broken') }
    expect(code(await search.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('policy-down')
  })

  it('records a canRead that throws as a fault', async () => {
    const { carrier, search, got, gate, log } = await incoming()
    gate.readable = () => { throw new Error('broken') }
    expect(code(await search.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('policy-down')
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'gate', step: 'canRead', count: 1 }])
  })

  it(`caps the paths at ${MAX_FILTER_PATHS}`, async () => {
    const { search, got } = await incoming()
    const paths = Array.from({ length: MAX_FILTER_PATHS + 1 }, (_, i) => `notes/${i}.md`)
    expect(code(await search.ask('core.filterReadable', { call: got.callId, paths }))).toBe('invalid')
    expect((await search.ask('core.filterReadable', { call: got.callId, paths: paths.slice(1) })).ok).toBe(true)
  })

  // Each canRead below takes a millisecond of main on the carrier's clock
  async function timed(over: Partial<CarrierOptions> = {}) {
    const clock = { now: 1000 }
    const parts = await incoming({ clock: () => clock.now, ...over })
    parts.gate.readable = () => {
      clock.now += 1
      return true
    }
    const named = (count: number, from = 0) => Array.from({ length: count }, (_, i) => `notes/${from + i}.md`)
    const paths = named(40)
    const filter = (asked = paths, call = parts.got.callId) => parts.search.ask('core.filterReadable', { call, paths: asked })
    return { ...parts, clock, named, paths, filter }
  }

  it('answers throttled once the caller spent its second of the gate\'s time, partway through a call too', async () => {
    const { clock, paths, filter, gate } = await timed()
    // 40 paths asked about on both sides, 80 ms of the 100
    expect((await filter()).result).toEqual(paths)
    // 80 more pass the budget partway
    expect(code(await filter())).toBe('throttled')
    expect(gate.reads).toHaveLength(100)
    // Spent, so the next is refused without asking the gate
    expect(code(await filter())).toBe('throttled')
    expect(gate.reads).toHaveLength(100)
    // A new second goes on where the throttled call stopped, asking nothing twice
    clock.now += 1000
    expect((await filter()).result).toEqual(paths)
    expect(gate.reads).toHaveLength(160)
  })

  it('finishes a call bigger than the budget across tries', async () => {
    const { clock, named, filter, gate } = await timed()
    const many = named(150)
    expect(code(await filter(many))).toBe('throttled')
    clock.now += 1000
    expect(code(await filter(many))).toBe('throttled')
    clock.now += 1000
    expect((await filter(many)).result).toEqual(many)
    expect(gate.reads).toHaveLength(300)
  })

  it('starts over when the StateView moved or the paths changed since the throttled try', async () => {
    const { clock, named, filter, gate, loader } = await timed()
    const many = named(150)
    expect(code(await filter(many))).toBe('throttled')
    // A narrowing between tries must not leave answers from before it standing
    loader.current = 2
    clock.now += 1000
    expect(code(await filter(many))).toBe('throttled')
    expect(gate.reads.slice(100, 102).map(read => read.path)).toEqual(['notes/0.md', 'notes/0.md'])
    // Other paths for the same call are another question
    clock.now += 1000
    expect(code(await filter(named(150, 1000)))).toBe('throttled')
    expect(gate.reads[200].path).toBe('notes/1000.md')
  })

  it('counts the gate\'s time against the caller, so one that floods a plugin leaves the other callers theirs', async () => {
    const { filter, gate, git, search, named } = await timed()
    gate.grants.git = [{ type: 'plugin.call', targets: ['search'] }, { type: 'vault.read', paths: ['notes/**'] }]
    expect(code(await filter(named(80)))).toBe('throttled')
    git.call('search.query', { text: 'x' })
    for (let waited = 0; deliveries(search, 'search.query').length < 2 && waited < 2000; waited += 5) await tick(5)
    const second = deliveries(search, 'search.query')[1] as unknown as { callId: string }
    expect((await filter(named(40), second.callId)).result).toEqual(named(40))
  })

  it('takes the human\'s budget for the caller', async () => {
    const { loader, paths, filter } = await timed()
    loader.human.plugins.mcp = { filterMsPerSecond: 200 }
    expect((await filter()).result).toEqual(paths)
    expect((await filter()).result).toEqual(paths)
    expect(code(await filter())).toBe('throttled')
  })

  it('stops a grant shaped for the matcher\'s worst case within its budget instead of holding main', async () => {
    const { search, got, gate } = await incoming()
    const crafted = Array.from({ length: 85 }, () => '**/*a*b').join('/').slice(0, 511)
    gate.grants.search = [{ type: 'vault.read', paths: Array(64).fill(crafted) }]
    const deep = Array.from({ length: 256 }, () => 'a').join('/').slice(0, 511)
    const started = performance.now()
    const reply = await search.ask('core.filterReadable', { call: got.callId, paths: Array(MAX_FILTER_PATHS).fill(deep) })
    expect(code(reply)).toBe('throttled')
    // The budget is 100 ms. Unbounded the message held main for one to three seconds
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('calls a provider holds', () => {
  it('ignores a reply the provider\'s own handle sends for a call it is performing, which only perform answers', async () => {
    const { carrier, connect, gate, vault } = harness()
    gate.grants.search = [{ type: 'vault.read', paths: ['**'] }]
    vault.files.set('a.md', 'x')
    let open!: () => void
    vault.hold.perform = new Promise<void>(resolve => { open = resolve })
    const own = hostHalf(carrier, host('vault'))
    const search = connect(worker('search'))
    const id = search.call('vault.read', { path: 'a.md' })
    for (let i = 0; i < 100 && vault.performed.length === 0; i++) await tick(2)
    const { callId } = vault.performed[0].call
    own.handle.post({ v: 1, kind: 'reply', callId, ok: true, result: 'forged' })
    // The provider may hang its own sub-calls under the call
    expect((await own.ask('core.self', undefined, { parent: callId })).ok).toBe(true)
    expect(search.repliesTo(id)).toEqual([])
    open()
    expect((await search.reply(id)).result).toEqual({ text: 'x' })
    expect(code(await own.ask('core.self', undefined, { parent: callId }))).toBe('invalid')
  })
})

describe('a crash', () => {
  it('lets the loader move dependents to waiting before any call the plugin held is answered', async () => {
    const { carrier, connect, loader } = harness()
    loader.slots.gate = 'off'
    loader.sandboxed('search', { query: {} })
    const search = connect(worker('search'))
    const way = windowWay(carrier, { 'editor-1': editor })
    way.post('editor-1', { v: 1, kind: 'call', id: 1, action: 'search.query', args: {} })
    await search.delivered('search.query')
    let answeredFirst = -1
    loader.crashed = (caller, reason) => {
      answeredFirst = way.replies.length
      loader.crashes.push({ caller, reason })
    }
    search.port.close()
    for (let i = 0; i < 100 && way.replies.length === 0; i++) await tick(2)
    expect(answeredFirst).toBe(0)
    expect(code(way.replies[0])).toBe('crashed')
  })
})
