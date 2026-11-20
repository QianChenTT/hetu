import { afterEach, describe, expect, it } from 'vitest'
import { delivery, token, type Caller } from '../api/envelope.ts'
import { LIST_PAGE, MAX_FILTER_PATHS } from '../api/actions.ts'
import { MAX_TIMER_MS } from '../api/limits.ts'
import type { CarrierOptions } from '../backend/carrier/header.ts'
import { cleanup, code, editor, FakeGuard, harness, tick, windowWay, worker, type Side } from './carrier-fakes.ts'

afterEach(cleanup)

// search serves query, git serves log and scribe serves handle for http only
function plugins(over: Partial<CarrierOptions> = {}) {
  const parts = harness(over)
  const { pluginsManager, gate, connect } = parts
  pluginsManager.sandboxed('search', { query: {} })
  pluginsManager.sandboxed('git', { log: {} })
  pluginsManager.sandboxed('scribe', { handle: { from: ['mcp-http-handler'] } })
  gate.grants['mcp-http-handler'] = [{ type: 'plugin.call', targets: ['scribe'] }]
  gate.grants.scribe = [{ type: 'plugin.call', targets: ['search', 'git'] }, { type: 'luoshu.read', paths: ['notes/**'] }]
  gate.grants.search = [{ type: 'plugin.call', targets: ['git'] }, { type: 'luoshu.read', paths: ['notes/**', 'private/**'] }]
  return { ...parts, http: connect(worker('mcp-http-handler')), scribe: connect(worker('scribe')), search: connect(worker('search')), git: connect(worker('git')) }
}

// The delivery a callee got for the nth call of an action
const deliveries = (side: Side, action: string) => side.inbox.filter(message => message.kind === 'call' && message.action === action)

describe('plugin.call', () => {
  it('mints a random call id in the token grammar for every call', async () => {
    const { scribe } = plugins()
    const replies = await Promise.all(Array.from({ length: 50 }, () => scribe.ask('core.self')))
    const ids = replies.map(reply => reply.callId)
    expect(ids.every(id => token.safeParse(id).success)).toBe(true)
    expect(new Set(ids).size).toBe(50)
  })

  it('hands the callee the caller and onBehalf with the call id the caller\'s reply carries', async () => {
    const { http, scribe } = plugins()
    const started = Date.now()
    const id = http.call('scribe.handle', { tool: 'read' }, { onBehalf: 'https://client.example/agent-a' })
    const got = await scribe.delivered('scribe.handle')
    expect(delivery.safeParse(got).success).toBe(true)
    expect(got).toMatchObject({ caller: worker('mcp-http-handler'), onBehalf: 'https://client.example/agent-a', args: { tool: 'read' } })
    expect(got.deadline).toBeGreaterThanOrEqual(started + 30000)
    expect(got.deadline).toBeLessThan(started + 31000)
    scribe.answer(got.callId, { ok: 1 })
    const reply = await http.reply(id)
    expect(reply).toMatchObject({ ok: true, result: { ok: 1 }, callId: got.callId })
  })

  it('lets only the callers a declared from names reach the action, the plugin\'s own halves aside', async () => {
    const { http, search, scribe, connect, pluginsManager, carrier } = plugins()
    expect(code(await search.ask('scribe.handle'))).toBe('not-granted')
    http.call('scribe.handle')
    await scribe.delivered('scribe.handle')
    const panel = connect({ kind: 'plugin', id: 'scribe', half: 'consent', incarnation: 1 })
    panel.call('scribe.handle')
    await tick()
    expect(deliveries(scribe, 'scribe.handle')).toHaveLength(2)
    // A window is never in from, even with the gate off
    pluginsManager.policyJobs.gate = 'off'
    const way = windowWay(carrier, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'scribe.handle'))).toBe('not-granted')
  })

  it.each([
    ['starting', 'starting'],
    ['unresponsive', 'timeout'],
    ['stopped', 'unavailable'],
    ['off', 'unavailable'],
    ['waiting', 'unavailable'],
    ['crashed', 'unavailable'],
  ] as const)('answers a call to a %s target %s at once', async (state, expected) => {
    const { scribe, git, pluginsManager } = plugins()
    pluginsManager.sandboxed('git', { log: {} }, state)
    const started = Date.now()
    expect(code(await scribe.ask('git.log'))).toBe(expected)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(deliveries(git, 'git.log')).toEqual([])
  })

  it('answers unavailable for a ready target whose serving half has no way in', async () => {
    const { scribe, pluginsManager } = plugins()
    pluginsManager.sandboxed('git', { log: {} }, 'ready', 2)
    expect(code(await scribe.ask('git.log'))).toBe('unavailable')
  })

  it('ignores a reply on any port but the one the call was delivered on', async () => {
    const { scribe, search, git } = plugins()
    const id = scribe.call('search.query', { text: 'x' })
    const got = await search.delivered('search.query')
    git.answer(got.callId, ['forged.md'])
    scribe.answer(got.callId, ['mine.md'])
    git.post({ v: 1, kind: 'reply', callId: got.callId, ok: false, refusal: { code: 'not-granted', action: 'search.query' } })
    await tick(20)
    expect(scribe.repliesTo(id)).toEqual([])
    search.answer(got.callId, ['a.md'])
    expect((await scribe.reply(id)).result).toEqual(['a.md'])
  })

  // Codes such as policy-down or switched-off describe the core's own state for the caller's call. A plugin that sends
  // one passes for the core, so its refusal keeps only a code a plugin may give
  it.each([
    ['not-found', 'not-found'], ['invalid', 'invalid'], ['not-granted', 'not-granted'], ['unavailable', 'unavailable'],
    ['throttled', 'throttled'], ['timeout', 'timeout'], ['stale', 'stale'], ['failed', 'failed'],
    ['policy-down', 'failed'], ['switched-off', 'failed'], ['needs-confirm', 'failed'], ['guard-down', 'failed'],
    ['guard-refused', 'failed'], ['starting', 'failed'], ['stopped', 'failed'], ['crashed', 'failed'], ['tampered', 'failed'],
  ])('passes a callee\'s %s on as %s', async (sent, answered) => {
    const { scribe, search } = plugins()
    const id = scribe.call('search.query', { text: 'x' })
    const got = await search.delivered('search.query')
    search.post({ v: 1, kind: 'reply', callId: got.callId, ok: false, refusal: { code: sent, action: 'search.query' } })
    expect(code(await scribe.reply(id))).toBe(answered)
  })

  it('keeps a callee\'s too-large and drops any other reason', async () => {
    const { scribe, search } = plugins()
    const first = scribe.call('search.query', { text: 'x' })
    const one = await search.delivered('search.query')
    search.post({ v: 1, kind: 'reply', callId: one.callId, ok: false, refusal: { code: 'invalid', action: 'search.query', reason: 'too-large' } })
    expect((await scribe.reply(first)).refusal).toEqual({ code: 'invalid', action: 'search.query', reason: 'too-large' })
    const second = scribe.call('search.query', { text: 'y' })
    await search.waitFor(message => message.kind === 'call' && message.callId !== one.callId)
    const two = search.inbox.filter(message => message.kind === 'call').at(-1)!
    search.post({ v: 1, kind: 'reply', callId: two.callId, ok: false, refusal: { code: 'failed', action: 'search.query', reason: 'declined' } })
    expect((await scribe.reply(second)).refusal).toEqual({ code: 'failed', action: 'search.query' })
  })

  it('ignores a reply from a new incarnation for a call the old one was given', async () => {
    const { scribe, search, connect, pluginsManager } = plugins()
    const id = scribe.call('search.query')
    const got = await search.delivered('search.query')
    pluginsManager.sandboxed('search', { query: {} }, 'ready', 2)
    const again = connect(worker('search', 2))
    again.answer(got.callId, ['forged.md'])
    await tick(20)
    expect(scribe.repliesTo(id)).toEqual([])
    search.answer(got.callId, ['a.md'])
    expect((await scribe.reply(id)).result).toEqual(['a.md'])
  })

  it('drops a second answer and an answer outside the schema fails the call', async () => {
    const { scribe, search } = plugins()
    const one = scribe.call('search.query')
    const first = await search.delivered('search.query')
    search.answer(first.callId, 1)
    search.answer(first.callId, 2)
    expect((await scribe.reply(one)).result).toBe(1)
    const two = scribe.call('search.query')
    await tick(10)
    const second = deliveries(search, 'search.query')[1]
    search.post({ v: 1, kind: 'reply', callId: second.callId, ok: true, result: 1, extra: true })
    expect(code(await scribe.reply(two))).toBe('failed')
    await tick(10)
    expect(scribe.repliesTo(one)).toHaveLength(1)
  })

  it('hands on neither a needs-confirm nor a request id a callee made up', async () => {
    const { scribe, search } = plugins()
    const id = scribe.call('search.query')
    const got = await search.delivered('search.query')
    search.post({
      v: 1, kind: 'reply', callId: got.callId, ok: false,
      refusal: { code: 'needs-confirm', action: 'luoshu.write', reason: 'declined', request: 'fake-request' },
    })
    expect((await scribe.reply(id)).refusal).toEqual({ code: 'failed', action: 'search.query' })
  })

  it('fails a callee result past its cap with too-large', async () => {
    const { scribe, search, pluginsManager } = plugins()
    pluginsManager.human.plugins.search = { resultBytes: 64 }
    const id = scribe.call('search.query')
    const got = await search.delivered('search.query')
    search.answer(got.callId, 'x'.repeat(100))
    expect((await scribe.reply(id)).refusal).toEqual({ code: 'failed', action: 'search.query', reason: 'too-large' })
  })

  // A plugins manager whose actions is not an object throws outside every step's own try
  it('answers failed at once for a call that threw in flight', async () => {
    const { connect, pluginsManager } = harness()
    pluginsManager.policyJobs.gate = 'off'
    pluginsManager.plugins.git = { state: 'ready', place: 'sandboxed', incarnation: 1, serves: 'worker', actions: null as never, topics: [] }
    connect(worker('git'))
    const started = Date.now()
    expect(code(await connect(worker('search')).ask('git.log'))).toBe('failed')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('parent', () => {
  it('takes a parent only for a live call delivered on the same port', async () => {
    const { http, scribe, git, search } = plugins()
    const id = http.call('scribe.handle')
    const got = await scribe.delivered('scribe.handle')
    // Foreign: delivered to scribe, named by others
    expect(code(await git.ask('search.query', undefined, { parent: got.callId }))).toBe('invalid')
    expect(code(await http.ask('core.self', undefined, { parent: got.callId }))).toBe('invalid')
    expect(code(await search.ask('git.log', undefined, { parent: got.callId }))).toBe('invalid')
    expect(code(await scribe.ask('core.self', undefined, { parent: 'no-such-call' }))).toBe('invalid')
    expect((await scribe.ask('core.self', undefined, { parent: got.callId })).ok).toBe(true)
    scribe.answer(got.callId, null)
    await http.reply(id)
    // Over once answered
    expect(code(await scribe.ask('core.self', undefined, { parent: got.callId }))).toBe('invalid')
  })

  it('shrinks the deadline along parent', async () => {
    const { http, scribe, git, pluginsManager } = plugins()
    pluginsManager.human.plugins['mcp-http-handler'] = { callDeadlineMs: 5000 }
    http.call('scribe.handle')
    const parent = await scribe.delivered('scribe.handle')
    scribe.call('git.log', undefined, { parent: parent.callId })
    const child = await git.delivered('git.log')
    expect(child.deadline).toBe(parent.deadline)
    expect(parent.deadline as number).toBeLessThan(Date.now() + 5001)
  })

  it('stops at a depth of 4', async () => {
    const { connect, pluginsManager } = harness()
    pluginsManager.policyJobs.gate = 'off'
    const chain = ['p1', 'p2', 'p3', 'p4', 'p5']
    for (const id of chain) pluginsManager.sandboxed(id, { go: {} })
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
    const { connect, pluginsManager } = harness()
    pluginsManager.policyJobs.gate = 'off'
    pluginsManager.sandboxed('p1', { go: {} })
    pluginsManager.sandboxed('p2', { go: {} })
    pluginsManager.human.plugins.p1 = { parentDepth: 1 }
    const p1 = connect(worker('p1'))
    const p2 = connect(worker('p2'))
    connect(worker('p0')).call('p1.go')
    const parent = await p1.delivered('p1.go')
    expect(code(await p1.ask('p2.go', undefined, { parent: parent.callId }))).toBe('invalid')
    expect(p2.inbox).toEqual([])
  })

  it('names the caller itself in core.self under a parent, never the root', async () => {
    const { http, scribe } = plugins()
    http.call('scribe.handle')
    const parent = await scribe.delivered('scribe.handle')
    expect((await scribe.ask('core.self', undefined, { parent: parent.callId })).result).toEqual(worker('scribe'))
  })

  it('hands a provider the parent of a sub-call', async () => {
    const { scribe, search, luoshu } = plugins()
    luoshu.files.set('notes/a.md', 'x')
    scribe.call('search.query')
    const parent = await search.delivered('search.query')
    expect((await search.ask('luoshu.read', { path: 'notes/a.md' }, { parent: parent.callId })).ok).toBe(true)
    expect(luoshu.prepared[0].parent).toBe(parent.callId)
  })

  // The parent's timer may not have run yet, say when a host half kept main busy past the deadline
  it('refuses a sub-call under a parent already past its deadline', async () => {
    let clock = 1_000_000
    const { http, scribe, git, pluginsManager } = plugins({ clock: () => clock })
    pluginsManager.human.plugins['mcp-http-handler'] = { callDeadlineMs: 5000 }
    http.call('scribe.handle')
    const parent = await scribe.delivered('scribe.handle')
    clock += 5000
    expect(code(await scribe.ask('git.log', undefined, { parent: parent.callId }))).toBe('invalid')
    expect(deliveries(git, 'git.log')).toEqual([])
  })
})

describe('deadlines and cancel', () => {
  it('times a call out, cancels its sub-calls and drops their late replies', async () => {
    const { http, scribe, git, pluginsManager } = plugins()
    pluginsManager.human.plugins['mcp-http-handler'] = { callDeadlineMs: 80 }
    const id = http.call('scribe.handle')
    const parent = await scribe.delivered('scribe.handle')
    const sub = scribe.call('git.log', undefined, { parent: parent.callId })
    const child = await git.delivered('git.log')
    expect(code(await http.reply(id, 1000))).toBe('timeout')
    expect(code(await scribe.reply(sub))).toBe('timeout')
    await scribe.waitFor(message => message.kind === 'cancel' && message.callId === parent.callId)
    await git.waitFor(message => message.kind === 'cancel' && message.callId === child.callId)
    git.answer(child.callId, 'late')
    scribe.answer(parent.callId, 'late')
    await tick(20)
    expect(scribe.repliesTo(sub)).toHaveLength(1)
    expect(http.repliesTo(id)).toHaveLength(1)
  })

  it('cancels a call by its own id, with every sub-call under it', async () => {
    const { http, scribe, git, search } = plugins()
    const id = http.call('scribe.handle')
    const parent = await scribe.delivered('scribe.handle')
    const toSearch = scribe.call('search.query', undefined, { parent: parent.callId })
    const atSearch = await search.delivered('search.query')
    const toGit = search.call('git.log', undefined, { parent: atSearch.callId })
    const atGit = await git.delivered('git.log')
    // Not scribe's own call, so this cancel finds nothing
    scribe.post({ v: 1, kind: 'cancel', id })
    await tick(10)
    expect(http.repliesTo(id)).toEqual([])
    http.post({ v: 1, kind: 'cancel', id })
    expect(code(await http.reply(id))).toBe('stopped')
    expect(code(await scribe.reply(toSearch))).toBe('stopped')
    expect(code(await search.reply(toGit))).toBe('stopped')
    for (const [side, callId] of [[scribe, parent.callId], [search, atSearch.callId], [git, atGit.callId]] as const) {
      await side.waitFor(message => message.kind === 'cancel' && message.callId === callId)
    }
    git.answer(atGit.callId, 'late')
    search.answer(atSearch.callId, 'late')
    await tick(20)
    expect(search.repliesTo(toGit)).toHaveLength(1)
    expect(scribe.repliesTo(toSearch)).toHaveLength(1)
  })

  it('cancels the sub-calls a crashed plugin had in flight', async () => {
    const { http, scribe, git } = plugins()
    http.call('scribe.handle')
    const parent = await scribe.delivered('scribe.handle')
    scribe.call('git.log', undefined, { parent: parent.callId })
    const child = await git.delivered('git.log')
    scribe.port.close()
    await git.waitFor(message => message.kind === 'cancel' && message.callId === child.callId)
  })

  // Nothing done under a call outlives it: work a callee wants to keep doing after answering runs as its own calls
  it('cancels the live sub-calls of a call once it is answered', async () => {
    const { http, scribe, git } = plugins()
    const id = http.call('scribe.handle')
    const parent = await scribe.delivered('scribe.handle')
    const sub = scribe.call('git.log', undefined, { parent: parent.callId })
    const child = await git.delivered('git.log')
    scribe.answer(parent.callId, 'done')
    expect((await http.reply(id)).ok).toBe(true)
    expect(code(await scribe.reply(sub))).toBe('stopped')
    await git.waitFor(message => message.kind === 'cancel' && message.callId === child.callId)
    git.answer(child.callId, 'late')
    await tick(20)
    expect(scribe.repliesTo(sub)).toHaveLength(1)
  })

  it('frees the root caller\'s ceiling once the answered call\'s sub-calls are cancelled', async () => {
    const { http, scribe, pluginsManager } = plugins()
    pluginsManager.human.plugins['mcp-http-handler'] = { callsInFlight: 2 }
    const id = http.call('scribe.handle')
    const parent = await scribe.delivered('scribe.handle')
    scribe.call('git.log', undefined, { parent: parent.callId })
    await tick(10)
    scribe.answer(parent.callId, 'done')
    await http.reply(id)
    http.call('scribe.handle')
    http.call('scribe.handle')
    for (let i = 0; i < 100 && deliveries(scribe, 'scribe.handle').length < 3; i++) await tick(5)
    expect(deliveries(scribe, 'scribe.handle')).toHaveLength(3)
    expect(http.inbox.filter(message => code(message) === 'throttled')).toEqual([])
  })

  it('leaves the sub-calls of other calls from the same caller running', async () => {
    const { http, scribe, git } = plugins()
    const first = http.call('scribe.handle')
    http.call('scribe.handle')
    for (let i = 0; i < 100 && deliveries(scribe, 'scribe.handle').length < 2; i++) await tick(5)
    const [one, two] = deliveries(scribe, 'scribe.handle')
    scribe.call('git.log', undefined, { parent: one.callId })
    const kept = scribe.call('git.log', undefined, { parent: two.callId })
    for (let i = 0; i < 100 && deliveries(git, 'git.log').length < 2; i++) await tick(5)
    scribe.answer(one.callId, 'done')
    await http.reply(first)
    const atGit = deliveries(git, 'git.log')[1]
    git.answer(atGit.callId, 'entries')
    expect((await scribe.reply(kept)).result).toBe('entries')
  })

  it('still lets a callee make calls of its own with no parent after it answered', async () => {
    const { http, scribe, git } = plugins()
    const id = http.call('scribe.handle')
    const parent = await scribe.delivered('scribe.handle')
    scribe.answer(parent.callId, 'done')
    await http.reply(id)
    const own = scribe.call('git.log')
    const atGit = await git.delivered('git.log')
    git.answer(atGit.callId, 'entries')
    expect((await scribe.reply(own)).result).toBe('entries')
  })

  // A call with no parent, which only the list of calls the way made can reach
  it.each([
    ['crashes', (parts: ReturnType<typeof plugins>) => parts.scribe.port.close()],
    ['is stopped', (parts: ReturnType<typeof plugins>) => parts.carrier.end(worker('scribe'))],
  ])('tells the callee at once when the plugin that made a call %s', async (_name, end) => {
    const parts = plugins()
    parts.scribe.call('search.query')
    const got = await parts.search.delivered('search.query')
    end(parts)
    await parts.search.waitFor(message => message.kind === 'cancel' && message.callId === got.callId, 500)
  })

  it('lets go of no lock for a prepare that refused after its call was stopped', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    let open!: () => void
    const held = new Promise<void>(resolve => { open = resolve })
    luoshu.prepare = async () => {
      await held
      return { code: 'not-found' } as never
    }
    const search = connect(worker('search'))
    const id = search.call('luoshu.read', { path: 'a.md' })
    await tick(10)
    search.post({ v: 1, kind: 'cancel', id })
    expect(code(await search.reply(id))).toBe('stopped')
    open()
    await tick(10)
    expect(luoshu.released).toEqual([])
  })

  // Past the longest delay a timer takes, Node would fire the timer at once
  it('holds a deadline raised past the longest timer to the longest timer', async () => {
    const { http, scribe, pluginsManager } = plugins()
    pluginsManager.human.plugins['mcp-http-handler'] = { callDeadlineMs: 30 * 24 * 3600 * 1000 }
    const id = http.call('scribe.handle')
    const got = await scribe.delivered('scribe.handle')
    await tick(50)
    expect(http.repliesTo(id)).toEqual([])
    expect(got.deadline as number).toBeLessThanOrEqual(Date.now() + MAX_TIMER_MS)
    scribe.answer(got.callId, null)
    expect((await http.reply(id)).ok).toBe(true)
  })

  it('keeps a delivered deadline a safe integer whatever deadline the human\'s limits hold', async () => {
    const { http, scribe, pluginsManager } = plugins()
    pluginsManager.human.all = { callDeadlineMs: Number.MAX_SAFE_INTEGER }
    const id = http.call('scribe.handle')
    const got = await scribe.delivered('scribe.handle')
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
      parts.pluginsManager.policyJobs.leases = 'on'
      parts.pluginsManager.human.plugins.leases = { guardAnswerMs: 10000 }
      parts.guards.leases = new FakeGuard()
      parts.guards.leases.answer = () => {
        late()
        return 'allow'
      }
    }],
  ])('performs no provider call that %s ran past its deadline and lets go of the lock', async (_name, slow) => {
    let clock = 1_000_000
    const parts = harness({ clock: () => clock, guardsFor: () => ['leases'] })
    const { connect, gate, luoshu, pluginsManager } = parts
    gate.grants.search = [{ type: 'luoshu.write', paths: ['**'] }]
    pluginsManager.policyJobs.leases = 'off'
    pluginsManager.human.plugins.search = { callDeadlineMs: 5000 }
    slow(parts, () => { clock += 5000 })
    expect(code(await connect(worker('search')).ask('luoshu.write', { path: 'a.md', text: 'x' }))).toBe('timeout')
    expect(luoshu.performed).toEqual([])
    expect(luoshu.files.size).toBe(0)
    expect(luoshu.released).toHaveLength(1)
  })

  it('delivers no plugin call the gate ran past its deadline', async () => {
    let clock = 1_000_000
    const { scribe, search, gate, pluginsManager } = plugins({ clock: () => clock })
    pluginsManager.human.plugins.scribe = { callDeadlineMs: 5000 }
    gate.decision = access => {
      if (access.stage === 'canonical') clock += 5000
      return gate.granted(access)
    }
    expect(code(await scribe.ask('search.query'))).toBe('timeout')
    expect(deliveries(search, 'search.query')).toEqual([])
  })

  it('leaves a provider call to finish when it is cancelled and lets go of the lock it took', async () => {
    const { search, luoshu } = plugins()
    luoshu.files.set('notes/a.md', 'x')
    let open!: () => void
    luoshu.hold.prepare = new Promise<void>(resolve => { open = resolve })
    const id = search.call('luoshu.read', { path: 'notes/a.md' })
    for (let i = 0; i < 100 && luoshu.prepared.length === 0; i++) await tick(2)
    search.post({ v: 1, kind: 'cancel', id })
    expect(code(await search.reply(id))).toBe('stopped')
    open()
    await tick(10)
    expect(luoshu.performed).toEqual([])
    expect(luoshu.released).toHaveLength(1)
  })
})

describe('filterReadable', () => {
  async function incoming(over: Partial<CarrierOptions> = {}) {
    const parts = plugins(over)
    const id = parts.scribe.call('search.query', { text: 'x' })
    const got = await parts.search.delivered('search.query')
    return { ...parts, id, got }
  }

  it('gives back the paths the callee may read that the caller may read too, asking about the caller only for those', async () => {
    const { search, got, gate } = await incoming()
    const reply = await search.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md', 'private/b.md', 'other/c.md'] })
    expect(reply.result).toEqual(['notes/a.md'])
    const asked = gate.reads.map(read => `${(read.caller as { id: string }).id} ${read.path}`)
    expect(asked).toEqual(['search notes/a.md', 'scribe notes/a.md', 'search private/b.md', 'scribe private/b.md', 'search other/c.md'])
  })

  it('works only during a live call delivered on the same port', async () => {
    const { search, git, scribe, got, id } = await incoming()
    expect(code(await git.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('invalid')
    expect(code(await scribe.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('invalid')
    search.answer(got.callId, [])
    await scribe.reply(id)
    expect(code(await search.ask('core.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('invalid')
  })

  it('gives back every path with the gate off and refuses policy-down while it is failed or absent', async () => {
    const { search, got, pluginsManager, gate } = await incoming()
    pluginsManager.policyJobs.gate = 'off'
    const paths = ['notes/a.md', 'other/c.md']
    expect((await search.ask('core.filterReadable', { call: got.callId, paths })).result).toEqual(paths)
    for (const state of ['failed', 'absent'] as const) {
      pluginsManager.policyJobs.gate = state
      expect(code(await search.ask('core.filterReadable', { call: got.callId, paths }))).toBe('policy-down')
    }
    expect(gate.reads).toEqual([])
  })

  // A saved index or another store from a build before dot names were refused could still hold one. The callee read it
  // itself, so it is taken as it is and left to the gate, whose matcher matches no dot name
  it('takes a path with a dot segment as the callee gave it, the gate answering for it and every path back with the gate off', async () => {
    const { search, got, pluginsManager, gate } = await incoming()
    gate.readable = (_caller, path) => !path.split('/').some(name => name.replace(/\u200c/g, '').startsWith('.'))
    const paths = ['notes/a.md', '.env', '.obsidian/plugins/x/data.json', 'notes/.hidden.md', 'notes/deep/.config/x.md', '\u200c.obsidian/app.json', '.git/config', 'other/c.md']
    expect((await search.ask('core.filterReadable', { call: got.callId, paths })).result).toEqual(['notes/a.md', 'other/c.md'])
    expect(gate.reads.map(read => read.path)).toEqual(expect.arrayContaining(['.env', '.git/config']))
    pluginsManager.policyJobs.gate = 'off'
    expect((await search.ask('core.filterReadable', { call: got.callId, paths })).result).toEqual(paths)
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

  it('starts over when the grants snapshot moved or the paths changed since the throttled try', async () => {
    const { clock, named, filter, gate, pluginsManager } = await timed()
    const many = named(150)
    expect(code(await filter(many))).toBe('throttled')
    // A narrowing between tries must not leave answers from before it standing
    pluginsManager.current = 2
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
    gate.grants.git = [{ type: 'plugin.call', targets: ['search'] }, { type: 'luoshu.read', paths: ['notes/**'] }]
    expect(code(await filter(named(80)))).toBe('throttled')
    git.call('search.query', { text: 'x' })
    for (let waited = 0; deliveries(search, 'search.query').length < 2 && waited < 2000; waited += 5) await tick(5)
    const second = deliveries(search, 'search.query')[1] as unknown as { callId: string }
    expect((await filter(named(40), second.callId)).result).toEqual(named(40))
  })

  it('takes the human\'s budget for the caller', async () => {
    const { pluginsManager, paths, filter } = await timed()
    pluginsManager.human.plugins.scribe = { filterMsPerSecond: 200 }
    expect((await filter()).result).toEqual(paths)
    expect((await filter()).result).toEqual(paths)
    expect(code(await filter())).toBe('throttled')
  })

  it('stops a grant shaped for the matcher\'s worst case within its budget instead of holding main', async () => {
    const { search, got, gate } = await incoming()
    const crafted = Array.from({ length: 85 }, () => '**/*a*b').join('/').slice(0, 511)
    gate.grants.search = [{ type: 'luoshu.read', paths: Array(64).fill(crafted) }]
    const deep = Array.from({ length: 256 }, () => 'a').join('/').slice(0, 511)
    const started = performance.now()
    const reply = await search.ask('core.filterReadable', { call: got.callId, paths: Array(MAX_FILTER_PATHS).fill(deep) })
    expect(code(reply)).toBe('throttled')
    // The budget is 100 ms. Unbounded the message held main for one to three seconds
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('a listing', () => {
  function listing(over: Partial<CarrierOptions> = {}) {
    const parts = harness(over)
    for (const path of ['notes/a.md', 'projects/plan.md', 'secret/b.md', '.scratch.md']) parts.luoshu.files.set(path, 'x')
    parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'luoshu.list', paths: ['projects/**'] }]
    return { ...parts, search: parts.connect(worker('search')) }
  }

  it('hands the luoshu a canList that asks the gate, so a page holds only names the caller may list or read', async () => {
    const { search, gate } = listing()
    expect((await search.ask('luoshu.list', {})).result).toEqual({ paths: ['notes/a.md', 'projects/plan.md'], next: null })
    expect(gate.asked).toEqual([])
    expect(gate.lists.map(asked => asked.path)).toEqual(expect.arrayContaining(['secret/b.md']))
    // The luoshu's walk passes a dot name by, so it never reaches the gate
    expect(gate.lists.map(asked => asked.path)).not.toContain('.scratch.md')
  })

  it.each([
    ['a name the caller may not list', { paths: ['notes/a.md', 'secret/b.md'], next: null }],
    ['a next past the page', { paths: ['notes/a.md'], next: 'secret/b.md' }],
    ['a next that is not the page’s last name', { paths: ['notes/a.md', 'projects/plan.md'], next: 'notes/a.md' }],
    ['no object', null],
    ['names that aren’t text', { paths: [1], next: null }],
    ['more names than a page', { paths: Array.from({ length: LIST_PAGE + 1 }, (_, i) => `notes/${i}.md`), next: null }],
  ])('answers failed for a provider page with %s, so no name leaks past the gate', async (_name, page) => {
    const { search, luoshu } = listing()
    luoshu.perform_ = () => page
    expect(code(await search.ask('luoshu.list', {}))).toBe('failed')
  })

  it('lets every name with no dot segment through with the gate off by the human and answers policy-down while the gate is down', async () => {
    const { search, pluginsManager } = listing()
    pluginsManager.policyJobs.gate = 'off'
    expect((await search.ask('luoshu.list', {})).result).toEqual({ paths: ['notes/a.md', 'projects/plan.md', 'secret/b.md'], next: null })
    pluginsManager.policyJobs.gate = 'failed'
    expect(code(await search.ask('luoshu.list', {}))).toBe('policy-down')
  })

  // The luoshu's walk leaves dot names out itself, before the gate is asked
  it.each(['on', 'off'] as const)('lists no name with a dot segment whatever the gate says with the gate %s', async state => {
    const { search, pluginsManager, gate, luoshu } = listing()
    for (const path of ['notes/.hidden.md', 'notes/deep/.config/x.md', '\u200c.obsidian/app.json']) luoshu.files.set(path, 'x')
    gate.listable = () => true
    pluginsManager.policyJobs.gate = state
    expect((await search.ask('luoshu.list', {})).result).toEqual({ paths: ['notes/a.md', 'projects/plan.md', 'secret/b.md'], next: null })
    expect(gate.lists.filter(asked => asked.path.split('/').some(name => name.replace(/\u200c/g, '').startsWith('.')))).toEqual([])
  })

  it('records a canList that throws and answers policy-down rather than a page it couldn’t check', async () => {
    const { search, gate, carrier, log } = listing()
    gate.listable = () => { throw new Error('broken') }
    expect(code(await search.ask('luoshu.list', {}))).toBe('policy-down')
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'gate', step: 'canList', count: 1 }])
  })

  it('charges the whole listing, the walk with it, to the caller’s second, and answers throttled once it is spent', async () => {
    const clock = { now: 1000 }
    const { search, luoshu } = listing({ clock: () => clock.now })
    // A walk of a large folder, which asks the gate nothing for a caller that holds nothing
    luoshu.perform_ = () => {
      clock.now += 150
      return { paths: [], next: null }
    }
    expect((await search.ask('luoshu.list', {})).result).toEqual({ paths: [], next: null })
    const listed = luoshu.performed.length
    expect(code(await search.ask('luoshu.list', {}))).toBe('throttled')
    expect(luoshu.performed).toHaveLength(listed)
    clock.now += 1000
    expect((await search.ask('luoshu.list', {})).ok).toBe(true)
  })
})

describe('a crash', () => {
  it('lets the plugins manager move dependents to waiting before any call the plugin held is answered', async () => {
    const { carrier, connect, pluginsManager } = harness()
    pluginsManager.policyJobs.gate = 'off'
    pluginsManager.sandboxed('search', { query: {} })
    const search = connect(worker('search'))
    const way = windowWay(carrier, { 'editor-1': editor })
    way.post('editor-1', { v: 1, kind: 'call', id: 1, action: 'search.query', args: {} })
    await search.delivered('search.query')
    let answeredFirst = -1
    pluginsManager.crashed = (caller, reason) => {
      answeredFirst = way.replies.length
      pluginsManager.crashes.push({ caller, reason })
    }
    search.port.close()
    for (let i = 0; i < 100 && way.replies.length === 0; i++) await tick(2)
    expect(answeredFirst).toBe(0)
    expect(code(way.replies[0])).toBe('crashed')
  })
})

describe('editor.reach', () => {
  function made() {
    const parts = harness()
    parts.gate.grants.alpha = [
      { type: 'luoshu.read', paths: ['notes/**'] },
      { type: 'luoshu.write', paths: ['notes/own/**'] },
      { type: 'ui.edit', paths: ['notes/edit/**'] },
      { type: 'ui.read', paths: ['shown/**'] },
      { type: 'ui.decoration' },
      { type: 'ui.command' },
    ]
    const way = windowWay(parts.carrier, { editor })
    return { ...parts, way }
  }

  // An edit through the editor needs ui.edit, never luoshu.write, so a plugin that writes notes edits none it wasn't
  // given ui.edit on
  it("answers what the gate gives the plugin for one note: read, edit and its ui items", async () => {
    const { way } = made()
    const reach = async (args: unknown) => (await way.ask('editor', 'editor.reach', args)).result
    const verbs = ['ui.decoration', 'ui.command']
    const no = { read: false, edit: false, uiRead: false, list: false }
    expect(await reach({ plugin: 'alpha', path: 'notes/edit/a.md' })).toEqual({ ...no, read: true, edit: true, list: true, verbs })
    expect(await reach({ plugin: 'alpha', path: 'notes/own/a.md' })).toEqual({ ...no, read: true, list: true, verbs })
    expect(await reach({ plugin: 'alpha', path: 'notes/b.md' })).toEqual({ ...no, read: true, list: true, verbs })
    // ui.read is no luoshu read and lists nothing: the drawer serves it for a note the human opened
    expect(await reach({ plugin: 'alpha', path: 'shown/a.md' })).toEqual({ ...no, uiRead: true, verbs })
    expect(await reach({ plugin: 'alpha', path: 'other.md' })).toEqual({ ...no, verbs })
    expect(await reach({ plugin: 'alpha' })).toEqual({ ...no, verbs })
    expect(await reach({ plugin: 'beta', path: 'notes/b.md' })).toEqual({ ...no, verbs: [] })
  })

  it("answers list from what the plugin may list, names it can't read included", async () => {
    const { way, gate } = made()
    gate.grants.alpha = [...gate.grants.alpha!, { type: 'luoshu.list', paths: ['names/**'] }]
    expect((await way.ask('editor', 'editor.reach', { plugin: 'alpha', path: 'names/a.md' })).result).toMatchObject({ read: false, list: true })
  })

  it('asks the gate about the plugin as the caller, at the canonical stage', async () => {
    const { way, gate } = made()
    await way.ask('editor', 'editor.reach', { plugin: 'alpha', path: 'notes/edit/a.md' })
    expect(gate.reads.at(-1)?.caller).toMatchObject({ kind: 'plugin', id: 'alpha' })
    expect(gate.asked.slice(-2)).toMatchObject([
      { stage: 'canonical', caller: { kind: 'plugin', id: 'alpha' }, action: 'editor.edit', capability: 'ui.edit', scope: { paths: ['notes/edit/a.md'] } },
      { stage: 'canonical', caller: { kind: 'plugin', id: 'alpha' }, action: 'editor.read', capability: 'ui.read', scope: { paths: ['notes/edit/a.md'] } },
    ])
  })

  it('counts an edit that would ask at first use as no edit', async () => {
    const { way, gate, pluginsManager } = made()
    gate.decision = () => ({ ask: 'item', view: pluginsManager.current })
    expect((await way.ask('editor', 'editor.reach', { plugin: 'alpha', path: 'notes/edit/a.md' })).result).toMatchObject({ read: true, edit: false })
  })

  it('answers every reach with the gate off and policy-down while it is failed or absent', async () => {
    const { way, pluginsManager } = made()
    pluginsManager.policyJobs.gate = 'off'
    expect((await way.ask('editor', 'editor.reach', { plugin: 'beta', path: 'x.md' })).result)
      .toEqual({ read: true, edit: true, uiRead: true, list: true, verbs: ['ui.view', 'ui.layout', 'ui.decoration', 'ui.command', 'ui.keys'] })
    for (const state of ['failed', 'absent'] as const) {
      pluginsManager.policyJobs.gate = state
      expect(code(await way.ask('editor', 'editor.reach', { plugin: 'alpha', path: 'notes/a.md' }))).toBe('policy-down')
    }
  })

  // No note the human opened has such a path. The contract's path schema refuses it at shape
  it.each(['on', 'off'] as const)('answers a reach for a path with a dot segment invalid whatever the gate says, with the gate %s', async state => {
    const { way, pluginsManager, gate } = made()
    gate.readable = () => true
    gate.listable = () => true
    gate.decision = () => ({ allow: true, view: pluginsManager.current })
    pluginsManager.policyJobs.gate = state
    for (const path of ['.obsidian/plugins/x/main.js', '.env', 'notes/.hidden.md', 'notes/edit/.config/x.md', '\u200c.obsidian/app.json']) {
      expect(code(await way.ask('editor', 'editor.reach', { plugin: 'alpha', path })), path).toBe('invalid')
    }
    expect((await way.ask('editor', 'editor.reach', { plugin: 'alpha', path: 'notes/edit/a.md' })).result).toMatchObject({ read: true, edit: true, list: true })
  })

  // As a direct call: with the gate off, a call with power passes only while its record can land
  it('answers policy-down with the gate off once the log has failed, and everything again with recording off', async () => {
    let now = 0
    const parts = harness({ clock: () => now })
    const way = windowWay(parts.carrier, { editor })
    parts.pluginsManager.policyJobs.gate = 'off'
    parts.log.failing = true
    const search = parts.connect(worker('search'))
    await search.ask('storage.get', { key: 'index' })
    now = 30_000
    expect(code(await way.ask('editor', 'editor.reach', { plugin: 'search', path: 'a.md' }))).toBe('policy-down')
    parts.pluginsManager.nothing = true
    expect((await way.ask('editor', 'editor.reach', { plugin: 'search', path: 'a.md' })).result).toMatchObject({ read: true, edit: true })
  })

  it('refuses policy-down and records a fault when the gate throws', async () => {
    const { way, gate, carrier, log } = made()
    gate.readable = () => { throw new Error('broken') }
    expect(code(await way.ask('editor', 'editor.reach', { plugin: 'alpha', path: 'notes/a.md' }))).toBe('policy-down')
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'gate', step: 'reach', count: 1 }])
  })

  it('answers windows only', async () => {
    const { connect } = made()
    const search = connect(worker('search'))
    expect(code(await search.ask('editor.reach', { plugin: 'alpha', path: 'notes/a.md' }))).toBe('not-granted')
  })
})
