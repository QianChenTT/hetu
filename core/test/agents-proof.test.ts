import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecurityList } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import type { Call } from '../api/slots.ts'
import { toolFor, toolList } from '../api/tools.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore } from '../backend/boot/state.ts'
import { wireCore } from '../backend/wire.ts'
import { createGate } from '../../core-plugins/gate/src/gate.ts'
import { createHistory } from '../../core-plugins/history/src/history.ts'
import { createLuoshu } from '../../core-plugins/luoshu/src/luoshu.ts'
import {
  coreInstall, FakeRuntime, filesFor, firstPartyEntry, hashOf, hostManifest, tempBase, tick, workerManifest, writeFolder, writeInstall,
  type Half, type Message,
} from './loader-fakes.ts'

const open: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

const everything: Capability = { type: 'luoshu.read', paths: ['**'] }
const inbox: Capability = { type: 'luoshu.read', paths: ['inbox/**'] }
const privateNotes: Capability = { type: 'luoshu.read', paths: ['private/**'] }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const mcpOf = (version: string, capabilities: Capability[]) => filesFor({ ...workerManifest('mcp', { capabilities, provides: { actions: { handle: { from: ['http'] } } } }), version })

// One folder of notes and one install, booted as often as the proof needs: the real boot, loader, carrier, gate and
// luoshu, http the install's utility plugin the test drives as the door and mcp the install's own copy, a worker the
// test answers for, holding read on every note unless items names its own and the agents' items and marks seed gives
// it, none unless named. history adds hetu's history as it ships
async function world(
  seed: { agents?: { agent: string, capability: Capability }[], revoked?: string[] } = {},
  options: { items?: Capability[], history?: boolean } = {},
) {
  const items = options.items ?? [everything]
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  const folder = path.join(base, 'notes')
  await mkdir(path.join(folder, 'inbox'), { recursive: true })
  await mkdir(path.join(folder, 'private'), { recursive: true })
  await writeFile(path.join(folder, 'inbox', 'a.md'), 'inbox text')
  await writeFile(path.join(folder, 'private', 'b.md'), 'private text')
  const install = (mcpVersion: string) => writeInstall(installDir, {
    ...coreInstall(),
    luoshu: { files: filesFor(hostManifest('luoshu')) },
    http: { files: filesFor(hostManifest('http', { capabilities: [{ type: 'plugin.call', targets: ['mcp'] }] })) },
    mcp: { files: mcpOf(mcpVersion, items), firstParty: true },
    ...(options.history === true ? { history: { files: filesFor(hostManifest('history', { requires: ['luoshu'] })) } } : {}),
  })
  await install('1.0.0')
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder })
  const root = path.join(dataDir, 'plugins', 'mcp')
  await writeFolder(root, mcpOf('1.0.0', items))
  await store.writePlugin('mcp', firstPartyEntry(await hashOf(root), { granted: items, class: 1, ...seed }))
  open.push(() => rm(base, { recursive: true, force: true }))

  // One run of hetu over that folder, ended by the next start or the test's end
  let end: (() => Promise<void>) | null = null
  async function start() {
    await end?.()
    const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
    const luoshu = createLuoshu()
    const history = options.history === true ? createHistory() : null
    await history?.start(dataDir)
    const runtime = new FakeRuntime()
    runtime.behave = {
      gate: { exports: { gate: createGate() } },
      luoshu: { exports: { provider: luoshu.provider, luoshu: luoshu.role } },
      ...(history === null ? {} : { history: { exports: { provider: history.provider, history: history.role } } }),
    }
    const { loader, carrier } = wireCore({ booted, installDir, runtime, confirmDelayMs: 0 })
    const stop = async () => {
      luoshu.close()
      history?.close()
      await loader.shutdown().catch(() => {})
      carrier.close()
      await carrier.flush()
      for (const port of runtime.ports) port.close()
      await booted.release()
    }
    end = async () => {
      end = null
      await stop()
    }
    open.unshift(async () => end?.())
    await loader.start()
    await loader.settled()
    const list = async () => await loader.serve({ callId: 'list', caller: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 } as Call) as SecurityList
    return { loader, runtime, list, door: runtime.half('http', 1, 'utility') }
  }
  return { start, install, stored: async () => (await new StateStore(dataDir).load()).state.plugins.mcp }
}

let next = 1
async function ask(half: Half, action: string, args: unknown, extra: object = {}): Promise<Message> {
  const id = 9000 + next++
  half.send({ v: 1, kind: 'call', id, action, args, ...extra })
  for (let waited = 0; waited < 3000; waited += 5) {
    const reply = half.inbox.find(message => message.kind === 'reply' && message.id === id)
    if (reply !== undefined) return reply
    await tick(5)
  }
  throw new Error(`no reply to ${action}`)
}

// The door hands mcp a request for label, giving the parent mcp's calls under it name
const taken = new WeakSet<object>()
async function request(door: Half, mcp: Half, label: string) {
  door.send({ v: 1, kind: 'call', id: 9000 + next++, action: 'mcp.handle', args: { body: '{}' }, onBehalf: label })
  for (let waited = 0; waited < 3000; waited += 5) {
    const got = mcp.inbox.find(message => message.kind === 'call' && message.action === 'mcp.handle' && message.onBehalf === label && !taken.has(message))
    if (got !== undefined) {
      taken.add(got)
      return { parent: got.callId as string }
    }
    await tick(5)
  }
  throw new Error('mcp.handle never arrived')
}

const outcome = (reply: Message) => (reply.ok === true ? (reply.result as { text?: string }).text ?? JSON.stringify(reply.result) : (reply.refusal as { code: string }).code)
const read = async (mcp: Half, under: { parent: string }, note: string) => outcome(await ask(mcp, 'luoshu.read', { path: note }, under))

describe('step 5a part A in the joined core', () => {
  it('asks, confirms, goes stale, revokes, carries across an update, drops on Recover, withdraws on a stop and refuses with the gate off', async () => {
    const proof = await world()
    let run = await proof.start()
    let mcp = run.runtime.half('mcp')

    // #1 asks for luoshu.read on inbox/**. The trusted window shows the label and the scope in quotes
    const one = await request(run.door, mcp, 'client#1')
    expect(await read(mcp, one, 'inbox/a.md')).toBe('not-granted')
    expect((await ask(mcp, 'core.agentAsk', { capabilities: [inbox] }, one)).result).toEqual({ asked: 'waiting' })
    const two = await request(run.door, mcp, 'client#2')
    expect((await ask(mcp, 'core.agentAsk', { capabilities: [privateNotes] }, two)).result).toEqual({ asked: 'waiting' })
    const shown = (await run.list()).requests
    expect(shown.map(held => held.text)).toEqual([
      'Give the agent "client#1" what it asks for through mcp', 'Give the agent "client#2" what it asks for through mcp',
    ])
    expect(shown[0].notes[0]).toBe('It asks for: luoshu.read on "inbox/**"')
    // Before the Confirm #1 reads nothing, after it inbox and not private
    expect(await read(mcp, one, 'inbox/a.md')).toBe('not-granted')
    await run.loader.confirm(shown[0].id, {})
    expect(await read(mcp, one, 'inbox/a.md')).toBe('inbox text')
    expect(await read(mcp, one, 'private/b.md')).toBe('not-granted')

    // #2's ask read mcp's entry before #1's Confirm wrote it, so it went stale and #2 asks again
    await expect(run.loader.confirm(shown[1].id, {})).rejects.toMatchObject({ code: 'stale' })
    expect((await ask(mcp, 'core.agentAsk', { capabilities: [privateNotes] }, two)).result).toEqual({ asked: 'waiting' })
    await run.loader.confirm(run.loader.pending()[0].id, {})
    expect(await read(mcp, two, 'private/b.md')).toBe('private text')

    // Revoke of #1 refuses its next call at once and the core tells http it is revoked
    expect(await run.loader.request({ kind: 'agent.revoke', agent: 'client#1' }, trusted)).toEqual({ applied: true })
    expect(await read(mcp, one, 'inbox/a.md')).toBe('not-granted')
    expect((await ask(run.door, 'core.agents', { agents: ['client#1', 'client#2'] })).result).toEqual([
      { agent: 'client#1', holds: 'revoked' }, { agent: 'client#2', holds: 'items' },
    ])
    expect((await run.list()).agents).toEqual([
      { agent: 'client#2', items: [privateNotes], revoked: false }, { agent: 'client#1', items: [], revoked: true },
    ])

    // An update of mcp keeps #2's grant
    await proof.install('1.1.0')
    run = await proof.start()
    mcp = run.runtime.half('mcp')
    expect((await proof.stored()).version).toBe('1.1.0')
    expect((await proof.stored()).agents).toEqual([{ agent: 'client#2', capability: privateNotes }])
    // The copy left mcp's class unknown with no grant risk classifier here, so mcp's own item asks at its first use as
    // any updated plugin's does. Its Confirm is the human's, then #2 reads with the grant it kept
    const kept = await request(run.door, mcp, 'client#2')
    expect(await read(mcp, kept, 'private/b.md')).toBe('needs-confirm')
    expect(run.loader.pending().map(held => held.kind)).toEqual(['item.on'])
    await run.loader.confirm(run.loader.pending()[0].id, {})
    expect(await read(mcp, kept, 'private/b.md')).toBe('private text')
    expect((await ask(run.door, 'core.agents', { agents: ['client#1'] })).result).toEqual([{ agent: 'client#1', holds: 'revoked' }])

    // A Recover drops it
    const restore = await run.loader.request({ kind: 'plugin.restore', plugin: 'mcp' }, trusted)
    if (!('held' in restore)) throw new Error('a restore applied at once')
    await run.loader.confirm(restore.held, {})
    await run.loader.settled()
    mcp = run.runtime.half('mcp', 2)
    const after = await request(run.door, mcp, 'client#2')
    expect(await read(mcp, after, 'private/b.md')).toBe('not-granted')
    expect((await proof.stored()).agents).toBeUndefined()

    // A Confirm after mcp stopped is refused
    expect((await ask(mcp, 'core.agentAsk', { capabilities: [privateNotes] }, after)).result).toEqual({ asked: 'waiting' })
    const waiting = run.loader.pending()[0].id
    expect(await run.loader.request({ kind: 'plugin.off', plugin: 'mcp' }, trusted)).toEqual({ applied: true })
    await run.loader.settled()
    await expect(run.loader.confirm(waiting, {})).rejects.toMatchObject({ code: 'not-found' })
    expect((await proof.stored()).agents).toBeUndefined()

    // With the gate switched off the door's call is refused before mcp sees it
    expect(await run.loader.request({ kind: 'plugin.on', plugin: 'mcp' }, trusted)).toMatchObject({ held: expect.any(String) })
    await run.loader.confirm(run.loader.pending()[0].id, {})
    await run.loader.settled()
    const off = await run.loader.request({ kind: 'plugin.off', plugin: 'gate' }, trusted)
    if (!('held' in off)) throw new Error('the gate went off at once')
    await run.loader.confirm(off.held, { typed: 'gate' })
    mcp = run.runtime.half('mcp', 3)
    const before = mcp.inbox.length
    expect(outcome(await ask(run.door, 'mcp.handle', { body: '{}' }, { onBehalf: 'client#2' }))).toBe('policy-down')
    expect(mcp.inbox.slice(before).filter(message => message.kind === 'call')).toEqual([])
  })
})

describe('step 5a part B, the connect, in the joined core', () => {
  const CLAUDE = 'https://claude.ai/oauth/claude-code-client-metadata'
  const asked = (number: number, client = CLAUDE) => ({ client, name: 'Claude Code', redirect: 'http://localhost:33418/callback', number })
  const handleOf = (reply: Message) => (reply.result as { handle: string }).handle
  // The newest incarnation of a plugin's half, the one a call is delivered to
  const latest = (runtime: FakeRuntime, id: string, place: 'worker' | 'utility' = 'worker') => {
    let found: Half | null = null
    for (let n = 1; n <= 20; n++) {
      try {
        found = runtime.half(id, n, place)
      } catch {}
    }
    return found!
  }
  const answerOf = async (door: Half, handle: string) => ((await ask(door, 'core.agentConnected', { handle })).result as { answer: string }).answer

  it('connects a new agent under a client id another agent holds a grant under, once, refuses a second, drops it with http and refuses a revoked label', async () => {
    const proof = await world({ agents: [{ agent: `${CLAUDE}#1`, capability: inbox }], revoked: [`${CLAUDE}#2`] })
    const run = await proof.start()
    const mcp = run.runtime.half('mcp')

    // http raises a connect for #3 under the client id #1 holds inbox under. The trusted window shows the host first,
    // the name in quotes and the new label
    const handle = handleOf(await ask(run.door, 'core.agentConnect', asked(3)))
    const shown = (await run.list()).requests
    expect(shown.map(held => [held.kind, held.text, held.agent])).toEqual([[
      'agent.connect', `Connect the client from "claude.ai" named "Claude Code", which returns to "localhost:33418", as the agent "${CLAUDE}#3"`, `${CLAUDE}#3`,
    ]])
    // Before the Confirm the collect answers waiting, a second connect while it waits is refused
    expect(await answerOf(run.door, handle)).toBe('waiting')
    expect(outcome(await ask(run.door, 'core.agentConnect', asked(1, 'other-client')))).toBe('throttled')
    await run.loader.confirm(shown[0]!.id, {})
    expect(await answerOf(run.door, handle)).toBe('yes')
    expect(await answerOf(run.door, handle)).toBe('gone')
    // The new agent holds nothing, #1 still holds its grant
    expect((await ask(run.door, 'core.agents', { agents: [`${CLAUDE}#1`, `${CLAUDE}#3`] })).result).toEqual([
      { agent: `${CLAUDE}#1`, holds: 'items' }, { agent: `${CLAUDE}#3`, holds: 'none' },
    ])
    const three = await request(run.door, mcp, `${CLAUDE}#3`)
    expect(await read(mcp, three, 'inbox/a.md')).toBe('not-granted')
    const one = await request(run.door, mcp, `${CLAUDE}#1`)
    expect(await read(mcp, one, 'inbox/a.md')).toBe('inbox text')

    // A connect waiting when http restarts is gone and can't be confirmed
    const waiting = handleOf(await ask(run.door, 'core.agentConnect', asked(4)))
    const id = run.loader.pending()[0]!.id
    await run.loader.serve({ callId: 'restart', caller: trusted, action: 'core.restart', args: { plugin: 'http' }, deadline: Date.now() + 30_000 } as Call)
    await run.loader.settled()
    const door = latest(run.runtime, 'http', 'utility')
    expect(run.loader.pending()).toEqual([])
    await expect(run.loader.confirm(id, {})).rejects.toMatchObject({ code: 'not-found' })
    expect(await answerOf(door, waiting)).toBe('gone')

    // A connect for a revoked label is refused and a door call under it never reaches mcp
    expect(outcome(await ask(door, 'core.agentConnect', asked(2)))).toBe('not-granted')
    expect(run.loader.pending()).toEqual([])
    const mcpThen = latest(run.runtime, 'mcp')
    const before = mcpThen.inbox.length
    expect(outcome(await ask(door, 'mcp.handle', { body: '{}' }, { onBehalf: `${CLAUDE}#2` }))).toBe('not-granted')
    expect(mcpThen.inbox.slice(before).filter(message => message.kind === 'call')).toEqual([])

    // With the gate switched off a connect is raised and confirmed while the new agent's door call is refused before mcp
    const off = await run.loader.request({ kind: 'plugin.off', plugin: 'gate' }, trusted)
    if (!('held' in off)) throw new Error('the gate went off at once')
    await run.loader.confirm(off.held, { typed: 'gate' })
    await run.loader.settled()
    const now = latest(run.runtime, 'http', 'utility')
    const five = handleOf(await ask(now, 'core.agentConnect', asked(5)))
    await run.loader.confirm(run.loader.pending()[0]!.id, {})
    expect(await answerOf(now, five)).toBe('yes')
    const mcpNow = latest(run.runtime, 'mcp')
    const seen = mcpNow.inbox.length
    expect(outcome(await ask(now, 'mcp.handle', { body: '{}' }, { onBehalf: `${CLAUDE}#5` }))).toBe('policy-down')
    expect(mcpNow.inbox.slice(seen).filter(message => message.kind === 'call')).toEqual([])
  })
})

describe('step 5a part B, the tools, in the joined core', () => {
  const inboxWrite: Capability = { type: 'luoshu.write', paths: ['inbox/**'] }
  const privateWrite: Capability = { type: 'luoshu.write', paths: ['private/**'] }
  const historyOf = (access: 'read' | 'commit', paths: string[]): Capability => ({ type: 'history', access, paths })

  // A fake mcp's call of a tool under the door's request: the tool's own schema first, then its row's action as a call
  // under that request, which the carrier judges against mcp's items and the agent's
  async function call(mcp: Half, under: { parent: string }, name: string, args: unknown) {
    const found = toolFor(name)
    if (found === null) throw new Error(`no tool ${name}`)
    return await ask(mcp, found.action, found.args.parse(args), under)
  }

  it('lists the four tools and reaches each one\'s provider for an agent, judged against mcp\'s items and the agent\'s', async () => {
    // mcp reads every note and its history and writes only in inbox. #1 reads inbox and its history and writes in both
    // folders. #2 holds nothing. mcp reaches a provider only for an agent whose call from the door is live
    const proof = await world(
      {
        agents: [
          { agent: 'client#1', capability: inbox }, { agent: 'client#1', capability: inboxWrite }, { agent: 'client#1', capability: privateWrite },
          { agent: 'client#1', capability: historyOf('read', ['inbox/**']) },
        ],
      },
      { items: [everything, inboxWrite, historyOf('read', ['**'])], history: true },
    )
    const run = await proof.start()
    const mcp = run.runtime.half('mcp')
    expect(toolList().map(tool => tool.name)).toEqual(['read_note', 'list_notes', 'write_note', 'note_history'])
    const one = await request(run.door, mcp, 'client#1')
    const two = await request(run.door, mcp, 'client#2')

    // read_note: inbox for #1, not private, which mcp reads and #1 doesn't
    expect(outcome(await call(mcp, one, 'read_note', { path: 'inbox/a.md' }))).toBe('inbox text')
    expect(outcome(await call(mcp, one, 'read_note', { path: 'private/b.md' }))).toBe('not-granted')
    expect(outcome(await call(mcp, two, 'read_note', { path: 'inbox/a.md' }))).toBe('not-granted')

    // list_notes: only what the agent may list, nothing for #2
    expect((await call(mcp, one, 'list_notes', {})).result).toEqual({ paths: ['inbox/a.md'], next: null })
    expect((await call(mcp, two, 'list_notes', {})).result).toEqual({ paths: [], next: null })

    // write_note: inbox, which both hold. Not private, which #1 holds and mcp doesn't
    const written = await call(mcp, one, 'write_note', { path: 'inbox/new.md', text: 'new text' })
    expect(written.result).toEqual({ version: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(outcome(await call(mcp, one, 'read_note', { path: 'inbox/new.md' }))).toBe('new text')
    expect(outcome(await call(mcp, one, 'write_note', { path: 'private/c.md', text: 'x' }))).toBe('not-granted')
    expect(outcome(await call(mcp, two, 'write_note', { path: 'inbox/other.md', text: 'x' }))).toBe('not-granted')

    // A move and a remove in inbox, where #1 and mcp both write and read, are actions no tool marks and are refused at
    // the floor under #1's call. The note stays where it was with its text
    const version = (written.result as { version: string }).version
    expect(outcome(await ask(mcp, 'luoshu.move', { from: 'inbox/new.md', to: 'inbox/moved.md' }, one))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'luoshu.remove', { path: 'inbox/new.md', baseVersion: version }, one))).toBe('not-granted')
    expect(outcome(await call(mcp, one, 'read_note', { path: 'inbox/new.md' }))).toBe('new text')
    expect(outcome(await call(mcp, one, 'read_note', { path: 'inbox/moved.md' }))).toBe('not-found')

    // note_history: inbox for #1, answered by history with no commit yet. Not private, whose history mcp reads and #1
    // doesn't
    expect((await call(mcp, one, 'note_history', { path: 'inbox/a.md' })).result).toEqual({ commits: [] })
    expect(outcome(await call(mcp, one, 'note_history', { path: 'private/b.md' }))).toBe('not-granted')
    expect(outcome(await call(mcp, two, 'note_history', { path: 'inbox/a.md' }))).toBe('not-granted')

    // A tool's schema refuses a dot folder before any call is made
    expect(() => toolFor('read_note')!.args.parse({ path: '.obsidian/app.json' })).toThrow()
  })
})
