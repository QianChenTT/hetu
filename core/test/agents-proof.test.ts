import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecurityList } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import type { Call } from '../api/slots.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore } from '../backend/boot/state.ts'
import { wireCore } from '../backend/wire.ts'
import { createGate } from '../../plugins/gate/src/gate.ts'
import { createLuoshu } from '../../plugins/luoshu/src/luoshu.ts'
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
const mcpOf = (version: string) => filesFor({ ...workerManifest('mcp', { capabilities: [everything], provides: { actions: { handle: { from: ['http'] } } } }), version })

// One folder of notes and one install, booted as often as the proof needs: the real boot, loader, carrier, gate and
// luoshu, http the install's utility plugin the test drives as the door and mcp the install's own copy, a worker the
// test answers for, holding read on every note and no agent's item
async function world() {
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
    mcp: { files: mcpOf(mcpVersion), firstParty: true },
  })
  await install('1.0.0')
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder })
  const root = path.join(dataDir, 'plugins', 'mcp')
  await writeFolder(root, mcpOf('1.0.0'))
  await store.writePlugin('mcp', firstPartyEntry(await hashOf(root), { granted: [everything], class: 1 }))
  open.push(() => rm(base, { recursive: true, force: true }))

  // One run of hetu over that folder, ended by the next start or the test's end
  let end: (() => Promise<void>) | null = null
  async function start() {
    await end?.()
    const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
    const luoshu = createLuoshu()
    const runtime = new FakeRuntime()
    runtime.behave = { gate: { exports: { gate: createGate() } }, luoshu: { exports: { provider: luoshu.provider, luoshu: luoshu.role } } }
    const { loader, carrier } = wireCore({ booted, installDir, runtime, confirmDelayMs: 0 })
    const stop = async () => {
      luoshu.close()
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

// The door hands mcp a request for label, and mcp's call under it
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
    // The copy left mcp's class unknown with no capabilities plugin here, so mcp's own item asks at its first use as
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
