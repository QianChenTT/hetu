import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Call, GuardCall, Prepared } from '../api/slots.ts'
import { createHistory } from '../../core-plugins/history/src/history.ts'
import { createLuoshu } from '../../core-plugins/luoshu/src/luoshu.ts'
import { cleanup, FakeGuard, harness, worker } from './carrier-fakes.ts'

const bases: string[] = []

afterEach(async () => {
  await cleanup()
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true })
})

type Case = {
  grants?: string[]
  guard?: (call: GuardCall) => 'allow' | 'deny'
  // What changes in the gate's slot between the first judgement and the second ask
  slot?: 'off' | 'failed' | 'starting' | 'absent' | 'tampered'
}

// The real carrier and the real luoshu with a fake gate and guard. Another program renames the folder plain to Plain
// between prepare and perform, so the luoshu asks the call's judge about Plain/<name>
async function renamedFolder(action: 'luoshu.read' | 'luoshu.write', name: string, given: Case) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-second-ask-')))
  bases.push(base)
  const folder = path.join(base, 'notes')
  await mkdir(path.join(folder, 'plain'), { recursive: true })
  for (const dir of ['data', 'install']) await mkdir(path.join(base, dir))
  await writeFile(path.join(folder, 'plain', 'b.md'), 'note b')
  const luoshu = createLuoshu({ settleMs: 50 })
  luoshu.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
  const parts = harness({ guardsFor: () => (given.guard ? ['leases'] : []) })
  if (given.guard) {
    parts.loader.slots.leases = 'on'
    parts.guards.leases = new FakeGuard()
    parts.guards.leases.answer = given.guard
  }
  const paths = given.grants ?? ['plain/**']
  parts.gate.grants.search = [{ type: 'luoshu.read', paths }, { type: 'luoshu.write', paths }] as never
  parts.providers.luoshu = {
    prepare: luoshu.provider.prepare,
    release: luoshu.provider.release,
    perform: async (call: Call, prepared: Prepared) => {
      await rename(path.join(folder, 'plain'), path.join(folder, 'Plain'))
      if (given.slot !== undefined) parts.loader.slots.gate = given.slot
      return luoshu.provider.perform(call, prepared)
    },
  }
  const reply = await parts.connect(worker('search')).ask(action, action === 'luoshu.read' ? { path: `plain/${name}` } : { path: `plain/${name}`, text: 'x' })
  await parts.carrier.flush()
  luoshu.close()
  const records = parts.log.events('audit.call').map(record => record.fields as Record<string, unknown>)
  return { reply, records }
}

const refusal = (reply: unknown) => {
  const answer = reply as { ok?: boolean, refusal?: { code: string } }
  return answer.ok === true ? 'ok' : answer.refusal?.code
}

// Windows and macOS read two cases of one folder name as one folder
describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('a call refused on its second ask', () => {
  it('answers not-granted and records the path refused when the gate refuses it', async () => {
    const { reply, records } = await renamedFolder('luoshu.read', 'b.md', {})
    expect(refusal(reply)).toBe('not-granted')
    expect(records).toMatchObject([{ action: 'luoshu.read', paths: '["Plain/b.md"]', code: 'not-granted' }])
  })

  it('answers guard-refused and records the path and the guard\'s code when a guard refuses it', async () => {
    const { reply, records } = await renamedFolder('luoshu.write', 'c.md', {
      grants: ['plain/**', 'Plain/**'],
      guard: call => (call.scope.paths?.[0]?.startsWith('Plain/') ? 'deny' : 'allow'),
    })
    expect(refusal(reply)).toBe('guard-refused')
    expect(records).toMatchObject([{ action: 'luoshu.write', paths: '["Plain/c.md"]', code: 'guard-refused' }])
  })

  it.each([
    ['failed', 'policy-down'],
    ['absent', 'policy-down'],
    ['tampered', 'policy-down'],
    ['starting', 'starting'],
  ] as const)('answers %s gate on the second ask with %s and records it', async (slot, code) => {
    const { reply, records } = await renamedFolder('luoshu.read', 'b.md', { slot })
    expect(refusal(reply)).toBe(code)
    expect(records).toMatchObject([{ paths: '["Plain/b.md"]', code }])
  })

  it('lets the call on when the human switched the gate off before the second ask, as the first judgement would', async () => {
    const { reply, records } = await renamedFolder('luoshu.read', 'b.md', { slot: 'off' })
    expect(reply).toMatchObject({ ok: true, result: { text: 'note b', path: 'Plain/b.md' } })
    expect(records).toMatchObject([{ paths: '["Plain/b.md"]', code: null }])
  })
})

type Judge = (paths: readonly string[]) => unknown

describe('the record of a second ask', () => {
  it('names the paths of the last ask, refused after one allowed, with the code the provider passes on', async () => {
    const parts = harness()
    parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**', 'x/**'] }]
    parts.luoshu.files.set('notes/a.md', 'A')
    const answers: unknown[] = []
    parts.luoshu.perform_ = (call: Call) => {
      const judge = (call as Call & { judge?: Judge }).judge!
      answers.push(judge(['x/1.md']))
      const second = judge(['secret/2.md'])
      answers.push(second)
      throw second
    }
    const reply = await parts.connect(worker('search')).ask('luoshu.read', { path: 'notes/a.md' })
    expect(answers).toEqual([null, { code: 'not-granted' }])
    expect(reply.ok).toBe(false)
    await parts.carrier.flush()
    expect(parts.log.events('audit.call').map(record => record.fields)).toMatchObject([{ paths: '["secret/2.md"]', code: 'not-granted' }])
  })

  it('stays on the paths prepare gave for a second ask that fails on its shape', async () => {
    const parts = harness()
    parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    parts.luoshu.files.set('notes/a.md', 'A')
    parts.luoshu.perform_ = (call: Call) => {
      throw (call as Call & { judge?: Judge }).judge!(['notes/a.md', 'notes/b.md'])
    }
    await parts.connect(worker('search')).ask('luoshu.read', { path: 'notes/a.md' })
    await parts.carrier.flush()
    expect(parts.log.events('audit.call').map(record => record.fields)).toMatchObject([{ paths: '["notes/a.md"]', code: 'failed' }])
  })
})

// Windows and macOS read two cases of one name as one file
describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('a history commit refused on its second ask', () => {
  it.each([
    ['the gate refuses the other case', undefined, 'not-granted'],
    ['the gate failed', 'failed', 'policy-down'],
    ['the gate is starting', 'starting', 'starting'],
  ] as const)('passes the judge\'s code on when %s', async (_name, slot, code) => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-second-ask-')))
    bases.push(base)
    const folder = path.join(base, 'notes')
    const dataDir = path.join(base, 'data')
    for (const dir of [path.join(folder, 'box'), dataDir, path.join(base, 'install')]) await mkdir(dir, { recursive: true })
    const history = createHistory()
    await history.start(dataDir)
    history.role.open({ folder, dataDir, installDir: path.join(base, 'install') })
    const parts = harness()
    parts.loader.installed('history')
    parts.gate.grants.search = [{ type: 'history', access: 'commit', paths: ['box/n.md'] }] as never
    parts.providers.history = {
      prepare: history.provider.prepare,
      release: history.provider.release,
      perform: async (call: Call, prepared: Prepared) => {
        await writeFile(path.join(folder, 'box', 'N.md'), 'OTHER NOTE')
        if (slot !== undefined) parts.loader.slots.gate = slot
        return history.provider.perform(call, prepared)
      },
    }
    const reply = await parts.connect(worker('search')).ask('history.commit', { paths: ['box/n.md'], message: 'mine' })
    history.close()
    expect(refusal(reply)).toBe(code)
    await parts.carrier.flush()
    expect(parts.log.events('audit.call').map(record => record.fields)).toMatchObject([{ action: 'history.commit', paths: '["box/N.md"]', code }])
  }, 20_000)
})
