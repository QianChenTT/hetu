import { afterEach, describe, expect, it } from 'vitest'
import type { SecurityList } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import type { Call } from '../api/slots.ts'
import { StateStore } from '../backend/boot/state.ts'
import { allowAll, cleanup, coreInstall, filesFor, firstPartyEntry, harness, hashOf, hostManifest, workerManifest } from './loader-fakes.ts'

afterEach(cleanup)

const read: Capability = { type: 'luoshu.read', paths: ['**'] }
const inbox: Capability = { type: 'luoshu.read', paths: ['inbox/**'] }
const write: Capability = { type: 'luoshu.write', paths: ['inbox/**'] }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const mcpWorker: Caller = { kind: 'plugin', id: 'mcp', half: 'worker', incarnation: 1 }
const code = (work: Promise<unknown>) => work.then(() => null, (err: { code?: string }) => err.code ?? String(err))

// mcp as the install's own copy in the plugin folder, holding read on everything, the agents' items its entry is seeded
// with and a clock the test moves
async function started(over: { agents?: { agent: string, capability: Capability }[], revoked?: string[] } = {}) {
  const clock = { now: 1000 }
  const gate = allowAll()
  const mcp = filesFor(workerManifest('mcp', { capabilities: [read] }))
  const made = await harness({
    install: { ...coreInstall(), gate: { files: filesFor(hostManifest('gate')) }, mcp: { files: mcp, firstParty: true } },
    folder: { mcp },
    entries: { mcp: async root => firstPartyEntry(await hashOf(root), { granted: [read], class: 1, ...over }) },
    behave: { gate: { exports: { gate } } },
    loader: { clock: () => clock.now, confirmDelayMs: 0 },
  })
  await made.loader.start()
  let n = 0
  // core.agentAsk as the carrier hands it over once its floor passed: from mcp, on behalf of the chain's label
  const ask = (label: string, capabilities: Capability[]) => made.loader.serve({
    callId: `call-${++n}`, caller: mcpWorker, onBehalf: label, action: 'core.agentAsk', args: { capabilities }, deadline: Date.now() + 30_000,
  } as Call)
  const list = async () => await made.loader.serve({ callId: `list-${++n}`, caller: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 } as Call) as SecurityList
  const stored = async () => (await new StateStore(made.dataDir).load()).state.plugins.mcp
  return { ...made, gate, clock, ask, list, stored }
}

describe('an agent\'s ask', () => {
  it('raises a request of its own kind for the label the call carries and answers at once that it waits', async () => {
    const { loader, ask, list, stored, link } = await started()
    expect(await ask('client#1', [inbox, write])).toEqual({ asked: 'waiting' })
    const pending = loader.pending()
    expect(pending).toEqual([{ id: pending[0].id, kind: 'agent.ask', plugin: 'mcp' }])
    const shown = (await list()).requests[0]
    expect(shown.text).toBe('Give the agent "client#1" what it asks for through mcp')
    expect(shown.notes).toEqual([
      'It asks for: luoshu.read on "inbox/**"', 'It asks for: luoshu.write on "inbox/**"',
      'The agent reaches only what mcp holds as well', 'Revoke it from the agent list at any time',
    ])
    expect(shown.type).toBeNull()
    expect((await stored()).agents).toBeUndefined()
    expect(link.events('security.request')).toMatchObject([{ kind: 'agent.ask', target: 'mcp', window: 'core' }])
  })

  it('answers a second ask for the same items as the first and refuses a different ask while one waits', async () => {
    const { loader, ask } = await started()
    await ask('client#1', [inbox, write])
    expect(await ask('client#1', [write, { paths: ['inbox/**'], type: 'luoshu.read' }])).toEqual({ asked: 'waiting' })
    expect(loader.pending()).toHaveLength(1)
    expect(await code(ask('client#1', [inbox]))).toBe('throttled')
    expect(await code(ask('client#1', [read]))).toBe('throttled')
    expect(loader.pending()).toHaveLength(1)
  })

  it('holds one ask for each of two labels asking at once', async () => {
    const { loader, ask, list } = await started()
    await Promise.all([ask('client#1', [inbox]), ask('client#2', [write])])
    expect(loader.pending().map(one => one.kind)).toEqual(['agent.ask', 'agent.ask'])
    expect((await list()).requests.map(one => one.text).sort()).toEqual([
      'Give the agent "client#1" what it asks for through mcp', 'Give the agent "client#2" what it asks for through mcp',
    ])
  })

  it('refuses a label the human cancelled an ask of for a minute, then takes its ask again', async () => {
    const { loader, ask, clock } = await started()
    await ask('client#1', [inbox])
    await loader.cancel(loader.pending()[0].id)
    expect(await code(ask('client#1', [inbox]))).toBe('throttled')
    expect(await code(ask('client#1', [write]))).toBe('throttled')
    // Another label is not held back
    expect(await ask('client#2', [inbox])).toEqual({ asked: 'waiting' })
    clock.now += 59_999
    expect(await code(ask('client#1', [inbox]))).toBe('throttled')
    clock.now += 1
    expect(await ask('client#1', [inbox])).toEqual({ asked: 'waiting' })
  })

  it('quotes each scope as a widen does, a quote in it escaped', async () => {
    const { ask, list } = await started()
    await ask('https://claude.ai/oauth/claude-code-client-metadata#3', [{ type: 'luoshu.read', paths: ['say "yes"/**', 'a, b/**'] }, { type: 'plugin.call', targets: ['search'] }])
    const shown = (await list()).requests[0]
    expect(shown.text).toBe('Give the agent "https://claude.ai/oauth/claude-code-client-metadata#3" what it asks for through mcp')
    expect(shown.notes.slice(0, 2)).toEqual(['It asks for: luoshu.read on "say \\"yes\\"/**", "a, b/**"', 'It asks for: plugin.call to search'])
  })

  it('answers granted with no request for items the agent holds already', async () => {
    const { loader, ask } = await started({ agents: [{ agent: 'client#1', capability: inbox }] })
    expect(await ask('client#1', [inbox])).toEqual({ asked: 'granted' })
    expect(loader.pending()).toEqual([])
    // Only the items it lacks are asked for
    await ask('client#1', [inbox, write])
    expect(loader.pending()).toHaveLength(1)
  })

  it('refuses a label out of the agent label\'s form, which the carrier never hands over', async () => {
    const { loader, ask } = await started()
    expect(await code(ask('client', [inbox]))).toBe('invalid')
    expect(loader.pending()).toEqual([])
  })
})
