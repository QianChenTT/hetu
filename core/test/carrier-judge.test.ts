import { afterEach, describe, expect, it } from 'vitest'
import type { Access, Call, GuardCall, Prepared } from '../api/slots.ts'
import { cleanup, FakeGuard, harness, worker } from './carrier-fakes.ts'

afterEach(cleanup)

type Judge = (paths: readonly string[]) => unknown

// A luoshu whose perform asks the call's judge about the paths given before it acts, as the real one does when a look
// at the disk reads a path otherwise than prepare did
function judging(paths: (prepared: Prepared) => readonly string[]) {
  const parts = harness()
  const answers: unknown[] = []
  const judges: (Judge | undefined)[] = []
  parts.luoshu.perform_ = (call: Call, prepared: Prepared) => {
    const judge = (call as Call & { judge?: Judge }).judge
    judges.push(judge)
    answers.push(judge?.(paths(prepared)))
    return null
  }
  return { ...parts, answers, judges }
}

const written = async (parts: ReturnType<typeof harness>) => {
  await parts.carrier.flush()
  return parts.log.events('audit.call').map(record => record.fields)
}

describe('the judge a call with power carries to its provider', () => {
  it('lets the call go on when the gate allows the new paths and moves the call\'s record to them', async () => {
    const parts = judging(() => ['other/a.md'])
    parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**', 'other/**'] }]
    expect((await parts.connect(worker('search')).ask('luoshu.read', { path: 'notes/a.md' })).ok).toBe(true)
    expect(parts.answers).toEqual([null])
    expect(parts.gate.asked.filter(access => access.stage === 'canonical').map(access => access.scope.paths)).toEqual([['notes/a.md'], ['other/a.md']])
    expect((await written(parts))[0]).toMatchObject({ action: 'luoshu.read', paths: '["other/a.md"]', code: null })
  })

  it('answers not-granted when the gate refuses the new paths and leaves the record on the paths judged first', async () => {
    const parts = judging(() => ['other/a.md'])
    parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**'] }]
    await parts.connect(worker('search')).ask('luoshu.read', { path: 'notes/a.md' })
    expect(parts.answers).toEqual([{ code: 'not-granted' }])
    expect((await written(parts))[0]).toMatchObject({ paths: '["notes/a.md"]' })
  })

  it('raises no prompt for an item that still asks at first use and answers not-granted', async () => {
    const parts = judging(() => ['other/a.md'])
    parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**'] }]
    parts.gate.decision = (access: Access) =>
      access.scope.paths?.[0] === 'other/a.md' ? { ask: 'luoshu.read other/**', view: 1 } : parts.gate.granted(access)
    await parts.connect(worker('search')).ask('luoshu.read', { path: 'notes/a.md' })
    expect(parts.answers).toEqual([{ code: 'not-granted' }])
    expect(parts.asks).toEqual([])
  })

  it('asks the guards on the new paths and answers their refusal', async () => {
    const guarded = harness({ guardsFor: () => ['leases'] })
    guarded.loader.slots.leases = 'on'
    guarded.guards.leases = new FakeGuard()
    guarded.guards.leases.answer = (call: GuardCall) => (call.scope.paths?.[0] === 'other/a.md' ? 'deny' : 'allow')
    guarded.gate.grants.mcp = [{ type: 'luoshu.write', paths: ['**'] }]
    const answers: unknown[] = []
    guarded.luoshu.perform_ = (call: Call) => {
      answers.push((call as Call & { judge?: Judge }).judge?.(['other/a.md']))
      return null
    }
    await guarded.connect(worker('mcp')).ask('luoshu.write', { path: 'notes/a.md', text: 'x' })
    expect(guarded.guards.leases.calls.map(call => call.scope.paths)).toEqual([['notes/a.md'], ['other/a.md']])
    expect(answers).toEqual([{ code: 'guard-refused' }])
  })

  it.each([
    ['none', []],
    ['one more', ['notes/a.md', 'notes/b.md']],
  ])('fails a second ask that names %s than prepare gave', async (_name, paths) => {
    const parts = judging(() => paths)
    parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    await parts.connect(worker('search')).ask('luoshu.read', { path: 'notes/a.md' })
    expect(parts.answers).toEqual([{ code: 'failed' }])
    expect(parts.gate.asked.filter(access => access.stage === 'canonical')).toHaveLength(1)
  })

  it('answers not-granted to a second ask once the call has ended', async () => {
    const parts = judging(prepared => prepared.scope.paths!)
    parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    await parts.connect(worker('search')).ask('luoshu.read', { path: 'notes/a.md' })
    expect(parts.judges[0]?.(['notes/b.md'])).toEqual({ code: 'not-granted' })
  })

  it('gives a call with no power no judge', async () => {
    const parts = harness()
    const calls: Call[] = []
    parts.providers.storage = {
      prepare: async () => ({ scope: {} }),
      perform: async (call: Call) => {
        calls.push(call)
        return null
      },
    }
    expect((await parts.connect(worker('search')).ask('storage.get', { key: 'k' })).ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect('judge' in calls[0]).toBe(false)
  })

  // Whatever the first judgement asks, the second asks too with only the paths changed: the gate on each requirement
  // with the same caller, onBehalf and action, then each guard with the same call
  it('asks the gate and the guards the same things on the second ask as on the first, with only the paths changed', async () => {
    const parts = harness({ guardsFor: () => ['leases', 'second'] })
    for (const id of ['leases', 'second']) {
      parts.loader.slots[id] = 'on'
      parts.guards[id] = new FakeGuard()
    }
    parts.gate.grants.mcp = [{ type: 'luoshu.write', paths: ['**'] }, { type: 'luoshu.read', paths: ['**'] }]
    parts.luoshu.files.set('notes/a.md', 'a')
    let first: { asked: number, guarded: number } | null = null
    parts.luoshu.perform_ = (call: Call) => {
      first = { asked: parts.gate.asked.length, guarded: parts.guards.leases.calls.length + parts.guards.second.calls.length }
      expect((call as Call & { judge?: Judge }).judge?.(['moved/a.md', 'moved/b.md'])).toBe(null)
      return null
    }
    const reply = await parts.connect(worker('mcp')).ask('luoshu.move', { from: 'notes/a.md', to: 'notes/b.md' }, { onBehalf: 'agent-a' })
    expect(reply.ok).toBe(true)
    const canonical = parts.gate.asked.slice(0, first!.asked).filter(access => access.stage === 'canonical')
    const again = parts.gate.asked.slice(first!.asked)
    const renamed = (paths: readonly string[] | undefined) => paths?.map(path => path.replace(/^notes\//, 'moved/'))
    expect(canonical.length).toBeGreaterThan(1)
    expect(again).toEqual(canonical.map(access => ({ ...access, scope: { ...access.scope, paths: renamed(access.scope.paths) } })))
    for (const id of ['leases', 'second']) {
      const [one, two] = parts.guards[id].calls
      expect(two).toEqual({ ...one, scope: { ...one.scope, paths: renamed(one.scope.paths) } })
    }
  })
})
