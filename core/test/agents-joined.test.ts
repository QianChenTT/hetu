import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
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

// The joined core over a real boot with the real gate and luoshu. http is the install plugin whose utility half the test
// drives as the door, naming two agents. mcp is the install's own copy, a worker the test answers for, holding read on
// everything, with its entry seeded with agent #1's labelled item for inbox. Agent #2 has no item
async function joined(gate: 'on' | 'off') {
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  const folder = path.join(base, 'notes')
  await mkdir(path.join(folder, 'inbox'), { recursive: true })
  await mkdir(path.join(folder, 'private'), { recursive: true })
  await writeFile(path.join(folder, 'inbox', 'a.md'), 'inbox text')
  await writeFile(path.join(folder, 'private', 'b.md'), 'SECRET')
  // A link in inbox that leads into private. A junction, which Windows makes with no admin rights
  await symlink(path.join(folder, 'private'), path.join(folder, 'inbox', 'link'), 'junction')
  const mcp = filesFor(workerManifest('mcp', { capabilities: [everything], provides: { actions: { handle: { from: ['http'] } } } }))
  await writeInstall(installDir, {
    ...coreInstall(),
    luoshu: { files: filesFor(hostManifest('luoshu')) },
    http: { files: filesFor(hostManifest('http', { capabilities: [{ type: 'plugin.call', targets: ['mcp'] }] })) },
    mcp: { files: mcp, firstParty: true },
  })
  const store = new StateStore(dataDir)
  await store.writeSwitches(gate === 'off' ? { ...defaultSwitches(), off: ['gate'] } : defaultSwitches())
  await store.writeLuoshu({ folder })
  const root = path.join(dataDir, 'plugins', 'mcp')
  await writeFolder(root, mcp)
  await store.writePlugin('mcp', firstPartyEntry(await hashOf(root), {
    granted: [everything], class: 1, agents: [{ agent: 'client#1', capability: { type: 'luoshu.read', paths: ['inbox/**'] } }],
  }))
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const luoshu = createLuoshu()
  const runtime = new FakeRuntime()
  runtime.behave = { gate: { exports: { gate: createGate() } }, luoshu: { exports: { provider: luoshu.provider, luoshu: luoshu.role } } }
  const { loader, carrier } = wireCore({ booted, installDir, runtime, confirmDelayMs: 0 })
  open.push(async () => {
    luoshu.close()
    await loader.shutdown().catch(() => {})
    carrier.close()
    await carrier.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true })
  })
  await loader.start()
  await loader.settled()
  return { loader, runtime, door: runtime.half('http', 1, 'utility'), mcp: runtime.half('mcp') }
}

let next = 1

// A call from a half with the envelope fields given and its reply
async function ask(half: Half, action: string, args: unknown, extra: object = {}): Promise<Message> {
  const id = 5000 + next++
  half.send({ v: 1, kind: 'call', id, action, args, ...extra })
  for (let waited = 0; waited < 3000; waited += 5) {
    const reply = half.inbox.find(message => message.kind === 'reply' && message.id === id)
    if (reply !== undefined) return reply
    await tick(5)
  }
  throw new Error(`no reply to ${action}`)
}

// The door hands mcp one request on behalf of label and mcp gets it as mcp.handle
async function request(door: Half, mcp: Half, label: string) {
  const id = 5000 + next++
  door.send({ v: 1, kind: 'call', id, action: 'mcp.handle', args: { body: '{}' }, onBehalf: label })
  for (let waited = 0; waited < 3000; waited += 5) {
    const got = mcp.inbox.find(message => message.kind === 'call' && message.action === 'mcp.handle' && message.onBehalf === label)
    if (got !== undefined) return { parent: got.callId as string }
    await tick(5)
  }
  throw new Error('mcp.handle never arrived')
}

const outcome = (reply: Message) => (reply.ok === true ? (reply.result as { text: string }).text : (reply.refusal as { code: string }).code)

describe('agents through the joined core', () => {
  it('lets agent #1 read inside its labelled item and refuses it the private note and a link into it, with the gate on', async () => {
    const { loader, door, mcp } = await joined('on')
    expect(loader.plugin('mcp')).toMatchObject({ state: 'ready' })
    const { parent } = await request(door, mcp, 'client#1')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent }))).toBe('inbox text')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'private/b.md' }, { parent }))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/link/b.md' }, { parent }))).toBe('not-granted')
    // The listing of inbox for agent #1 names its own note alone
    const listed = await ask(mcp, 'luoshu.list', {}, { parent })
    expect((listed.result as { paths: string[] }).paths).toEqual(['inbox/a.md'])
  })

  it('lets agent #2 with no item and mcp with no parent read nothing, with the gate on', async () => {
    const { door, mcp } = await joined('on')
    const { parent } = await request(door, mcp, 'client#2')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent }))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'private/b.md' }, { parent }))).toBe('not-granted')
    expect((await ask(mcp, 'luoshu.list', {}, { parent })).result).toEqual({ paths: [], next: null })
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'luoshu.list', {}))).toBe('not-granted')
  })

  it('refuses agent #1 both notes with the gate off, while the door\'s own call still reaches mcp', async () => {
    const { door, mcp } = await joined('off')
    const { parent } = await request(door, mcp, 'client#1')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent }))).toBe('policy-down')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'private/b.md' }, { parent }))).toBe('policy-down')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }))).toBe('not-granted')
  })
})
