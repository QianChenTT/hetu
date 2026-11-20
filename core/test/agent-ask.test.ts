import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecurityList } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import type { Call } from '../api/policy-jobs.ts'
import { StateStore } from '../backend/boot/state.ts'
import { EventLog } from '../lib/event-log.ts'
import { allowAll, cleanup, coreInstall, filesFor, firstPartyEntry, harness, hashOf, hostManifest, until, workerManifest, type FakeLink } from './plugins-manager-fakes.ts'

afterEach(cleanup)

const read: Capability = { type: 'luoshu.read', paths: ['**'] }
const inbox: Capability = { type: 'luoshu.read', paths: ['inbox/**'] }
const write: Capability = { type: 'luoshu.write', paths: ['inbox/**'] }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const mcpWorker: Caller = { kind: 'plugin', id: 'mcp', half: 'worker', incarnation: 1 }
const code = (work: Promise<unknown>) => work.then(() => null, (err: { code?: string }) => err.code ?? String(err))
const refusal = (work: Promise<unknown>) => work.then(() => null, (err: unknown) => err)

// mcp as the install's own copy in the plugin folder, holding read on everything, the agents' items its entry is seeded
// with, http as the install's utility plugin and a clock the test moves
async function started(over: { agents?: { agent: string, capability: Capability }[], revoked?: string[] } = {}, aside?: string[]) {
  const clock = { now: 1000 }
  const gate = allowAll()
  const mcp = filesFor(workerManifest('mcp', { capabilities: [read] }))
  const made = await harness({
    install: {
      ...coreInstall(), mcp: { files: mcp, firstParty: true },
      'mcp-http-handler': { files: filesFor(hostManifest('mcp-http-handler', { capabilities: [{ type: 'plugin.call', targets: ['mcp'] }] })) },
    },
    folder: { mcp },
    entries: { mcp: async root => firstPartyEntry(await hashOf(root), { granted: [read], class: 1, ...over }) },
    ...(aside !== undefined ? { switches: { revokedAgents: aside } } : {}),
    modules: { gate },
    pluginsManager: { clock: () => clock.now, confirmDelayMs: 0 },
  })
  await made.pluginsManager.start()
  let n = 0
  // core.identityAsk as the router hands it over once its floor passed: from mcp, on behalf of the chain's label
  const ask = (label: string, capabilities: Capability[]) => made.pluginsManager.serve({
    callId: `call-${++n}`, caller: mcpWorker, onBehalf: label, action: 'core.identityAsk', args: { capabilities }, deadline: Date.now() + 30_000,
  } as Call)
  const list = async () => await made.pluginsManager.serve({ callId: `list-${++n}`, caller: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 } as Call) as SecurityList
  const stored = async () => (await new StateStore(made.dataDir).load()).state.plugins.mcp
  return { ...made, gate, clock, ask, list, stored }
}

describe('an agent\'s ask', () => {
  it('raises a request of its own kind for the label the call carries and answers at once that it waits', async () => {
    const { pluginsManager, ask, list, stored, link } = await started()
    expect(await ask('client#1', [inbox, write])).toEqual({ asked: 'waiting' })
    const pending = pluginsManager.pending()
    expect(pending).toEqual([{ id: pending[0].id, kind: 'identity.ask', plugin: 'mcp' }])
    const shown = (await list()).requests[0]
    expect(shown.text).toBe('Give the agent "client#1" what it asks for through mcp')
    expect(shown.agent).toBe('client#1')
    expect(shown.notes).toEqual([
      'It asks for: luoshu.read on "inbox/**"', 'It asks for: luoshu.write on "inbox/**"',
      'The agent reaches only what mcp holds as well', 'Cancel and revoke turns it away for good, as Revoke in the agent list does once it holds an item',
    ])
    expect(shown.type).toBeNull()
    expect((await stored()).agents).toBeUndefined()
    expect(link.events('security.request')).toMatchObject([{ kind: 'identity.ask', target: 'client#1', window: 'core' }])
  })

  it('answers a second ask for the same items as the first and refuses a different ask while one waits', async () => {
    const { pluginsManager, ask } = await started()
    await ask('client#1', [inbox, write])
    expect(await ask('client#1', [write, { paths: ['inbox/**'], type: 'luoshu.read' }])).toEqual({ asked: 'waiting' })
    expect(pluginsManager.pending()).toHaveLength(1)
    expect(await code(ask('client#1', [inbox]))).toBe('throttled')
    expect(await code(ask('client#1', [read]))).toBe('throttled')
    expect(pluginsManager.pending()).toHaveLength(1)
  })

  it('holds one ask for each of two labels asking at once', async () => {
    const { pluginsManager, ask, list } = await started()
    await Promise.all([ask('client#1', [inbox]), ask('client#2', [write])])
    expect(pluginsManager.pending().map(one => one.kind)).toEqual(['identity.ask', 'identity.ask'])
    expect((await list()).requests.map(one => one.text).sort()).toEqual([
      'Give the agent "client#1" what it asks for through mcp', 'Give the agent "client#2" what it asks for through mcp',
    ])
  })

  it('refuses a label the human cancelled an ask of for a minute, then takes its ask again', async () => {
    const { pluginsManager, ask, clock } = await started()
    await ask('client#1', [inbox])
    await pluginsManager.cancel(pluginsManager.pending()[0].id)
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
    await ask('https://claude.ai/oauth/claude-code-client-metadata#3', [{ type: 'luoshu.read', paths: ['say "yes"/**', 'a, b/**'] }, { type: 'plugin.call', targets: ['mcp-http-handler'] }])
    const shown = (await list()).requests[0]
    expect(shown.text).toBe('Give the agent "https://claude.ai/oauth/claude-code-client-metadata#3" what it asks for through mcp')
    expect(shown.notes.slice(0, 2)).toEqual(['It asks for: luoshu.read on "say \\"yes\\"/**", "a, b/**"', 'It asks for: plugin.call to "mcp-http-handler"'])
  })

  it('refuses an ask whose plugin.call names a plugin hetu doesn\'t know, then takes one that names only known ones', async () => {
    const { pluginsManager, ask, list } = await started()
    expect(await code(ask('client#1', [inbox, { type: 'plugin.call', targets: ['mcp-http-handler', 'press-confirm-to-finish'] }]))).toBe('not-found')
    expect(pluginsManager.pending()).toEqual([])
    expect(await ask('client#1', [{ type: 'plugin.call', targets: ['mcp-http-handler', 'mcp'] }])).toEqual({ asked: 'waiting' })
    expect((await list()).requests[0].notes[0]).toBe('It asks for: plugin.call to "mcp-http-handler", "mcp"')
  })

  it('answers granted with no request for items the agent holds already', async () => {
    const { pluginsManager, ask } = await started({ agents: [{ agent: 'client#1', capability: inbox }] })
    expect(await ask('client#1', [inbox])).toEqual({ asked: 'granted' })
    expect(pluginsManager.pending()).toEqual([])
    // Only the items it lacks are asked for
    await ask('client#1', [inbox, write])
    expect(pluginsManager.pending()).toHaveLength(1)
  })

  const paths = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `p${from + i}/**`)

  it('refuses at the raise an ask that would put the agent past its caps, the items it holds counted, then raises one that fits', async () => {
    const { pluginsManager, ask, link } = await started({ agents: [{ agent: 'client#1', capability: { type: 'luoshu.read', paths: paths(60) } }] })
    expect(await refusal(ask('client#1', [{ type: 'luoshu.read', paths: paths(5, 60) }]))).toEqual({ code: 'invalid', reason: 'too-large' })
    expect(pluginsManager.pending()).toEqual([])
    expect(link.events('security.request')).toEqual([])
    // The same five for a label that holds none fit, so do four more for the first
    expect(await ask('client#2', [{ type: 'luoshu.read', paths: paths(5, 60) }])).toEqual({ asked: 'waiting' })
    expect(await ask('client#1', [{ type: 'luoshu.read', paths: paths(4, 60) }])).toEqual({ asked: 'waiting' })
    expect(pluginsManager.pending()).toHaveLength(2)
  })

  it('refuses at the raise eight items of 64 scopes each, which no Confirm could write', async () => {
    const { pluginsManager, ask } = await started()
    const eight = Array.from({ length: 8 }, (_, n) => ({ type: 'luoshu.read' as const, paths: paths(64, n * 64) }))
    expect(await refusal(ask('client#1', eight))).toEqual({ code: 'invalid', reason: 'too-large' })
    expect(pluginsManager.pending()).toEqual([])
  })

  it('refuses at the raise an ask that would put the entry past 256 items in all, then writes one that fits', async () => {
    const many = Array.from({ length: 254 }, (_, i) => ({ agent: `client#${i + 1}`, capability: inbox }))
    const { pluginsManager, ask, stored } = await started({ agents: many })
    expect(await refusal(ask('client#300', [write, read, { type: 'luoshu.list', paths: ['**'] }]))).toEqual({ code: 'invalid', reason: 'too-large' })
    expect(pluginsManager.pending()).toEqual([])
    expect(await ask('client#300', [write, read])).toEqual({ asked: 'waiting' })
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    expect((await stored()).agents).toHaveLength(256)
  })

  it.each([
    ['luoshu.read', { type: 'luoshu.read', paths: [] }], ['luoshu.write', { type: 'luoshu.write', paths: [] }],
    ['luoshu.list', { type: 'luoshu.list', paths: [] }], ['ui.edit', { type: 'ui.edit', paths: [] }], ['ui.read', { type: 'ui.read', paths: [] }],
    ['history', { type: 'history', access: 'read', paths: [] }], ['net.fetch', { type: 'net.fetch', hosts: [] }],
    ['events.subscribe', { type: 'events.subscribe', topics: [] }], ['plugin.call', { type: 'plugin.call', targets: [] }],
  ] as [string, Capability][])('refuses an item of %s with no scope beside one that has one', async (_type, empty) => {
    const { pluginsManager, ask } = await started()
    expect(await code(ask('client#1', [inbox, empty]))).toBe('invalid')
    expect(pluginsManager.pending()).toEqual([])
  })

  it('takes an exec item that passes no variable and an item of a type with no scope at all', async () => {
    const { pluginsManager, ask, list } = await started()
    expect(await ask('client#1', [{ type: 'exec', commands: [['git', 'status']], env: [] }, { type: 'storage' }])).toEqual({ asked: 'waiting' })
    expect(pluginsManager.pending()).toHaveLength(1)
    expect((await list()).requests[0].notes.slice(0, 2)).toEqual(['It asks for: exec of ["git","status"]', 'It asks for: storage'])
  })

  it('refuses a label out of the agent label\'s form, which the router never hands over', async () => {
    const { pluginsManager, ask } = await started()
    expect(await code(ask('client', [inbox]))).toBe('invalid')
    expect(pluginsManager.pending()).toEqual([])
  })
})

describe('the Confirm of an agent\'s ask', () => {
  const item = (capability: Capability) => ({ capability, off: false, firstUse: false })

  it('adds the items to that label\'s on mcp\'s entry beside granted and hands the gate the next grants snapshot', async () => {
    const { pluginsManager, ask, stored, gate, link } = await started({ agents: [{ agent: 'client#1', capability: inbox }, { agent: 'client#10', capability: inbox }] })
    await ask('client#1', [write, inbox])
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    const entry = await stored()
    expect(entry.granted).toEqual([read])
    expect(entry.agents).toEqual([
      { agent: 'client#1', capability: inbox }, { agent: 'client#10', capability: inbox }, { agent: 'client#1', capability: write },
    ])
    const view = gate.seen.at(-1)!
    expect(view.pairs?.['mcp-http-handler']).toEqual({ 'client#1': [item(inbox), item(write)], 'client#10': [item(inbox)] })
    expect(view.plugins.mcp).toEqual([item(read)])
    expect(pluginsManager.pending()).toEqual([])
    expect(link.events('security.applied')).toMatchObject([{ kind: 'identity.ask', target: 'client#1', by: 'confirm' }])
  })

  it('writes and shows an item of a type the tool table never maps, as the entry takes any type', async () => {
    const { pluginsManager, ask, list, stored } = await started()
    const fetch: Capability = { type: 'net.fetch', hosts: ['example.com'] }
    await ask('client#1', [fetch])
    expect((await list()).requests[0].notes[0]).toBe('It asks for: net.fetch to "example.com"')
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    expect((await stored()).agents).toEqual([{ agent: 'client#1', capability: fetch }])
  })

  it('refuses as stale an ask another write of mcp\'s entry came after, then takes the agent\'s ask again', async () => {
    const { pluginsManager, ask, stored, link } = await started()
    await ask('client#1', [inbox])
    await ask('client#2', [write])
    const [one, two] = pluginsManager.pending()
    await pluginsManager.confirm(one.id, {})
    expect(await code(pluginsManager.confirm(two.id, {}))).toBe('stale')
    expect(pluginsManager.pending()).toEqual([])
    expect(link.events('security.stale')).toMatchObject([{ kind: 'identity.ask', target: 'client#2' }])
    expect((await stored()).agents).toEqual([{ agent: 'client#1', capability: inbox }])
    expect(await ask('client#2', [write])).toEqual({ asked: 'waiting' })
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    expect((await stored()).agents).toEqual([{ agent: 'client#1', capability: inbox }, { agent: 'client#2', capability: write }])
  })

})

describe('agents\' items across an update of mcp and a Recover', () => {
  const agents = [{ agent: 'client#1', capability: inbox }, { agent: 'client#2', capability: write }]
  const mcpOf = (version: string) => filesFor(workerManifest('mcp', { version, capabilities: [read] }))
  const item = (capability: Capability) => ({ capability, off: false, firstUse: false })

  async function installed(installVersion: string) {
    const gate = allowAll()
    const made = await harness({
      install: { ...coreInstall(), mcp: { files: mcpOf(installVersion), firstParty: true } },
      folder: { mcp: mcpOf('1.0.0') },
      // granted holds a widen the human gave beyond the manifest, which a copy resets
      entries: { mcp: async root => firstPartyEntry(await hashOf(root), { granted: [read, write], class: 1, agents, revoked: ['client#5'] }) },
      modules: { gate },
      pluginsManager: { confirmDelayMs: 0 },
    })
    await made.pluginsManager.start()
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
    expect(gate.seen.at(-1)!.pairs?.['mcp-http-handler']).toEqual({ 'client#1': [item(inbox)], 'client#2': [item(write)] })
  })

  it('drops every agent\'s items on a Recover of mcp and keeps the revoked marks, granted back to the manifest\'s', async () => {
    const { pluginsManager, stored, gate } = await installed('1.0.0')
    expect((await stored()).agents).toEqual(agents)
    await pluginsManager.apply({ kind: 'plugin.restore', plugin: 'mcp' })
    await pluginsManager.settled()
    const entry = await stored()
    expect(entry.granted).toEqual([read])
    expect(entry.agents).toBeUndefined()
    // A revoked label stays marked until http ends its tokens, Recover or not
    expect(entry.revoked).toEqual(['client#5'])
    expect(gate.seen.at(-1)!.pairs?.['mcp-http-handler']).toEqual({})
  })
})

describe('revoke of an agent', () => {
  const item = (capability: Capability) => ({ capability, off: false, firstUse: false })
  const door: Caller = { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 }
  const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
  const seeded = [{ agent: 'client#1', capability: inbox }, { agent: 'client#1', capability: write }, { agent: 'client#10', capability: inbox }]

  it('takes every item of the label at once with no Confirm, keeps a label it prefixes and marks the label revoked', async () => {
    const { pluginsManager, stored, gate, link } = await started({ agents: seeded })
    expect(await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)).toEqual({ applied: true })
    const entry = await stored()
    expect(entry.agents).toEqual([{ agent: 'client#10', capability: inbox }])
    expect(entry.revoked).toEqual(['client#1'])
    expect(entry.granted).toEqual([read])
    expect(gate.seen.at(-1)!.pairs?.['mcp-http-handler']).toEqual({ 'client#10': [item(inbox)] })
    expect(pluginsManager.pending()).toEqual([])
    expect(link.events('security.applied')).toMatchObject([{ kind: 'identity.revoke', by: 'narrows' }])
  })

  it('applies a revoke from any window, as every narrowing change does', async () => {
    const { pluginsManager, stored } = await started({ agents: seeded })
    expect(await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#10' }, editor)).toEqual({ applied: true })
    expect((await stored()).revoked).toEqual(['client#10'])
  })

  it('withdraws the label\'s waiting ask and refuses the revoked label\'s next ask', async () => {
    const { pluginsManager, ask, link } = await started({ agents: seeded })
    await ask('client#1', [read])
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)
    expect(pluginsManager.pending()).toEqual([])
    expect(link.events('security.withdrawn')).toMatchObject([{ kind: 'identity.ask' }])
    expect(await code(ask('client#1', [inbox]))).toBe('not-granted')
  })

  it('withdraws a waiting ask of a label that holds nothing yet and marks it, changing nothing for a label that never asked', async () => {
    const { pluginsManager, ask, stored } = await started({ agents: seeded })
    await ask('client#2', [read])
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#2' }, trusted)
    expect(pluginsManager.pending()).toEqual([])
    expect((await stored()).revoked).toEqual(['client#2'])
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#9' }, trusted)
    expect((await stored()).revoked).toEqual(['client#2'])
    expect((await stored()).agents).toEqual(seeded)
  })

  it('turns away a label whose ask the human cancelled, so it never asks again and http hears it is revoked', async () => {
    const { pluginsManager, ask, list, clock } = await started()
    await ask('nag#1', [read])
    await pluginsManager.cancel(pluginsManager.pending()[0].id)
    expect(await pluginsManager.request({ kind: 'identity.revoke', agent: 'nag#1' }, trusted)).toEqual({ applied: true })
    expect((await list()).agents).toEqual([{ agent: 'nag#1', items: [], revoked: true }])
    const agents = await pluginsManager.serve({ callId: 'c', caller: door, action: 'core.identities', args: { agents: ['nag#1'] }, deadline: Date.now() + 30_000 } as Call)
    expect(agents).toEqual([{ agent: 'nag#1', holds: 'revoked' }])
    clock.now += 60_000
    expect(await code(ask('nag#1', [read]))).toBe('not-granted')
  })

  it('marks nothing for a label whose pause after a Cancel ran out, the core no longer having seen it ask', async () => {
    const { pluginsManager, ask, stored, clock, link } = await started()
    await ask('nag#1', [read])
    await pluginsManager.cancel(pluginsManager.pending()[0].id)
    clock.now += 60_000
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'nag#1' }, trusted)
    expect((await stored()).revoked).toBeUndefined()
    expect(link.events('security.applied')).toEqual([])
  })

  it('marks no real label out and writes no record for 256 revokes from the editor window of labels that never asked', async () => {
    const { pluginsManager, stored, link } = await started({ agents: [{ agent: 'client#1', capability: inbox }], revoked: ['client#3'] })
    for (let n = 1; n <= 256; n++) expect(await pluginsManager.request({ kind: 'identity.revoke', agent: `made-up#${n}` }, editor)).toEqual({ applied: true })
    const entry = await stored()
    expect(entry.revoked).toEqual(['client#3'])
    expect(entry.agents).toEqual([{ agent: 'client#1', capability: inbox }])
    expect(link.events('security.applied')).toEqual([])
    expect(link.events('agent.markDropped')).toEqual([])
  })

  it('marks a label that asked while mcp has no entry, held in the switches', async () => {
    const { pluginsManager, ask, dataDir } = await started()
    await ask('client#4', [read])
    await pluginsManager.cancel(pluginsManager.pending()[0].id)
    const held = await pluginsManager.request({ kind: 'plugin.reset', plugin: 'mcp' }, trusted)
    if ('held' in held) await pluginsManager.confirm(held.held, {})
    await pluginsManager.settled()
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#4' }, trusted)
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#5' }, trusted)
    expect((await new StateStore(dataDir).load()).state.switches.revokedAgents).toEqual(['client#4'])
  })

  it('lists for the trusted window each label with items and each revoked one, from mcp\'s entry alone', async () => {
    const { pluginsManager, list } = await started({ agents: seeded, revoked: ['client#3'] })
    expect((await list()).agents).toEqual([
      { agent: 'client#1', items: [inbox, write], revoked: false }, { agent: 'client#10', items: [inbox], revoked: false },
      { agent: 'client#3', items: [], revoked: true },
    ])
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)
    expect((await list()).agents).toEqual([
      { agent: 'client#10', items: [inbox], revoked: false }, { agent: 'client#3', items: [], revoked: true }, { agent: 'client#1', items: [], revoked: true },
    ])
  })

  it('answers http for each label it names and drops a revoked mark only once http says it heard', async () => {
    const { pluginsManager, stored } = await started({ agents: seeded, revoked: ['client#3', 'client#4'] })
    const agents = (args: object) => pluginsManager.serve({ callId: 'c', caller: door, action: 'core.identities', args, deadline: Date.now() + 30_000 } as Call)
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
    const { pluginsManager, ask, stored, store } = await started({ agents: seeded, revoked: ['client#3'] })
    await ask('client#2', [read])
    const before = await stored()
    const writes: string[] = []
    const writePlugin = store.writePlugin.bind(store)
    store.writePlugin = async (id, entry) => {
      writes.push(id)
      return writePlugin(id, entry)
    }
    await pluginsManager.serve({ callId: 'c', caller: door, action: 'core.identities', args: { agents: ['client#2'], heard: ['client#2'] }, deadline: Date.now() + 30_000 } as Call)
    expect(writes).toEqual([])
    expect(await stored()).toEqual(before)
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    expect((await stored()).agents).toContainEqual({ agent: 'client#2', capability: read })
  })
})

describe('the revoked marks at their cap and through a Reset or a Remove of mcp', () => {
  const door: Caller = { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 }
  const marks = Array.from({ length: 256 }, (_, n) => `gone#${n + 1}`)
  const agentsOf = (pluginsManager: { serve(call: Call): Promise<unknown> }, args: object) =>
    pluginsManager.serve({ callId: 'c', caller: door, action: 'core.identities', args, deadline: Date.now() + 30_000 } as Call)
  const switchesOf = async (dataDir: string) => (await new StateStore(dataDir).load()).state.switches

  it('takes the label\'s items with 256 marks held, the oldest mark dropped to make room with a record naming it', async () => {
    const { pluginsManager, stored, link } = await started({ agents: [{ agent: 'client#1', capability: inbox }, { agent: 'client#2', capability: inbox }], revoked: marks })
    expect(await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)).toEqual({ applied: true })
    const entry = await stored()
    expect(entry.agents).toEqual([{ agent: 'client#2', capability: inbox }])
    expect(entry.revoked).toHaveLength(256)
    expect(entry.revoked![0]).toBe('gone#2')
    expect(entry.revoked!.at(-1)).toBe('client#1')
    expect(link.events('agent.markDropped')).toEqual([{ target: 'gone#1', for: 'client#1' }])
    expect(await agentsOf(pluginsManager, { agents: ['client#1', 'gone#1', 'gone#2'] })).toEqual([
      { agent: 'client#1', holds: 'revoked' }, { agent: 'gone#1', holds: 'none' }, { agent: 'gone#2', holds: 'revoked' },
    ])
  })

  it('drops no mark below the cap', async () => {
    const { pluginsManager, stored, link } = await started({ agents: [{ agent: 'client#1', capability: inbox }], revoked: marks.slice(0, 255) })
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)
    expect((await stored()).revoked).toEqual([...marks.slice(0, 255), 'client#1'])
    expect(link.events('agent.markDropped')).toEqual([])
  })

  it.each(['plugin.reset', 'plugin.remove'] as const)('keeps the marks through a %s of mcp and hands them to the entry a Restore writes', async kind => {
    const { pluginsManager, stored, ask, list, dataDir } = await started({ agents: [{ agent: 'client#1', capability: inbox }, { agent: 'client#2', capability: inbox }], revoked: ['client#3'] })
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)
    const held = await pluginsManager.request({ kind, plugin: 'mcp' }, trusted)
    if ('held' in held) await pluginsManager.confirm(held.held, {})
    await pluginsManager.settled()
    expect(await stored()).toBeUndefined()
    expect((await switchesOf(dataDir)).revokedAgents).toEqual(['client#3', 'client#1'])
    // While mcp has no entry the marks still answer http and still show
    expect(await agentsOf(pluginsManager, { agents: ['client#1', 'client#2', 'client#3'] })).toEqual([
      { agent: 'client#1', holds: 'revoked' }, { agent: 'client#2', holds: 'none' }, { agent: 'client#3', holds: 'revoked' },
    ])
    expect((await list()).agents).toEqual([{ agent: 'client#3', items: [], revoked: true }, { agent: 'client#1', items: [], revoked: true }])
    const back = await pluginsManager.request({ kind: 'plugin.restore', plugin: 'mcp' }, trusted)
    if ('held' in back) await pluginsManager.confirm(back.held, {})
    await pluginsManager.settled()
    const entry = await stored()
    expect(entry.revoked).toEqual(['client#3', 'client#1'])
    expect(entry.agents).toBeUndefined()
    expect((await switchesOf(dataDir)).revokedAgents).toBeUndefined()
    expect(await code(ask('client#1', [inbox]))).toBe('not-granted')
    expect(await code(ask('client#2', [inbox]))).toBeNull()
  })

  it('drops a mark held while mcp has no entry once http says it heard', async () => {
    const { pluginsManager, dataDir } = await started({ revoked: ['client#3', 'client#4'] })
    const held = await pluginsManager.request({ kind: 'plugin.reset', plugin: 'mcp' }, trusted)
    if ('held' in held) await pluginsManager.confirm(held.held, {})
    await pluginsManager.settled()
    expect(await agentsOf(pluginsManager, { agents: ['client#3', 'client#4'], heard: ['client#3'] })).toEqual([
      { agent: 'client#3', holds: 'none' }, { agent: 'client#4', holds: 'revoked' },
    ])
    expect((await switchesOf(dataDir)).revokedAgents).toEqual(['client#4'])
  })

  it('takes a mark the switches still hold beside mcp\'s entry, as a stop between the two writes of a hand back leaves it', async () => {
    const { pluginsManager, ask, list, dataDir } = await started({ agents: [{ agent: 'client#2', capability: inbox }], revoked: ['client#3'] }, ['client#1'])
    expect(await code(ask('client#1', [inbox]))).toBe('not-granted')
    expect(await agentsOf(pluginsManager, { agents: ['client#1', 'client#3'] })).toEqual([{ agent: 'client#1', holds: 'revoked' }, { agent: 'client#3', holds: 'revoked' }])
    expect((await list()).agents.filter(row => row.revoked).map(row => row.agent)).toEqual(['client#1', 'client#3'])
    await agentsOf(pluginsManager, { agents: ['client#1'], heard: ['client#1'] })
    expect(Object.hasOwn(await switchesOf(dataDir), 'revokedAgents')).toBe(false)
    expect(await code(ask('client#1', [inbox]))).toBeNull()
  })

  it('answers the router whether a label is revoked from the marks wherever they are, a mark dropped as the oldest no longer one', async () => {
    const { pluginsManager } = await started({ agents: [{ agent: 'client#1', capability: inbox }], revoked: marks })
    expect(pluginsManager.revoked('gone#1')).toBe(true)
    expect(pluginsManager.revoked('client#1')).toBe(false)
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)
    expect(pluginsManager.revoked('client#1')).toBe(true)
    expect(pluginsManager.revoked('gone#1')).toBe(false)
    expect(pluginsManager.revoked('gone#2')).toBe(true)
    const held = await pluginsManager.request({ kind: 'plugin.reset', plugin: 'mcp' }, trusted)
    if ('held' in held) await pluginsManager.confirm(held.held, {})
    await pluginsManager.settled()
    // Held in the switches while mcp has no entry
    expect(pluginsManager.revoked('client#1')).toBe(true)
    expect(pluginsManager.revoked('never#1')).toBe(false)
  })

  it('writes no mark into the switches for a Reset of mcp that holds none', async () => {
    const { pluginsManager, dataDir } = await started({ agents: [{ agent: 'client#1', capability: inbox }] })
    const held = await pluginsManager.request({ kind: 'plugin.reset', plugin: 'mcp' }, trusted)
    if ('held' in held) await pluginsManager.confirm(held.held, {})
    await pluginsManager.settled()
    expect(Object.hasOwn(await switchesOf(dataDir), 'revokedAgents')).toBe(false)
  })
})

describe('the records of an agent\'s ask, its Confirm and its revoke', () => {
  // Every character the label's form takes but letters and digits, a user part, a port and a number among them
  const label = "https://u@a.example:8443/p;q=1?x=[1]&y=(2)*+,$!'~-._%41#12"

  it('name the agent as their target', async () => {
    const { pluginsManager, ask, link } = await started()
    await ask(label, [inbox])
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    expect(await pluginsManager.request({ kind: 'identity.revoke', agent: label }, trusted)).toEqual({ applied: true })
    expect(link.records.filter(record => record.event.startsWith('security.')).map(record => [record.event, record.fields.kind, record.fields.target])).toEqual([
      ['security.request', 'identity.ask', label], ['security.confirm', 'identity.ask', label], ['security.applied', 'identity.ask', label],
      ['security.applied', 'identity.revoke', label],
    ])
  })

  it('write each as one line of the event log that reads back with the label whole', async () => {
    const { pluginsManager, ask, link, base } = await started()
    await ask(label, [inbox])
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    await pluginsManager.request({ kind: 'identity.revoke', agent: label }, trusted)
    const written = link.records.filter(record => record.event.startsWith('security.'))
    const log = new EventLog(path.join(base, 'records'))
    await log.open()
    for (const record of written) await log.append(record.event, record.fields)
    const lines = (await readFile(path.join(base, 'records', 'events', 'events-1.jsonl'), 'utf8')).split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(written.length)
    expect(lines.map(line => JSON.parse(line).target)).toEqual(written.map(() => label))
    expect(await log.verify()).toMatchObject({ ok: true })
  })

  it('leave out a revoke that changed nothing, of a label that never asked or of one revoked already', async () => {
    const { pluginsManager, link } = await started({ agents: [{ agent: 'client#1', capability: inbox }] })
    expect(await pluginsManager.request({ kind: 'identity.revoke', agent: 'never#1' }, trusted)).toEqual({ applied: true })
    expect(link.events('security.applied')).toEqual([])
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)
    expect(link.events('security.applied')).toMatchObject([{ kind: 'identity.revoke', target: 'client#1' }])
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)
    expect(link.events('security.applied')).toHaveLength(1)
  })
})

describe('an agent\'s ask that lapses or is withdrawn', () => {
  it('lapses five minutes after it was raised, an ask of the same items meanwhile moving nothing, then can\'t be confirmed', async () => {
    const { pluginsManager, ask, clock, link, list } = await started()
    await ask('client#1', [inbox])
    const id = pluginsManager.pending()[0].id
    clock.now += 4 * 60_000
    // A burst of the same ask finds the request and leaves its lapse where it was
    expect(await ask('client#1', [inbox])).toEqual({ asked: 'waiting' })
    clock.now += 60_000 - 1
    expect(pluginsManager.pending()).toHaveLength(1)
    clock.now += 1
    expect(pluginsManager.pending()).toEqual([])
    expect((await list()).requests).toEqual([])
    expect(link.events('security.lapsed')).toMatchObject([{ kind: 'identity.ask', target: 'client#1', window: 'core' }])
    expect(await code(pluginsManager.confirm(id, {}))).toBe('not-found')
    // The agent may ask again, as a new request
    expect(await ask('client#1', [inbox])).toEqual({ asked: 'waiting' })
    expect(pluginsManager.pending()[0].id).not.toBe(id)
  })

  it('refuses a Confirm that comes after the lapse though nothing read the list between', async () => {
    const { pluginsManager, ask, clock, stored } = await started()
    await ask('client#1', [inbox])
    const id = pluginsManager.pending()[0].id
    clock.now += 5 * 60_000
    expect(await code(pluginsManager.confirm(id, {}))).toBe('not-found')
    expect((await stored()).agents).toBeUndefined()
  })

  it('lapses nothing a window asked for', async () => {
    const { pluginsManager, clock } = await started()
    await pluginsManager.request({ kind: 'skipVerification', on: true }, trusted)
    clock.now += 24 * 60 * 60_000
    expect(pluginsManager.pending()).toHaveLength(1)
  })

  it.each([['mcp', mcpWorker], ['mcp-http-handler', { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 } as Caller]])('withdraws every waiting ask when %s stops, so a Confirm after it is refused', async (_id, caller) => {
    const { pluginsManager, ask, link, stored } = await started()
    await ask('client#1', [inbox])
    await ask('client#2', [write])
    await pluginsManager.request({ kind: 'skipVerification', on: true }, trusted)
    const id = pluginsManager.pending()[0].id
    pluginsManager.crashed(caller, 'closed')
    expect(pluginsManager.pending().map(one => one.kind)).toEqual(['skipVerification'])
    expect(link.events('security.withdrawn')).toMatchObject([{ kind: 'identity.ask' }, { kind: 'identity.ask' }])
    expect(await code(pluginsManager.confirm(id, {}))).toBe('not-found')
    expect((await stored()).agents).toBeUndefined()
  })

  // The Confirm's record held back until the test lands it, so the ask can go while the Confirm waits on it. Resolves
  // once the Confirm waits on its record, with what lands it
  function holdConfirm(link: FakeLink): Promise<() => void> {
    return new Promise(held => {
      link.landing = event => (event === 'security.confirm' ? new Promise(resolve => held(() => resolve('landed'))) : 'landed')
    })
  }
  const securityEvents = (link: FakeLink) => link.records.map(record => record.event).filter(event => event.startsWith('security.'))

  it('applies nothing for a Confirm whose ask was withdrawn while its record landed and answers not-found', async () => {
    const { pluginsManager, ask, link, stored, runtime } = await started()
    await ask('client#1', [inbox])
    const holding = holdConfirm(link)
    const confirming = code(pluginsManager.confirm(pluginsManager.pending()[0].id, {}))
    const land = await holding
    runtime.half('mcp').crash()
    await until(() => pluginsManager.pending().length === 0)
    land()
    expect(await confirming).toBe('not-found')
    expect((await stored()).agents).toBeUndefined()
    expect(securityEvents(link)).toEqual(['security.request', 'security.confirm', 'security.withdrawn'])
  })

  it('applies nothing for a Confirm whose ask lapsed while its record landed and answers not-found', async () => {
    const { pluginsManager, ask, link, stored, clock } = await started()
    await ask('client#1', [inbox])
    clock.now += 5 * 60_000 - 1
    const holding = holdConfirm(link)
    const confirming = code(pluginsManager.confirm(pluginsManager.pending()[0].id, {}))
    const land = await holding
    clock.now += 1
    land()
    expect(await confirming).toBe('not-found')
    expect((await stored()).agents).toBeUndefined()
    expect(securityEvents(link)).toEqual(['security.request', 'security.confirm', 'security.lapsed'])
  })

  it('still applies a Confirm whose ask stayed while its record landed', async () => {
    const { pluginsManager, ask, link, stored } = await started()
    await ask('client#1', [inbox])
    const holding = holdConfirm(link)
    const confirming = code(pluginsManager.confirm(pluginsManager.pending()[0].id, {}))
    const land = await holding
    land()
    expect(await confirming).toBeNull()
    expect((await stored()).agents).toEqual([{ agent: 'client#1', capability: inbox }])
    expect(securityEvents(link)).toEqual(['security.request', 'security.confirm', 'security.applied'])
  })

  it('withdraws every waiting ask when the human switches mcp off', async () => {
    const { pluginsManager, ask } = await started()
    await ask('client#1', [inbox])
    await pluginsManager.request({ kind: 'plugin.off', plugin: 'mcp' }, trusted)
    await pluginsManager.settled()
    expect(pluginsManager.pending()).toEqual([])
  })
})
