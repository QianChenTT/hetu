import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import type { Call, Prepared } from '../api/policy-jobs.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore } from '../backend/boot/state.ts'
import { wireCore } from '../backend/wire.ts'
import { createGate } from '../backend/policy/gate/gate.ts'
import { createLuoshu } from '../backend/providers/luoshu/luoshu.ts'
import { luoshuModule } from './modules-fakes.ts'
import {
  coreInstall, FakeRuntime, filesFor, firstPartyEntry, hashOf, hostManifest, tempBase, tick, workerManifest, writeFolder, writeInstall,
  type Half, type Message,
} from './plugins-manager-fakes.ts'

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

const everything: Capability = { type: 'luoshu.read', paths: ['**'] }

// The joined core over a real boot with the real gate and luoshu. http is the core plugin whose utility half the test
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
  const mcpGrant: Capability[] = [everything, { type: 'plugin.call', targets: ['search'] }]
  const mcp = filesFor(workerManifest('mcp', { capabilities: mcpGrant, provides: { actions: { handle: { from: ['mcp-http-handler'] } } } }))
  const search = filesFor(workerManifest('search', { capabilities: [everything], provides: { actions: { query: {} } } }))
  await writeInstall(installDir, {
    ...coreInstall(),
    'mcp-http-handler': { files: filesFor(hostManifest('mcp-http-handler', { capabilities: [{ type: 'plugin.call', targets: ['mcp'] }] })) },
    mcp: { files: mcp, firstParty: true },
    search: { files: search, firstParty: true },
  })
  const store = new StateStore(dataDir)
  await store.writeSwitches(gate === 'off' ? { ...defaultSwitches(), off: ['gate'] } : defaultSwitches())
  await store.writeLuoshu({ folder })
  const root = path.join(dataDir, 'plugins', 'mcp')
  await writeFolder(root, mcp)
  await store.writePlugin('mcp', firstPartyEntry(await hashOf(root), {
    granted: mcpGrant, class: 1, agents: [
      { agent: 'client#1', capability: { type: 'luoshu.read', paths: ['inbox/**'] } },
      { agent: 'client#1', capability: { type: 'plugin.call', targets: ['search'] } },
      { agent: 'client#3', capability: { type: 'luoshu.read', paths: ['inbox/**', 'INBOX/**'] } },
    ],
  }))
  const searchRoot = path.join(dataDir, 'plugins', 'search')
  await writeFolder(searchRoot, search)
  await store.writePlugin('search', firstPartyEntry(await hashOf(searchRoot), { granted: [everything], class: 1 }))
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const luoshu = createLuoshu()
  // Runs once before the next perform, as another program acting on the folder between prepare and perform
  const hooks: { before: (() => Promise<void>) | null } = { before: null }
  const provider = {
    prepare: luoshu.provider.prepare,
    release: luoshu.provider.release,
    perform: async (call: Call, prepared: Prepared) => {
      const hook = hooks.before
      hooks.before = null
      await hook?.()
      return luoshu.provider.perform(call, prepared)
    },
  }
  const runtime = new FakeRuntime()
  const modules = { gate: createGate(), luoshu: luoshuModule(provider, luoshu.role) }
  const { recording, pluginsManager, router } = wireCore({ booted, installDir, runtime, modules, confirmDelayMs: 0 })
  open.push(async () => {
    luoshu.close()
    await pluginsManager.shutdown().catch(() => {})
    router.close()
    await recording.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true })
  })
  await pluginsManager.start()
  await pluginsManager.settled()
  return { pluginsManager, runtime, folder, hooks, door: runtime.half('mcp-http-handler', 1, 'utility'), mcp: runtime.half('mcp'), search: runtime.half('search') }
}

// A folder renamed under the luoshu's watch, which can hold it open for a moment on Windows
async function renamed(from: string, to: string): Promise<void> {
  for (let wait = 10; ; wait *= 2) {
    try {
      return await rename(from, to)
    } catch (err) {
      if (!['EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '') || wait > 1280) throw err
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
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

// The door hands mcp one request on behalf of label and mcp gets it as mcp.handle, each delivery taken once
const taken = new WeakSet<object>()
async function request(door: Half, mcp: Half, label: string) {
  const id = 5000 + next++
  door.send({ v: 1, kind: 'call', id, action: 'mcp.handle', args: { body: '{}' }, onBehalf: label })
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

const outcome = (reply: Message) => (reply.ok === true ? (reply.result as { text: string }).text : (reply.refusal as { code: string }).code)

describe('agents through the joined core', () => {
  it('lets agent #1 read inside its labelled item and refuses it the private note and a link into it, with the gate on', async () => {
    const { pluginsManager, door, mcp } = await joined('on')
    expect(pluginsManager.plugin('mcp')).toMatchObject({ state: 'ready' })
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

  it('refuses mcp\'s search with no call from the door live and filters search\'s answer for agent #1 under its call', async () => {
    const { door, mcp, search } = await joined('on')
    const notes = ['inbox/a.md', 'private/b.md']
    expect(outcome(await ask(mcp, 'search.query', { text: 'SECRET' }))).toBe('not-granted')
    const { parent } = await request(door, mcp, 'client#1')
    // The parent left out while agent #1's call is live
    expect(outcome(await ask(mcp, 'search.query', { text: 'SECRET' }))).toBe('not-granted')
    expect(search.inbox.filter(message => message.kind === 'call')).toEqual([])
    const id = 5000 + next++
    mcp.send({ v: 1, kind: 'call', id, action: 'search.query', args: { text: 'SECRET' }, parent })
    let got: Message | undefined
    for (let waited = 0; got === undefined && waited < 3000; waited += 5) {
      got = search.inbox.find(message => message.kind === 'call' && message.action === 'search.query')
      if (got === undefined) await tick(5)
    }
    expect(got?.onBehalf).toBe('client#1')
    expect((await ask(search, 'gate.filterReadable', { call: got!.callId, paths: notes })).result).toEqual(['inbox/a.md'])
  })

  it('lets agent #2 read inside the items its ask was confirmed for from its next call on and nothing before', async () => {
    const { pluginsManager, door, mcp } = await joined('on')
    const before = await request(door, mcp, 'client#2')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, before))).toBe('not-granted')
    const asked = await ask(mcp, 'core.identityAsk', { capabilities: [{ type: 'luoshu.read', paths: ['inbox/**'] }] }, before)
    expect(asked.result).toEqual({ asked: 'waiting' })
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, before))).toBe('not-granted')
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    const after = await request(door, mcp, 'client#2')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, after))).toBe('inbox text')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'private/b.md' }, after))).toBe('not-granted')
    // The call made before the Confirm, still live, is judged on the grants snapshot now too
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, before))).toBe('inbox text')
  })

  it('refuses agent #1\'s next judgement once revoked while its call waits, then tells http it is revoked until http heard', async () => {
    const { pluginsManager, door, mcp } = await joined('on')
    const { parent } = await request(door, mcp, 'client#1')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent }))).toBe('inbox text')
    const trusted = { kind: 'window', role: 'trusted', n: 1 } as const
    expect(await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)).toEqual({ applied: true })
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent }))).toBe('not-granted')
    expect((await ask(door, 'core.identities', { agents: ['client#1', 'client#3'] })).result).toEqual([
      { agent: 'client#1', holds: 'revoked' }, { agent: 'client#3', holds: 'items' },
    ])
    // A revoked label asks again only under a number never used again
    expect(outcome(await ask(mcp, 'core.identityAsk', { capabilities: [{ type: 'luoshu.read', paths: ['inbox/**'] }] }, { parent }))).toBe('not-granted')
    expect((await ask(door, 'core.identities', { agents: ['client#1'], heard: ['client#1'] })).result).toEqual([{ agent: 'client#1', holds: 'none' }])
  })

  it('refuses the door\'s next call for agent #1 once revoked before mcp sees it with no word from http and still delivers agent #3\'s', async () => {
    const { pluginsManager, door, mcp } = await joined('on')
    const trusted = { kind: 'window', role: 'trusted', n: 1 } as const
    await pluginsManager.request({ kind: 'identity.revoke', agent: 'client#1' }, trusted)
    const delivered = () => mcp.inbox.filter(message => message.kind === 'call' && message.action === 'mcp.handle').length
    const before = delivered()
    expect(outcome(await ask(door, 'mcp.handle', { body: '{}' }, { onBehalf: 'client#1' }))).toBe('not-granted')
    expect(delivered()).toBe(before)
    await request(door, mcp, 'client#3')
  })

  it('refuses the door\'s call for agent #1 policy-down with the gate off before mcp sees it', async () => {
    const { door, mcp } = await joined('off')
    expect(outcome(await ask(door, 'mcp.handle', { body: '{}' }, { onBehalf: 'client#1' }))).toBe('policy-down')
    expect(mcp.inbox.filter(message => message.kind === 'call' && message.action === 'mcp.handle')).toEqual([])
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }))).toBe('not-granted')
  })

  // The luoshu resolves inbox/a.md again once inbox is renamed INBOX after prepare and asks the judge about INBOX/a.md,
  // which the grants snapshot keeps apart from inbox. mcp holds every path, so the agent's grant decides
  const caseOnly = process.platform === 'win32' || process.platform === 'darwin'
  it.runIf(caseOnly)('judges an agent\'s read again against the agent\'s grant when its folder is renamed in case between prepare and perform', async () => {
    const { door, mcp, folder, hooks } = await joined('on')
    const recase = async () => {
      await renamed(path.join(folder, 'inbox'), path.join(folder, 'inbox-was'))
      await renamed(path.join(folder, 'inbox-was'), path.join(folder, 'INBOX'))
    }
    const one = await request(door, mcp, 'client#1')
    hooks.before = recase
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent: one.parent }))).toBe('not-granted')
    await renamed(path.join(folder, 'INBOX'), path.join(folder, 'inbox-was'))
    await renamed(path.join(folder, 'inbox-was'), path.join(folder, 'inbox'))
    const three = await request(door, mcp, 'client#3')
    hooks.before = recase
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent: three.parent }))).toBe('inbox text')
  })
})
