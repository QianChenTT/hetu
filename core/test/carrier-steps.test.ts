import { afterEach, describe, expect, it } from 'vitest'
import type { Access, GuardCall } from '../api/slots.ts'
import { cleanup, code, editor, FakeGuard, harness, tick, windowWay, worker } from './carrier-fakes.ts'

afterEach(cleanup)

const hash = 'a'.repeat(64)

describe('prepare before decide', () => {
  it('lets GIT~1 reach decide only after prepare, and decide sees only the canonical path', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('.git/config', '[core]\n\tfsmonitor = evil')
    const steps: string[] = []
    gate.decision = (access: Access) => {
      steps.push(`${access.stage} ${access.scope.paths?.join()}`)
      return gate.granted(access)
    }
    const prepare = luoshu.prepare.bind(luoshu)
    luoshu.prepare = async call => {
      steps.push('prepare')
      return prepare(call)
    }
    const reply = await connect(worker('search')).ask('luoshu.read', { path: 'GIT~1/config' })
    // The raw text matches ** and the canonical .git/config matches nothing
    expect(steps).toEqual(['raw GIT~1/config', 'prepare', 'canonical .git/config'])
    expect(reply.refusal).toEqual({ code: 'not-granted', action: 'luoshu.read' })
    expect(luoshu.performed).toEqual([])
    expect(luoshu.released).toHaveLength(1)
  })

  it('hands perform and release the copy the gate judged, not the object prepare gave', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**'] }]
    luoshu.files.set('notes/a.md', 'a')
    luoshu.files.set('secret/b.md', 'b')
    // An object that answers another path once it was judged
    let reads = 0
    luoshu.prepare = async () => ({
      get scope() {
        reads++
        return { paths: [reads === 1 ? 'notes/a.md' : 'secret/b.md'] }
      },
    })
    const released: unknown[] = []
    luoshu.release = (_call, prepared) => { released.push(prepared) }
    const search = connect(worker('search'))
    const reply = await search.ask('luoshu.read', { path: 'notes/a.md' })
    expect(reply.result).toEqual({ text: 'a' })
    expect(luoshu.performed[0].prepared.scope.paths).toEqual(['notes/a.md'])
    expect(Object.isFrozen(luoshu.performed[0].prepared)).toBe(true)

    // A refusal at decide, after prepare, releases the same copy
    gate.decision = access => (access.stage === 'canonical' ? { ...gate.granted(access), allow: false, code: 'not-granted' } as never : gate.granted(access))
    reads = 0
    await search.ask('luoshu.read', { path: 'notes/a.md' })
    expect(released).toHaveLength(1)
    expect((released[0] as { scope: { paths: string[] } }).scope.paths).toEqual(['notes/a.md'])
  })

  it('answers a provider\'s own refusal from prepare with its code and fixed reason only', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.prepare = async () => ({ code: 'invalid', reason: 'too-large', holder: 'mcp', path: 'secret/b.md' }) as never
    const reply = await connect(worker('search')).ask('luoshu.read', { path: 'a.md' })
    expect(reply.refusal).toEqual({ code: 'invalid', action: 'luoshu.read', reason: 'too-large' })
    expect(gate.asked.map(access => access.stage)).toEqual(['raw'])
  })

  // Text such as held by mcp agent-a would hand the caller another principal's id or path (the A-05 lesson)
  it('drops a provider reason outside the fixed list', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.prepare = async () => ({ code: 'not-granted', reason: 'leased by mcp' }) as never
    expect((await connect(worker('search')).ask('luoshu.read', { path: 'a.md' })).refusal).toEqual({ code: 'not-granted', action: 'luoshu.read' })
  })

  it.each([
    ['a code outside the list', { code: 'forbidden' }],
    ['no scope', { baseVersion: hash }],
    ['paths that are not text', { scope: { paths: [1] } }],
    ['paths with one that is not text', { scope: { paths: ['a.md', 1] } }],
    ['a target that is not text', { scope: { paths: ['a.md'], target: 7 } }],
    ['a baseVersion that is not text', { scope: { paths: ['a.md'] }, baseVersion: 7 }],
  ])('fails a call whose prepare gave %s', async (_name, given) => {
    const { connect, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.prepare = async () => given as never
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('failed')
    expect(luoshu.performed).toEqual([])
    // The gate and the guards only ever judge text
    expect(gate.asked.map(access => access.stage)).toEqual(['raw'])
  })

  it('turns an ask into needs-confirm with the request the prompt holds', async () => {
    const { connect, gate, asks, luoshu } = harness()
    gate.decision = access => access.stage === 'raw' ? { allow: true, view: 1 } : { ask: 'luoshu.read notes/**', view: 1 }
    const reply = await connect(worker('search')).ask('luoshu.read', { path: 'notes/a.md' }, { onBehalf: 'agent-a' })
    expect(reply.refusal).toEqual({ code: 'needs-confirm', action: 'luoshu.read', request: 'req-1' })
    expect(asks).toHaveLength(1)
    expect(asks[0].ask).toBe('luoshu.read notes/**')
    expect(asks[0].access).toMatchObject({ stage: 'canonical', caller: worker('search'), scope: { paths: ['notes/a.md'] } })
    expect(luoshu.performed).toEqual([])
    expect(luoshu.released).toHaveLength(1)
  })

  // Fits none of the Decision shapes. A prompt the human could Confirm would follow a call the gate refused
  it('raises no prompt for an answer that says allow: false beside an ask', async () => {
    const { connect, gate, asks } = harness()
    gate.decision = access => access.stage === 'raw' ? { allow: true, view: 1 } : { allow: false, code: 'not-granted', ask: 'luoshu.read **', view: 1 }
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('not-granted')
    expect(asks).toEqual([])
  })

  it.each([
    ['no prompt to raise', undefined],
    ['a prompt that throws', { raise: () => { throw new Error('no window') } }],
    ['a request id outside the grammar', { raise: () => 'a b' }],
  ])('refuses an ask not-granted with %s', async (_name, asks) => {
    const { connect, gate } = harness({ asks })
    gate.decision = access => access.stage === 'raw' ? { allow: true, view: 1 } : { ask: 'x', view: 1 }
    expect((await connect(worker('search')).ask('luoshu.read', { path: 'a.md' })).refusal).toEqual({ code: 'not-granted', action: 'luoshu.read' })
  })

  it('passes onBehalf to the provider, the gate and the guards, and the decision never changes with it', async () => {
    const { connect, gate, guards, loader, luoshu } = harness({ guardsFor: () => ['leases'] })
    loader.slots.leases = 'on'
    guards.leases = new FakeGuard()
    gate.grants.mcp = [{ type: 'luoshu.write', paths: ['notes/**'] }]
    const mcp = connect(worker('mcp'))
    const reply = await mcp.ask('luoshu.write', { path: 'notes/a.md', text: 'x' }, { onBehalf: 'agent-b' })
    expect(reply.ok).toBe(true)
    expect(luoshu.performed[0].call.onBehalf).toBe('agent-b')
    expect(guards.leases.calls[0].onBehalf).toBe('agent-b')
    expect(gate.asked.map(access => access.onBehalf)).toEqual(['agent-b', 'agent-b'])
    expect(code(await mcp.ask('luoshu.write', { path: 'secret/a.md', text: 'x' }, { onBehalf: 'admin' }))).toBe('not-granted')
  })
})

describe('guards', () => {
  const setup = (order = ['leases', 'second']) => {
    const parts = harness({ guardsFor: () => order })
    const { loader, guards, gate } = parts
    for (const id of order) {
      loader.slots[id] = 'on'
      guards[id] = new FakeGuard()
    }
    gate.grants.mcp = [{ type: 'luoshu.write', paths: ['notes/**'] }]
    return parts
  }

  it('asks every expected guard in a fixed order with a GuardCall that carries no arguments', async () => {
    const { connect, guards } = setup()
    const asked: string[] = []
    guards.leases.answer = () => { asked.push('leases'); return 'allow' }
    guards.second.answer = () => { asked.push('second'); return 'allow' }
    const reply = await connect(worker('mcp')).ask('luoshu.write', { path: 'notes/a.md', text: 'secret text', baseVersion: hash })
    expect(reply.ok).toBe(true)
    expect(asked).toEqual(['leases', 'second'])
    const call: GuardCall = guards.leases.calls[0]
    expect(Object.keys(call).sort()).toEqual(['action', 'baseVersion', 'callId', 'caller', 'scope'])
    expect(call).toMatchObject({ action: 'luoshu.write', caller: worker('mcp'), scope: { paths: ['notes/a.md'] }, baseVersion: hash })
    expect(JSON.stringify(guards.leases.calls)).not.toContain('secret text')
    expect(Object.isFrozen(call)).toBe(true)
  })

  it('skips a guard the human switched off and asks the rest', async () => {
    const { connect, guards, loader } = setup()
    loader.slots.leases = 'off'
    expect((await connect(worker('mcp')).ask('luoshu.write', { path: 'notes/a.md', text: 'x' })).ok).toBe(true)
    expect(guards.leases.calls).toEqual([])
    expect(guards.second.calls).toHaveLength(1)
  })

  it('answers starting while a guard starts', async () => {
    const { connect, loader, luoshu } = setup()
    loader.slots.second = 'starting'
    expect(code(await connect(worker('mcp')).ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))).toBe('starting')
    expect(luoshu.performed).toEqual([])
  })

  it.each(['failed', 'absent', 'tampered'] as const)('answers guard-down for every writer while a guard is %s, the human included', async state => {
    const { carrier, connect, loader, luoshu, guards } = setup()
    loader.slots.leases = state
    expect(code(await connect(worker('mcp')).ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))).toBe('guard-down')
    const way = windowWay(carrier, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'luoshu.write', { path: 'notes/a.md', text: 'x' }))).toBe('guard-down')
    expect(guards.second.calls).toEqual([])
    expect(luoshu.performed).toEqual([])
    expect(luoshu.released).toHaveLength(2)
  })

  it('answers guard-down for a guard that is on with no holder to ask', async () => {
    const { connect, guards } = setup()
    delete (guards as Record<string, unknown>).second
    expect(code(await connect(worker('mcp')).ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))).toBe('guard-down')
  })

  it.each([
    ['deny', 'guard-refused'],
    ['Allow', 'guard-down'],
    [true, 'guard-down'],
    [undefined, 'guard-down'],
  ])('answers %j with %s', async (answer, expected) => {
    const { connect, guards, luoshu } = setup()
    guards.leases.answer = () => answer
    expect(code(await connect(worker('mcp')).ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))).toBe(expected)
    expect(guards.second.calls).toEqual([])
    expect(luoshu.performed).toEqual([])
  })

  it('counts a promise as no answer, since a host guard answers from its own state', async () => {
    const { connect, guards } = setup()
    guards.leases.answer = async () => 'allow'
    expect(code(await connect(worker('mcp')).ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))).toBe('guard-down')
  })

  it('counts a throw as guard-down and records the fault', async () => {
    const { carrier, connect, guards, log, debug } = setup()
    guards.leases.answer = () => { throw new Error('table broke') }
    expect(code(await connect(worker('mcp')).ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))).toBe('guard-down')
    expect(debug.map(entry => [entry.plugin, entry.text])).toEqual([['leases', 'table broke']])
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'leases', step: 'guard', count: 1 }])
  })

  // GIT~1/config prepares to .git/config, which no scope matches
  it('asks no guard about a call decide refused', async () => {
    const { connect, gate, guards } = setup()
    gate.grants.mcp = [{ type: 'luoshu.write', paths: ['**'] }]
    expect(code(await connect(worker('mcp')).ask('luoshu.write', { path: 'GIT~1/config', text: 'x' }))).toBe('not-granted')
    expect(guards.leases.calls).toEqual([])
    expect(guards.second.calls).toEqual([])
  })

  it('times the answer once it returns and counts one past the limit as guard-down, a late allow included', async () => {
    let clock = 1_000_000
    const parts = harness({ guardsFor: () => ['leases'], clock: () => clock })
    const { connect, guards, loader, gate, luoshu } = parts
    loader.slots.leases = 'on'
    guards.leases = new FakeGuard()
    gate.grants.mcp = [{ type: 'luoshu.write', paths: ['notes/**'] }]
    const mcp = connect(worker('mcp'))
    guards.leases.answer = () => { clock += 2000; return 'allow' }
    expect((await mcp.ask('luoshu.write', { path: 'notes/a.md', text: 'x' })).ok).toBe(true)
    guards.leases.answer = () => { clock += 2001; return 'allow' }
    expect(code(await mcp.ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))).toBe('guard-down')
    expect(luoshu.performed).toHaveLength(1)
    await tick()
    expect(parts.log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'leases', step: 'guard-late', count: 1 }])
    // Only the human raises a guard's limit
    loader.human.plugins.leases = { guardAnswerMs: 5000 }
    guards.leases.answer = () => { clock += 4000; return 'allow' }
    expect((await mcp.ask('luoshu.write', { path: 'notes/a.md', text: 'x' })).ok).toBe(true)
  })

  it('times the answer on a clock the wall clock does not move', async () => {
    let wall = Date.now()
    const { connect, guards, loader, gate } = harness({ guardsFor: () => ['leases'], now: () => wall })
    loader.slots.leases = 'on'
    guards.leases = new FakeGuard()
    gate.grants.mcp = [{ type: 'luoshu.write', paths: ['notes/**'] }]
    guards.leases.answer = () => { wall += 60000; return 'allow' }
    expect((await connect(worker('mcp')).ask('luoshu.write', { path: 'notes/a.md', text: 'x' })).ok).toBe(true)
  })

  it('still holds every guard with the gate off', async () => {
    const { connect, loader, guards } = setup()
    loader.slots.gate = 'off'
    guards.second.answer = () => 'deny'
    expect(code(await connect(worker('mcp')).ask('luoshu.write', { path: 'secret/a.md', text: 'x' }))).toBe('guard-refused')
  })

  it('asks no guard for an action that is not guardable', async () => {
    const { connect, guards, gate, luoshu } = setup()
    gate.grants.mcp.push({ type: 'luoshu.read', paths: ['**'] })
    luoshu.files.set('notes/a.md', 'x')
    expect((await connect(worker('mcp')).ask('luoshu.read', { path: 'notes/a.md' })).ok).toBe(true)
    expect(guards.leases.calls).toEqual([])
  })
})

describe('perform', () => {
  it('answers not-found only once decide allowed the call', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**'] }]
    const search = connect(worker('search'))
    expect(code(await search.ask('luoshu.read', { path: 'notes/missing.md' }))).toBe('not-found')
    expect(code(await search.ask('luoshu.read', { path: 'secret/missing.md' }))).toBe('not-granted')
    expect(luoshu.performed).toHaveLength(1)
  })

  it('maps a thrown error to failed and sends its text to debug only', async () => {
    const { carrier, connect, gate, luoshu, debug, log } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.perform_ = () => { throw new Error('EACCES: permission denied, open /Users/han/luoshu/secret.md') }
    const reply = await connect(worker('search')).ask('luoshu.read', { path: 'a.md' })
    expect(reply.refusal).toEqual({ code: 'failed', action: 'luoshu.read' })
    expect(JSON.stringify(reply)).not.toContain('EACCES')
    // The provider's text, for the provider's own debug and never the caller's
    expect(debug).toEqual([{ plugin: 'luoshu', caller: worker('search'), action: 'luoshu.read', text: 'EACCES: permission denied, open /Users/han/luoshu/secret.md' }])
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'luoshu', step: 'perform', count: 1 }])
  })

  it('records a throw in prepare as a fault at prepare', async () => {
    const { carrier, connect, gate, luoshu, debug, log } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    luoshu.prepare = async () => { throw new Error('ENOENT: no such file, lstat /Users/han/luoshu/a.md') }
    expect(code(await connect(worker('search')).ask('luoshu.read', { path: 'a.md' }))).toBe('failed')
    expect(debug.map(entry => [entry.plugin, entry.text])).toEqual([['luoshu', 'ENOENT: no such file, lstat /Users/han/luoshu/a.md']])
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'luoshu', step: 'prepare', count: 1 }])
  })

  it('keeps a thrown refusal\'s code and fixed reason and nothing else', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.search = [{ type: 'luoshu.write', paths: ['**'] }]
    luoshu.perform_ = () => { throw { code: 'stale', reason: 'declined', current: hash, path: 'other/a.md' } }
    const reply = await connect(worker('search')).ask('luoshu.write', { path: 'a.md', text: 'x' })
    expect(reply.refusal).toEqual({ code: 'stale', action: 'luoshu.write', reason: 'declined' })
  })

  it('fails a result past the producer\'s cap with too-large and a result that is not plain data', async () => {
    const { connect, gate, luoshu, loader } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    loader.human.plugins.luoshu = { resultBytes: 100 }
    luoshu.perform_ = () => ({ text: 'x'.repeat(200) })
    const search = connect(worker('search'))
    expect((await search.ask('luoshu.read', { path: 'a.md' })).refusal).toEqual({ code: 'failed', action: 'luoshu.read', reason: 'too-large' })
    luoshu.perform_ = () => ({ when: new Date(0) })
    expect((await search.ask('luoshu.read', { path: 'a.md' })).refusal).toEqual({ code: 'failed', action: 'luoshu.read' })
    luoshu.perform_ = () => ({ text: 'x'.repeat(50) })
    expect((await search.ask('luoshu.read', { path: 'a.md' })).ok).toBe(true)
  })

  it('answers unavailable for a provider that is off, failed or gone and starting for one that starts', async () => {
    const { connect, loader, gate } = harness()
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    const search = connect(worker('search'))
    for (const state of ['off', 'failed', 'stopped'] as const) {
      loader.installed('luoshu', state)
      expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('unavailable')
    }
    loader.installed('luoshu', 'starting')
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('starting')
    delete loader.plugins.luoshu
    expect(code(await search.ask('luoshu.read', { path: 'a.md' }))).toBe('unavailable')
  })
})
