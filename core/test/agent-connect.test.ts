import { afterEach, describe, expect, it } from 'vitest'
import { coreActions, type SecurityList } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import {
  agentConnect, change, changeEffect, changeKinds, connectLabel, lapseOf, MAX_CLIENT_NAME_LENGTH, mustType, withdrawnWith, type AgentConnect,
} from '../api/changes.ts'
import { describeChange } from '../api/describe.ts'
import type { Caller } from '../api/envelope.ts'
import type { Call } from '../api/policy-jobs.ts'
import { StateStore } from '../backend/boot/state.ts'
import { connectChange, Connects, type ConnectAsked } from '../backend/plugins-manager/connects.ts'
import { allowAll, cleanup, coreInstall, filesFor, firstPartyEntry, harness, hashOf, hostManifest, workerManifest } from './plugins-manager-fakes.ts'

afterEach(cleanup)

const CLAUDE = 'https://claude.ai/oauth/claude-code-client-metadata'
const ch = (code: number) => String.fromCharCode(code)
// Shalom in Hebrew letters, written right to left
const HEBREW = [0x5e9, 0x5dc, 0x5d5, 0x5dd].map(ch).join('')
const asked = { client: CLAUDE, name: 'Claude Code', redirect: 'http://localhost:33418/callback', number: 3 }
const built = (over: Partial<typeof asked> | { name: string | null } = {}) => connectChange({ ...asked, ...over })
const words = (over: Partial<typeof asked> | { name: string | null } = {}) => describeChange(built(over)!)

describe('the agent.connect kind', () => {
  const connect: AgentConnect = {
    kind: 'agent.connect', plugin: 'mcp-http-handler', client: CLAUDE, clientHost: 'claude.ai', name: 'Claude Code', redirect: 'http://localhost:33418/callback',
    redirectHost: 'localhost:33418', number: 3,
  }

  it('is no change a window may send nor one security.request carries', () => {
    expect(agentConnect.parse(connect)).toEqual(connect)
    expect(change.safeParse(connect).success).toBe(false)
    expect(changeKinds).not.toContain('agent.connect')
    expect(coreActions['security.request'].args.safeParse({ change: connect }).success).toBe(false)
  })

  it('widens with nothing to type, lapses a minute after it was raised and goes when http stops', () => {
    expect(changeEffect(connect)).toBe('widens')
    expect(mustType(connect)).toBeNull()
    expect(lapseOf(connect)).toBe(60_000)
    expect(withdrawnWith(connect)).toEqual(['mcp-http-handler'])
  })

  it('makes the label from the client id and the number in the agent label\'s form', () => {
    expect(connectLabel(connect)).toBe(`${CLAUDE}#3`)
    expect(connectLabel({ client: 'client', number: 120 })).toBe('client#120')
    expect(agentConnect.safeParse({ ...connect, client: 'client', number: 999_999_999_999_999 }).success).toBe(true)
    for (const over of [
      { client: '' }, { client: 'a#b' }, { client: 'a b' }, { client: 'x'.repeat(256) }, { client: `kl${ch(0x131)}ent` }, { number: 0 }, { number: -1 },
      { number: 1.5 }, { number: 1_000_000_000_000_000 },
    ]) expect(agentConnect.safeParse({ ...connect, ...over }).success, JSON.stringify(over)).toBe(false)
  })

  it('refuses a field it does not name', () => {
    expect(agentConnect.safeParse({ ...connect, handle: 'h' }).success).toBe(false)
    expect(agentConnect.safeParse({ ...connect, plugin: 'mcp' }).success).toBe(false)
  })
})

describe('the connect as the core builds it from what http sends', () => {
  it('takes the host of a client id that is a URL and of the redirect, with the port where one is named', () => {
    expect(built()).toEqual({
      kind: 'agent.connect', plugin: 'mcp-http-handler', client: CLAUDE, clientHost: 'claude.ai', name: 'Claude Code', redirect: 'http://localhost:33418/callback',
      redirectHost: 'localhost:33418', number: 3,
    })
    expect(built({ client: 'https://Claude.AI:443/doc?x=1', redirect: 'http://[::1]:5000/cb' })).toMatchObject({ clientHost: 'claude.ai', redirectHost: '[::1]:5000' })
  })

  it('has no host for a client id that is not a URL with one', () => {
    for (const client of ['my-client', 'urn:ietf:client', '7c4d0c1e-5b1d-4d7e-9a8a-1d0f5a1b2c3d']) expect(built({ client })?.clientHost).toBeNull()
  })

  it('refuses a client id or a redirect with user info, a redirect with no host and one that is no URL', () => {
    expect(built({ redirect: 'http://claude.ai@localhost:33418/callback' })).toBeNull()
    expect(built({ redirect: 'http://user:pass@localhost/cb' })).toBeNull()
    expect(built({ client: 'https://claude.ai@evil.example/doc' })).toBeNull()
    expect(built({ redirect: 'com.example.app:/callback' })).toBeNull()
    expect(built({ redirect: 'localhost/callback' })).toBeNull()
  })

  it('refuses a client id and a number that make no label', () => {
    expect(built({ client: 'a#b' })).toBeNull()
    expect(built({ number: 0 })).toBeNull()
    expect(built({ client: '' })).toBeNull()
  })

  it('takes a name with a quote and right-to-left letters and one at the length cap', () => {
    expect(built({ name: 'say "yes"' })?.name).toBe('say "yes"')
    expect(built({ name: HEBREW })?.name).toBe(HEBREW)
    expect(built({ name: 'n'.repeat(MAX_CLIENT_NAME_LENGTH) })?.name).toHaveLength(MAX_CLIENT_NAME_LENGTH)
    expect(built({ name: null })?.name).toBeNull()
  })

  it('refuses a name past the cap, empty or with a control, bidi, zero width or line separator character', () => {
    for (const name of [
      'n'.repeat(MAX_CLIENT_NAME_LENGTH + 1), '', 'Claude\nCode', `Claude${ch(0x7)}`, `abc${ch(0x202e)}doc.exe`, `Cl${ch(0x2066)}aude`,
      `Cla${ch(0x200b)}ude`, `Claude${ch(0x200d)}`, `Claude${ch(0xfeff)}`, `Claude${ch(0x2028)}Code`, `Claude${ch(0xad)}`, `Claude${ch(0xd800)}`,
    ]) expect(built({ name }), JSON.stringify(name)).toBeNull()
  })
})

describe('the words of a connect', () => {
  const FIXED = [
    'Any program on this computer can connect under that client id and that name, so confirm only a connect you started just now',
    'It reaches no note yet. It asks for items later and each ask waits for your Confirm',
  ]

  it('names the client id\'s host first, then the name, the redirect\'s host and the label in quotes, then the two fixed lines', () => {
    expect(words()).toEqual({
      text: `Connect the client from "claude.ai" named "Claude Code", which returns to "localhost:33418", as the agent "${CLAUDE}#3"`,
      notes: FIXED,
    })
  })

  it('names a client id that is not a URL whole in quotes, then the rest in the same order', () => {
    expect(words({ client: 'my-client', number: 12 })).toEqual({
      text: 'Connect the client "my-client" named "Claude Code", which returns to "localhost:33418", as the agent "my-client#12"',
      notes: FIXED,
    })
  })

  it('says a client gives no name', () => {
    expect(words({ name: null }).text).toBe(`Connect the client from "claude.ai" with no name, which returns to "localhost:33418", as the agent "${CLAUDE}#3"`)
  })

  it('escapes a quote in the name, so it can\'t close its quotes and read as the core\'s words', () => {
    const { text } = words({ name: 'x", which returns to "claude.ai' })
    expect(text).toBe(`Connect the client from "claude.ai" named "x\\", which returns to \\"claude.ai", which returns to "localhost:33418", as the agent "${CLAUDE}#3"`)
  })

  it('shows right-to-left letters inside their quotes', () => {
    expect(words({ name: HEBREW }).text).toContain(`named "${HEBREW}", which`)
  })

  it('shows the redirect\'s host and never its user info or path', () => {
    const { text } = words({ redirect: 'http://127.0.0.1:8080/claude.ai/callback?to=evil.example' })
    expect(text).toContain('which returns to "127.0.0.1:8080", as')
    expect(text).not.toContain('evil')
    expect(text).not.toContain('/callback')
  })

  it('quotes every value from outside the core: the host, the name, the redirect\'s host and the label', () => {
    const { text } = words()
    for (const value of ['claude.ai', 'Claude Code', 'localhost:33418', `${CLAUDE}#3`]) expect(text).toContain(JSON.stringify(value))
    expect(text.replaceAll(/"(?:[^"\\]|\\.)*"/g, '')).toBe('Connect the client from  named , which returns to , as the agent ')
  })

  it('has the label in quotes as the last thing in its heading, the one place the trusted window draws it apart', () => {
    const label = JSON.stringify(`${CLAUDE}#3`)
    const { text } = words({ name: `${CLAUDE}#3` })
    expect(text.endsWith(` as the agent ${label}`)).toBe(true)
    expect(text.lastIndexOf(label)).toBe(text.length - label.length)
  })
})

const read: Capability = { type: 'luoshu.read', paths: ['**'] }
const inbox: Capability = { type: 'luoshu.read', paths: ['inbox/**'] }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const door: Caller = { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 }
const mcpWorker: Caller = { kind: 'plugin', id: 'mcp', half: 'worker', incarnation: 1 }
const code = (work: Promise<unknown>) => work.then(() => null, (err: { code?: string }) => err.code ?? String(err))
const LABEL = `${CLAUDE}#3`

// mcp as the install's own copy in the plugin folder with the agents' items and marks its entry is seeded with, http
// as the install's plugin, a clock the test moves and the input delay a test names
async function started(over: { agents?: { agent: string, capability: Capability }[], revoked?: string[] } = {}, delayMs = 0) {
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
    modules: { gate },
    pluginsManager: { clock: () => clock.now, confirmDelayMs: delayMs },
  })
  await made.pluginsManager.start()
  let n = 0
  const serve = (caller: Caller, action: string, args: unknown, onBehalf?: string) => made.pluginsManager.serve({
    callId: `call-${++n}`, caller, action, args, deadline: Date.now() + 30_000, ...(onBehalf !== undefined ? { onBehalf } : {}),
  } as Call)
  // core.agentConnect and core.agentConnected as the carrier hands them over once its floor let http's door through
  const connect = async (over: Partial<ConnectAsked> = {}) => (await serve(door, 'core.agentConnect', { ...asked, ...over }) as { handle: string }).handle
  const collect = async (handle: string) => (await serve(door, 'core.agentConnected', { handle }) as { answer: string }).answer
  // core.agentAsk as the carrier hands it over under a live door call for label
  const agentAsk = (label: string, capabilities: Capability[]) => serve(mcpWorker, 'core.agentAsk', { capabilities }, label)
  const list = async () => await serve(trusted, 'security.list', undefined) as SecurityList
  const state = async () => (await new StateStore(made.dataDir).load()).state
  const first = () => made.pluginsManager.pending()[0]!.id
  return { ...made, gate, clock, connect, collect, agentAsk, list, state, first }
}

describe('a connect http asks for', () => {
  it('raises a request only the core raises and answers at once with a handle the core made', async () => {
    const { pluginsManager, connect, list, link, first } = await started()
    const handle = await connect()
    expect(handle).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(pluginsManager.pending()).toEqual([{ id: first(), kind: 'agent.connect', plugin: 'mcp-http-handler' }])
    expect(handle).not.toBe(first())
    const shown = (await list()).requests[0]!
    expect(shown.text).toBe(`Connect the client from "claude.ai" named "Claude Code", which returns to "localhost:33418", as the agent "${LABEL}"`)
    expect(shown.agent).toBe(LABEL)
    expect(shown.type).toBeNull()
    expect(link.events('security.request')).toMatchObject([{ kind: 'agent.connect', target: 'mcp-http-handler', window: 'core' }])
  })

  it('makes each handle afresh and never from what http sent', async () => {
    const { pluginsManager, connect, first } = await started()
    const one = await connect()
    await pluginsManager.cancel(first())
    const two = await connect({ client: 'other-client', number: 1 })
    expect(two).not.toBe(one)
    for (const handle of [one, two]) for (const sent of [CLAUDE, 'other-client', 'Claude Code', asked.redirect]) expect(handle).not.toContain(sent)
  })

  it('holds one connect waiting in all, a second refused while one waits whether it reads the same or not', async () => {
    const { pluginsManager, connect } = await started()
    const both = await Promise.all([code(connect()), code(connect())])
    expect(both.sort()).toEqual([null, 'throttled'].sort())
    expect(await code(connect({ client: 'other-client', number: 1 }))).toBe('throttled')
    expect(pluginsManager.pending()).toHaveLength(1)
  })

  it('refuses a label the core holds items for, holds as revoked or has an ask waiting for and raises nothing', async () => {
    const { pluginsManager, connect, agentAsk } = await started({ agents: [{ agent: 'held#1', capability: inbox }], revoked: ['gone#1'] })
    expect(await code(connect({ client: 'held', number: 1 }))).toBe('not-granted')
    expect(await code(connect({ client: 'gone', number: 1 }))).toBe('not-granted')
    await agentAsk('asking#2', [inbox])
    expect(await code(connect({ client: 'asking', number: 2 }))).toBe('not-granted')
    expect(pluginsManager.pending().map(one => one.kind)).toEqual(['agent.ask'])
    // Another number under the same client id is another agent
    expect(await code(connect({ client: 'held', number: 2 }))).toBeNull()
  })

  it('refuses with invalid what makes no label or what the core won\'t show, before any request', async () => {
    const { pluginsManager, connect, link } = await started()
    for (const over of [{ client: 'a#b' }, { number: 0 }, { redirect: 'http://claude.ai@localhost/cb' }, { redirect: 'com.example:/cb' }, { name: `Cla${ch(0x200b)}ude` }]) {
      expect(await code(connect(over)), JSON.stringify(over)).toBe('invalid')
    }
    expect(pluginsManager.pending()).toEqual([])
    expect(link.events('security.request')).toEqual([])
  })
})

describe('the answer to a connect', () => {
  it('answers waiting before the Confirm, yes once after it, then gone', async () => {
    const { pluginsManager, connect, collect, first } = await started()
    const handle = await connect()
    expect(await collect(handle)).toBe('waiting')
    expect(await collect(handle)).toBe('waiting')
    await pluginsManager.confirm(first(), {})
    expect(pluginsManager.pending()).toEqual([])
    expect(await collect(handle)).toBe('yes')
    expect(await collect(handle)).toBe('gone')
  })

  it('answers no once after a Cancel and refuses that client id for a minute, then takes it again', async () => {
    const { pluginsManager, connect, collect, clock, first } = await started()
    const handle = await connect()
    await pluginsManager.cancel(first())
    expect(await collect(handle)).toBe('no')
    expect(await collect(handle)).toBe('gone')
    expect(await code(connect({ number: 4 }))).toBe('throttled')
    clock.now += 59_999
    expect(await code(connect({ number: 4 }))).toBe('throttled')
    // Another client id is not held back
    const other = await connect({ client: 'other-client', number: 1 })
    await pluginsManager.cancel(first())
    expect(await collect(other)).toBe('no')
    clock.now += 1
    expect(await code(connect({ number: 4 }))).toBeNull()
  })

  it('answers gone for a handle the core never made', async () => {
    const { connect, collect } = await started()
    const handle = await connect()
    expect(await collect('A'.repeat(32))).toBe('gone')
    expect(await collect(handle.slice(1))).toBe('gone')
    expect(await collect(handle)).toBe('waiting')
  })

  it('lapses a minute after it was raised, then answers gone and can\'t be confirmed, a new connect then taken', async () => {
    const { pluginsManager, connect, collect, clock, first, link } = await started()
    const handle = await connect()
    const id = first()
    clock.now += 59_999
    expect(await collect(handle)).toBe('waiting')
    clock.now += 1
    expect(await collect(handle)).toBe('gone')
    expect(pluginsManager.pending()).toEqual([])
    expect(await code(pluginsManager.confirm(id, {}))).toBe('not-found')
    expect(link.events('security.lapsed')).toMatchObject([{ kind: 'agent.connect' }])
    expect(await code(connect())).toBeNull()
  })

  it('refuses a Confirm inside the input delay, which leaves the connect waiting', async () => {
    const { pluginsManager, connect, collect, clock, first } = await started({}, 1000)
    const handle = await connect()
    clock.now += 999
    expect(await code(pluginsManager.confirm(first(), {}))).toBe('throttled')
    expect(await collect(handle)).toBe('waiting')
    clock.now += 1
    await pluginsManager.confirm(first(), {})
    expect(await collect(handle)).toBe('yes')
  })

  it('withdraws a waiting connect when http stops, so its handle answers gone and its Confirm is refused', async () => {
    const { pluginsManager, connect, collect, first, link } = await started()
    const handle = await connect()
    const id = first()
    pluginsManager.crashed(door, 'closed')
    expect(pluginsManager.pending()).toEqual([])
    expect(link.events('security.withdrawn')).toMatchObject([{ kind: 'agent.connect' }])
    expect(await code(pluginsManager.confirm(id, {}))).toBe('not-found')
    expect(await collect(handle)).toBe('gone')
  })

  it('drops a yes http never collected when http stops', async () => {
    const { pluginsManager, connect, collect, first } = await started()
    const handle = await connect()
    await pluginsManager.confirm(first(), {})
    pluginsManager.crashed(door, 'closed')
    expect(await collect(handle)).toBe('gone')
  })

  it('keeps the minute after a Cancel across a stop of http', async () => {
    const { pluginsManager, connect, first } = await started()
    await connect()
    await pluginsManager.cancel(first())
    pluginsManager.crashed(door, 'closed')
    expect(await code(connect({ number: 4 }))).toBe('throttled')
  })

  it('withdraws nothing of a connect when mcp stops', async () => {
    const { pluginsManager, connect, collect } = await started()
    const handle = await connect()
    pluginsManager.crashed(mcpWorker, 'closed')
    expect(await collect(handle)).toBe('waiting')
  })

  it('applies nothing for a Confirm whose connect a stop of http withdrew while its record landed', async () => {
    const { pluginsManager, connect, collect, first, link } = await started()
    const handle = await connect()
    let land = () => {}
    const holding = new Promise<void>(held => {
      link.landing = event => (event === 'security.confirm' ? new Promise(resolve => {
        land = () => resolve('landed')
        held()
      }) : 'landed')
    })
    const confirming = code(pluginsManager.confirm(first(), {}))
    await holding
    pluginsManager.crashed(door, 'closed')
    land()
    expect(await confirming).toBe('not-found')
    expect(await collect(handle)).toBe('gone')
  })

  it('keeps the newest sixteen answers http never collected', async () => {
    const { pluginsManager, connect, collect, first } = await started()
    const handles: string[] = []
    for (let i = 1; i <= 17; i++) {
      handles.push(await connect({ number: i }))
      await pluginsManager.confirm(first(), {})
    }
    expect(await collect(handles[0]!)).toBe('gone')
    for (const handle of handles.slice(1)) expect(await collect(handle)).toBe('yes')
  })
})

describe('the connect\'s state alone', () => {
  // A host whose requests are the changes raised and not yet answered, ended or dropped by the test
  function alone() {
    const held = new Set<AgentConnect>()
    const connects = new Connects({ clock: () => 0, held: one => held.has(one), raise: one => (held.add(one), true), inUse: () => false })
    return { held, connects }
  }

  it('hands a yes only for the very change that waits, never for an older one that reads the same', () => {
    const { held, connects } = alone()
    connects.ask(asked)
    const older = [...held][0]!
    connects.ended()
    held.clear()
    const handle = connects.ask(asked)
    const newer = [...held][0]!
    expect(newer).toEqual(older)
    expect(() => connects.confirmed(older)).toThrow()
    expect(connects.answer(handle)).toBe('waiting')
    connects.confirmed(newer)
    expect(connects.answer(handle)).toBe('yes')
  })
})

describe('the Confirm of a connect', () => {
  it('changes no state: nothing on mcp\'s entry, in the switches or in what the gate sees', async () => {
    const { pluginsManager, connect, state, first, gate } = await started({ agents: [{ agent: 'client#1', capability: inbox }] })
    const before = await state()
    const views = gate.seen.length
    await connect()
    await pluginsManager.confirm(first(), {})
    expect(await state()).toEqual(before)
    expect(gate.seen.length).toBe(views)
  })

  it('goes stale against no write, so another agent\'s Confirm or a write of the switches meanwhile leaves it to be confirmed', async () => {
    const { pluginsManager, connect, collect, agentAsk, state, dataDir } = await started()
    await agentAsk('client#1', [inbox])
    const handle = await connect()
    const [ask, connecting] = pluginsManager.pending()
    await pluginsManager.confirm(ask!.id, {})
    expect((await state()).plugins.mcp!.agents).toEqual([{ agent: 'client#1', capability: inbox }])
    const switches = (await state()).switches
    await new StateStore(dataDir).writeSwitches({ ...switches, devMode: ['search'] })
    await pluginsManager.confirm(connecting!.id, {})
    expect(await collect(handle)).toBe('yes')
  })

  it('fails when the label was revoked while it waited and hands no yes', async () => {
    const { pluginsManager, connect, collect, agentAsk, first } = await started()
    const handle = await connect()
    const id = first()
    // The label asks under a door call before its connect is answered, then the human turns it away
    await agentAsk(LABEL, [inbox])
    await pluginsManager.request({ kind: 'agent.revoke', agent: LABEL }, trusted)
    expect(pluginsManager.pending().map(one => one.id)).toEqual([id])
    expect(await code(pluginsManager.confirm(id, {}))).toBe('failed')
    expect(await collect(handle)).toBe('waiting')
  })
})

describe('a connect in the line of requests', () => {
  it('waits in the order it was raised, behind the asks before it and before the asks after it', async () => {
    const { pluginsManager, connect, agentAsk, list } = await started()
    await agentAsk('client#1', [inbox])
    await connect()
    await agentAsk('client#2', [inbox])
    expect(pluginsManager.pending().map(one => one.kind)).toEqual(['agent.ask', 'agent.connect', 'agent.ask'])
    expect((await list()).requests[1]!.agent).toBe(LABEL)
  })

  it('is taken behind sixteen asks, in a place of its own, lapsing there if they are not answered within its minute', async () => {
    const { pluginsManager, connect, collect, agentAsk, clock } = await started()
    for (let i = 1; i <= 16; i++) await agentAsk(`client#${i}`, [inbox])
    expect(await code(agentAsk('client#17', [inbox]))).toBe('throttled')
    const handle = await connect()
    expect(pluginsManager.pending().map(one => one.kind).indexOf('agent.connect')).toBe(16)
    clock.now += 60_000
    expect(await collect(handle)).toBe('gone')
    expect(pluginsManager.pending()).toHaveLength(16)
  })
})
