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
// with, http as the install's utility plugin and a clock the test moves
async function started(over: { agents?: { agent: string, capability: Capability }[], revoked?: string[] } = {}) {
  const clock = { now: 1000 }
  const gate = allowAll()
  const mcp = filesFor(workerManifest('mcp', { capabilities: [read] }))
  const made = await harness({
    install: {
      ...coreInstall(), gate: { files: filesFor(hostManifest('gate')) }, mcp: { files: mcp, firstParty: true },
      http: { files: filesFor(hostManifest('http', { capabilities: [{ type: 'plugin.call', targets: ['mcp'] }] })) },
    },
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

describe('the Confirm of an agent\'s ask', () => {
  const item = (capability: Capability) => ({ capability, off: false, firstUse: false })

  it('adds the items to that label\'s on mcp\'s entry beside granted and hands the gate the next StateView', async () => {
    const { loader, ask, stored, gate, link } = await started({ agents: [{ agent: 'client#1', capability: inbox }, { agent: 'client#10', capability: inbox }] })
    await ask('client#1', [write, inbox])
    await loader.confirm(loader.pending()[0].id, {})
    const entry = await stored()
    expect(entry.granted).toEqual([read])
    expect(entry.agents).toEqual([
      { agent: 'client#1', capability: inbox }, { agent: 'client#10', capability: inbox }, { agent: 'client#1', capability: write },
    ])
    const view = gate.seen.at(-1)!
    expect(view.agents).toEqual({ 'client#1': [item(inbox), item(write)], 'client#10': [item(inbox)] })
    expect(view.plugins.mcp).toEqual([item(read)])
    expect(loader.pending()).toEqual([])
    expect(link.events('security.applied')).toMatchObject([{ kind: 'agent.ask', target: 'mcp', by: 'confirm' }])
  })

  it('writes and shows an item of a type the tool table never maps, as the entry takes any type', async () => {
    const { loader, ask, list, stored } = await started()
    const fetch: Capability = { type: 'net.fetch', hosts: ['example.com'] }
    await ask('client#1', [fetch])
    expect((await list()).requests[0].notes[0]).toBe('It asks for: net.fetch to "example.com"')
    await loader.confirm(loader.pending()[0].id, {})
    expect((await stored()).agents).toEqual([{ agent: 'client#1', capability: fetch }])
  })

  it('refuses as stale an ask another write of mcp\'s entry came after, and the agent asks again', async () => {
    const { loader, ask, stored, link } = await started()
    await ask('client#1', [inbox])
    await ask('client#2', [write])
    const [one, two] = loader.pending()
    await loader.confirm(one.id, {})
    expect(await code(loader.confirm(two.id, {}))).toBe('stale')
    expect(loader.pending()).toEqual([])
    expect(link.events('security.stale')).toMatchObject([{ kind: 'agent.ask', target: 'mcp' }])
    expect((await stored()).agents).toEqual([{ agent: 'client#1', capability: inbox }])
    expect(await ask('client#2', [write])).toEqual({ asked: 'waiting' })
    await loader.confirm(loader.pending()[0].id, {})
    expect((await stored()).agents).toEqual([{ agent: 'client#1', capability: inbox }, { agent: 'client#2', capability: write }])
  })

  it('writes nothing for an ask that would put the entry past 256 items in all', async () => {
    const many = Array.from({ length: 254 }, (_, i) => ({ agent: `client#${i + 1}`, capability: inbox }))
    const { loader, ask, stored, gate, clock } = await started({ agents: many })
    const views = gate.seen.length
    await ask('client#1', [write, read, { type: 'luoshu.list', paths: ['**'] }])
    expect(await code(loader.confirm(loader.pending()[0].id, {}))).toBe('failed')
    expect((await stored()).agents).toHaveLength(254)
    expect(gate.seen).toHaveLength(views)
    // A Confirm that failed leaves the request for the human to cancel, as any request. Two fit
    await loader.cancel(loader.pending()[0].id)
    clock.now += 60_000
    await ask('client#1', [write, read])
    await loader.confirm(loader.pending()[0].id, {})
    expect((await stored()).agents).toHaveLength(256)
  })
})

describe('agents\' items across an update of mcp and a Recover', () => {
  const agents = [{ agent: 'client#1', capability: inbox }, { agent: 'client#2', capability: write }]
  const mcpOf = (version: string) => filesFor(workerManifest('mcp', { version, capabilities: [read] }))
  const item = (capability: Capability) => ({ capability, off: false, firstUse: false })

  async function installed(installVersion: string) {
    const gate = allowAll()
    const made = await harness({
      install: { ...coreInstall(), gate: { files: filesFor(hostManifest('gate')) }, mcp: { files: mcpOf(installVersion), firstParty: true } },
      folder: { mcp: mcpOf('1.0.0') },
      // granted holds a widen the human gave beyond the manifest, which a copy resets
      entries: { mcp: async root => firstPartyEntry(await hashOf(root), { granted: [read, write], class: 1, agents, revoked: ['client#5'] }) },
      behave: { gate: { exports: { gate } } },
      loader: { confirmDelayMs: 0 },
    })
    await made.loader.start()
    return { ...made, gate, stored: async () => (await new StateStore(made.dataDir).load()).state.plugins.mcp }
  }

  it('keeps each agent\'s items and the revoked marks when hetu copies a newer mcp, granted back to the manifest\'s', async () => {
    const { stored, gate, link } = await installed('1.1.0')
    expect(link.events('plugin.copied')).toEqual([{ plugin: 'mcp', version: '1.1.0' }])
    const entry = await stored()
    expect(entry.version).toBe('1.1.0')
    expect(entry.granted).toEqual([read])
    expect(entry.agents).toEqual(agents)
    expect(entry.revoked).toEqual(['client#5'])
    expect(gate.seen.at(-1)!.agents).toEqual({ 'client#1': [item(inbox)], 'client#2': [item(write)] })
  })

  it('drops every agent\'s items on a Recover of mcp and keeps the revoked marks, granted back to the manifest\'s', async () => {
    const { loader, stored, gate } = await installed('1.0.0')
    expect((await stored()).agents).toEqual(agents)
    await loader.apply({ kind: 'plugin.restore', plugin: 'mcp' })
    await loader.settled()
    const entry = await stored()
    expect(entry.granted).toEqual([read])
    expect(entry.agents).toBeUndefined()
    // A revoked label stays marked until http ends its tokens, Recover or not
    expect(entry.revoked).toEqual(['client#5'])
    expect(gate.seen.at(-1)!.agents).toEqual({})
  })
})

describe('revoke of an agent', () => {
  const item = (capability: Capability) => ({ capability, off: false, firstUse: false })
  const door: Caller = { kind: 'plugin', id: 'http', half: 'host', incarnation: 1 }
  const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
  const seeded = [{ agent: 'client#1', capability: inbox }, { agent: 'client#1', capability: write }, { agent: 'client#10', capability: inbox }]

  it('takes every item of the label at once with no Confirm, keeps a label it prefixes and marks the label revoked', async () => {
    const { loader, stored, gate, link } = await started({ agents: seeded })
    expect(await loader.request({ kind: 'agent.revoke', agent: 'client#1' }, trusted)).toEqual({ applied: true })
    const entry = await stored()
    expect(entry.agents).toEqual([{ agent: 'client#10', capability: inbox }])
    expect(entry.revoked).toEqual(['client#1'])
    expect(entry.granted).toEqual([read])
    expect(gate.seen.at(-1)!.agents).toEqual({ 'client#10': [item(inbox)] })
    expect(loader.pending()).toEqual([])
    expect(link.events('security.applied')).toMatchObject([{ kind: 'agent.revoke', by: 'narrows' }])
  })

  it('applies a revoke from any window, as every narrowing change does', async () => {
    const { loader, stored } = await started({ agents: seeded })
    expect(await loader.request({ kind: 'agent.revoke', agent: 'client#10' }, editor)).toEqual({ applied: true })
    expect((await stored()).revoked).toEqual(['client#10'])
  })

  it('withdraws the label\'s waiting ask and refuses the revoked label\'s next ask', async () => {
    const { loader, ask, link } = await started({ agents: seeded })
    await ask('client#1', [read])
    await loader.request({ kind: 'agent.revoke', agent: 'client#1' }, trusted)
    expect(loader.pending()).toEqual([])
    expect(link.events('security.withdrawn')).toMatchObject([{ kind: 'agent.ask' }])
    expect(await code(ask('client#1', [inbox]))).toBe('not-granted')
  })

  it('withdraws a waiting ask of a label that holds nothing yet and marks it, and changes nothing for a label it doesn\'t know', async () => {
    const { loader, ask, stored } = await started({ agents: seeded })
    await ask('client#2', [read])
    await loader.request({ kind: 'agent.revoke', agent: 'client#2' }, trusted)
    expect(loader.pending()).toEqual([])
    expect((await stored()).revoked).toEqual(['client#2'])
    await loader.request({ kind: 'agent.revoke', agent: 'client#9' }, trusted)
    expect((await stored()).revoked).toEqual(['client#2'])
  })

  it('lists for the trusted window each label with items and each revoked one, from mcp\'s entry alone', async () => {
    const { loader, list } = await started({ agents: seeded, revoked: ['client#3'] })
    expect((await list()).agents).toEqual([
      { agent: 'client#1', items: [inbox, write], revoked: false }, { agent: 'client#10', items: [inbox], revoked: false },
      { agent: 'client#3', items: [], revoked: true },
    ])
    await loader.request({ kind: 'agent.revoke', agent: 'client#1' }, trusted)
    expect((await list()).agents).toEqual([
      { agent: 'client#10', items: [inbox], revoked: false }, { agent: 'client#3', items: [], revoked: true }, { agent: 'client#1', items: [], revoked: true },
    ])
  })

  it('answers http for each label it names and drops a revoked mark only once http says it heard', async () => {
    const { loader, stored } = await started({ agents: seeded, revoked: ['client#3', 'client#4'] })
    const agents = (args: object) => loader.serve({ callId: 'c', caller: door, action: 'core.agents', args, deadline: Date.now() + 30_000 } as Call)
    expect(await agents({ agents: ['client#1', 'client#2', 'client#3'] })).toEqual([
      { agent: 'client#1', holds: 'items' }, { agent: 'client#2', holds: 'none' }, { agent: 'client#3', holds: 'revoked' },
    ])
    expect((await stored()).revoked).toEqual(['client#3', 'client#4'])
    expect(await agents({ agents: ['client#3', 'client#4'], heard: ['client#3', 'client#1'] })).toEqual([
      { agent: 'client#3', holds: 'none' }, { agent: 'client#4', holds: 'revoked' },
    ])
    const entry = await stored()
    expect(entry.revoked).toEqual(['client#4'])
    expect(entry.agents).toEqual(seeded)
  })

  it('writes nothing when http names no revoked label as heard, so no waiting ask goes stale', async () => {
    const { loader, ask, stored, store } = await started({ agents: seeded, revoked: ['client#3'] })
    await ask('client#2', [read])
    const before = await stored()
    const writes: string[] = []
    const writePlugin = store.writePlugin.bind(store)
    store.writePlugin = async (id, entry) => {
      writes.push(id)
      return writePlugin(id, entry)
    }
    await loader.serve({ callId: 'c', caller: door, action: 'core.agents', args: { agents: ['client#2'], heard: ['client#2'] }, deadline: Date.now() + 30_000 } as Call)
    expect(writes).toEqual([])
    expect(await stored()).toEqual(before)
    await loader.confirm(loader.pending()[0].id, {})
    expect((await stored()).agents).toContainEqual({ agent: 'client#2', capability: read })
  })
})

describe('an agent\'s ask that lapses or is withdrawn', () => {
  it('lapses five minutes after it was raised, an ask of the same items meanwhile moving nothing, and then can\'t be confirmed', async () => {
    const { loader, ask, clock, link, list } = await started()
    await ask('client#1', [inbox])
    const id = loader.pending()[0].id
    clock.now += 4 * 60_000
    // A burst of the same ask finds the request and leaves its lapse where it was
    expect(await ask('client#1', [inbox])).toEqual({ asked: 'waiting' })
    clock.now += 60_000 - 1
    expect(loader.pending()).toHaveLength(1)
    clock.now += 1
    expect(loader.pending()).toEqual([])
    expect((await list()).requests).toEqual([])
    expect(link.events('security.lapsed')).toMatchObject([{ kind: 'agent.ask', target: 'mcp', window: 'core' }])
    expect(await code(loader.confirm(id, {}))).toBe('not-found')
    // The agent may ask again, as a new request
    expect(await ask('client#1', [inbox])).toEqual({ asked: 'waiting' })
    expect(loader.pending()[0].id).not.toBe(id)
  })

  it('refuses a Confirm that comes after the lapse though nothing read the list between', async () => {
    const { loader, ask, clock, stored } = await started()
    await ask('client#1', [inbox])
    const id = loader.pending()[0].id
    clock.now += 5 * 60_000
    expect(await code(loader.confirm(id, {}))).toBe('not-found')
    expect((await stored()).agents).toBeUndefined()
  })

  it('lapses nothing a window asked for', async () => {
    const { loader, clock } = await started()
    await loader.request({ kind: 'skipVerification', on: true }, trusted)
    clock.now += 24 * 60 * 60_000
    expect(loader.pending()).toHaveLength(1)
  })

  it.each([['mcp', mcpWorker], ['http', { kind: 'plugin', id: 'http', half: 'host', incarnation: 1 } as Caller]])('withdraws every waiting ask when %s stops, so a Confirm after it is refused', async (_id, caller) => {
    const { loader, ask, link, stored } = await started()
    await ask('client#1', [inbox])
    await ask('client#2', [write])
    await loader.request({ kind: 'skipVerification', on: true }, trusted)
    const id = loader.pending()[0].id
    loader.crashed(caller, 'closed')
    expect(loader.pending().map(one => one.kind)).toEqual(['skipVerification'])
    expect(link.events('security.withdrawn')).toMatchObject([{ kind: 'agent.ask' }, { kind: 'agent.ask' }])
    expect(await code(loader.confirm(id, {}))).toBe('not-found')
    expect((await stored()).agents).toBeUndefined()
  })

  it('withdraws every waiting ask when the human switches mcp off', async () => {
    const { loader, ask } = await started()
    await ask('client#1', [inbox])
    await loader.request({ kind: 'plugin.off', plugin: 'mcp' }, trusted)
    await loader.settled()
    expect(loader.pending()).toEqual([])
  })
})
