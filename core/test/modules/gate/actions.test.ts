import { describe, expect, it } from 'vitest'
import type { Caller } from '../../../api/envelope.ts'
import type { Call, Decision, Gate, LiveCall, PluginTable, PolicyJobState } from '../../../api/policy-jobs.ts'
import { createGateActions } from '../../../backend/policy/gate/actions.ts'

const search: Caller = { kind: 'plugin', id: 'search', half: 'worker', incarnation: 1 }
const word: Caller = { kind: 'plugin', id: 'word-count', half: 'worker', incarnation: 1 }

// A gate that reads what its readers hold by plugin id and decides allow on view 1 for ui.edit under notes/
function fakeGate(readable: Record<string, string[]>): Gate & { reads: number } {
  const gate = {
    reads: 0,
    decide: (access: { capability: string, scope: { paths?: readonly string[] } }): Decision =>
      access.capability === 'ui.edit' && access.scope.paths?.[0]?.startsWith('notes/') ? { allow: true, view: 1 } : { allow: false, code: 'not-granted', view: 1 },
    canRead: (caller: Caller, path: string) => {
      gate.reads++
      return caller.kind === 'plugin' && (readable[caller.id] ?? []).includes(path)
    },
    canList: () => false,
    verbs: () => ['ui.view'],
    stateChanged: () => {},
  }
  return gate as unknown as Gate & { reads: number }
}

function made(over: { state?: PolicyJobState, gate?: Gate | null, budget?: number, clock?: () => number, stopping?: boolean } = {}) {
  const faults: string[] = []
  let state = over.state ?? 'on'
  let view = 1
  const table = { policyJob: () => state, view: () => view } as unknown as PluginTable
  const gate = over.gate === undefined ? fakeGate({ search: ['notes/a.md', 'notes/b.md'], 'word-count': ['notes/a.md'] }) : over.gate
  const actions = createGateActions({
    gate: () => gate, table: () => table, stopping: () => over.stopping ?? false, limit: () => over.budget ?? 100,
    clock: over.clock ?? (() => performance.now()), fault: step => { faults.push(step) },
  })
  return { actions, gate, faults, set: (next: PolicyJobState) => { state = next }, bump: () => { view++ } }
}

const live = (open = true): LiveCall => ({ caller: word, principal: 'plugin:word-count', plugin: 'word-count', root: word, open: () => open })
const filter = (paths: string[], view: LiveCall | null = live()): Call =>
  ({ callId: 'c1', caller: search, root: search, action: 'gate.filterReadable', args: { call: 'x', paths }, deadline: Date.now() + 30_000, ...(view !== null ? { live: view } : {}) })
const reach = (path?: string): Call =>
  ({ callId: 'c2', caller: { kind: 'window', role: 'editor', n: 1 }, root: { kind: 'window', role: 'editor', n: 1 }, action: 'gate.reach', args: { plugin: 'search', ...(path ? { path } : {}) }, deadline: Date.now() + 30_000 })

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise
    return null
  } catch (err) {
    return (err as { code: string }).code
  }
}

describe('the gate module\'s actions', () => {
  it('gives back the paths both the callee and the live call\'s caller may read', async () => {
    const { actions } = made()
    expect(await actions.serve(filter(['notes/a.md', 'notes/b.md', 'notes/c.md']))).toEqual(['notes/a.md'])
  })

  it('refuses invalid for a live call that ended or none handed in', async () => {
    const { actions } = made()
    expect(await refusal(actions.serve(filter(['notes/a.md'], live(false))))).toBe('invalid')
    expect(await refusal(actions.serve(filter(['notes/a.md'], null)))).toBe('invalid')
  })

  it('answers with the gate off: every path given back but a dot one, reach everything', async () => {
    const { actions } = made({ state: 'off', gate: null })
    expect(await actions.serve(filter(['notes/z.md', '.git/config']))).toEqual(['notes/z.md'])
    expect(await actions.serve(reach('notes/a.md'))).toMatchObject({ read: true, edit: true, uiRead: true, list: true })
    expect(await actions.serve(reach())).toMatchObject({ read: false, edit: false })
  })

  // A store from an older build may hold a dot path, which no caller gets back whatever the gate says of it
  it.each(['on', 'off'] as const)('drops every path with a dot segment with the gate %s and gives back the others', async state => {
    const dotted = ['.obsidian/app.json', 'notes/.hidden.md', 'notes/b/.git/config', 'notes/./a.md']
    const gate = fakeGate({ search: ['notes/a.md', 'notes/b.md', ...dotted], 'word-count': ['notes/a.md', 'notes/b.md', ...dotted] })
    const { actions } = made({ state, gate })
    expect(await actions.serve(filter(['notes/a.md', ...dotted, 'notes/b.md']))).toEqual(['notes/a.md', 'notes/b.md'])
  })

  it.each(['starting', 'failed', 'absent'] as const)('refuses stopped while the gate is %s once shutdown began', async state => {
    const { actions } = made({ state, stopping: true })
    expect(await refusal(actions.serve(filter(['notes/a.md'])))).toBe('stopped')
    expect(await refusal(actions.serve(reach('notes/a.md')))).toBe('stopped')
  })

  // As at the router, a gate that throws answers as a fault whatever the time
  it('refuses policy-down with a fault when the gate throws once shutdown began', async () => {
    const gate = fakeGate({ search: ['notes/a.md'], 'word-count': ['notes/a.md'] })
    const { actions, faults } = made({ gate, stopping: true })
    gate.canRead = () => { throw new Error('boom') }
    expect(await refusal(actions.serve(filter(['notes/a.md'])))).toBe('policy-down')
    expect(await refusal(actions.serve(reach('notes/a.md')))).toBe('policy-down')
    expect(faults).toEqual(['canRead', 'reach'])
  })

  it.each(['starting', 'failed', 'absent'] as const)('refuses policy-down while the gate is %s', async state => {
    const { actions } = made({ state })
    expect(await refusal(actions.serve(filter(['notes/a.md'])))).toBe('policy-down')
    expect(await refusal(actions.serve(reach('notes/a.md')))).toBe('policy-down')
  })

  it('refuses that one call policy-down with a fault when the gate throws, then answers the next', async () => {
    const gate = fakeGate({ search: ['notes/a.md'], 'word-count': ['notes/a.md'] })
    const { actions, faults } = made({ gate })
    const canRead = gate.canRead
    gate.canRead = () => { throw new Error('boom') }
    expect(await refusal(actions.serve(filter(['notes/a.md'])))).toBe('policy-down')
    expect(await refusal(actions.serve(reach('notes/a.md')))).toBe('policy-down')
    expect(faults).toEqual(['canRead', 'reach'])
    gate.canRead = canRead
    expect(await actions.serve(filter(['notes/a.md']))).toEqual(['notes/a.md'])
    expect(await actions.serve(reach('notes/a.md'))).toEqual({ read: true, edit: true, uiRead: false, list: false, verbs: ['ui.view'] })
  })

  it('counts the gate\'s time against the live call\'s caller and goes on from where a throttled call stopped', async () => {
    let now = 0
    const gate = fakeGate({ search: ['notes/a.md', 'notes/b.md', 'notes/c.md'], 'word-count': ['notes/a.md', 'notes/c.md'] })
    const slow = gate.canRead
    gate.canRead = (caller, path) => { now += 10; return slow(caller, path) }
    const { actions } = made({ gate, budget: 25, clock: () => now })
    const view = live()
    const paths = ['notes/a.md', 'notes/b.md', 'notes/c.md']
    expect(await refusal(actions.serve(filter(paths, view)))).toBe('throttled')
    expect(actions.time.spent('plugin:word-count', 'word-count')).toBe(true)
    expect(actions.time.spent('plugin:search', 'search')).toBe(false)
    now += 1000
    const asked = gate.reads
    expect(await actions.serve(filter(paths, view))).toEqual(['notes/a.md', 'notes/c.md'])
    // Only the paths not yet asked about were asked again
    expect(gate.reads - asked).toBeLessThan(4)
  })

  it('drops the progress once the grants snapshot moved, so no answer from before a narrowing stands', async () => {
    let now = 0
    const gate = fakeGate({ search: ['notes/a.md', 'notes/b.md'], 'word-count': ['notes/a.md', 'notes/b.md'] })
    const slow = gate.canRead
    gate.canRead = (caller, path) => { now += 10; return slow(caller, path) }
    const { actions, bump } = made({ gate, budget: 15, clock: () => now })
    const view = live()
    const paths = ['notes/a.md', 'notes/b.md']
    expect(await refusal(actions.serve(filter(paths, view)))).toBe('throttled')
    bump()
    now += 1000
    const asked = gate.reads
    expect(await refusal(actions.serve(filter(paths, view)))).toBe('throttled')
    // Asked about the first path again rather than going on from the second
    expect(gate.reads - asked).toBe(2)
  })

  it('charges a listing\'s gate time to the same second', () => {
    const { actions } = made({ budget: 50 })
    actions.time.charge('plugin:search', 49)
    expect(actions.time.spent('plugin:search', 'search')).toBe(false)
    actions.time.charge('plugin:search', 1)
    expect(actions.time.spent('plugin:search', 'search')).toBe(true)
  })
})
