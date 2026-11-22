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
  coreInstall, entryFor, FakeRuntime, filesFor, hashOf, hostManifest, tempBase, tick, workerManifest, writeFolder, writeInstall,
  type Half, type Message,
} from './plugins-manager-fakes.ts'

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

const everything: Capability = { type: 'luoshu.read', paths: ['**'] }

// The joined core over a real boot with the real gate and luoshu. mcp-http-handler is the core plugin whose utility
// half the test drives as the root of each chain, naming a field on its calls. mcp is a plugin-folder plugin approved
// unsigned by its hash, a worker the test answers for, holding read on everything. With the gate on, the pair of the handler and client-1 is given
// read on inbox through mcp's ask and the human's Confirm, as is client-3 on inbox. client-2 holds nothing
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
  const mcpGrant: Capability[] = [everything, { type: 'plugin.call', targets: ['artifacts'] }]
  const mcp = filesFor(workerManifest('mcp', { capabilities: mcpGrant, provides: { actions: { handle: { from: ['mcp-http-handler'] } } } }))
  const artifacts = filesFor(workerManifest('artifacts', { capabilities: [everything], provides: { actions: { query: {} } } }))
  await writeInstall(installDir, {
    ...coreInstall(),
    'mcp-http-handler': { files: filesFor(hostManifest('mcp-http-handler', { capabilities: [{ type: 'plugin.call', targets: ['mcp'] }] })) },
  })
  const store = new StateStore(dataDir)
  const root = path.join(dataDir, 'plugins', 'mcp')
  await writeFolder(root, mcp)
  const allowUnsigned = [await hashOf(root)]
  await store.writeSwitches(gate === 'off' ? { ...defaultSwitches(), off: ['gate'], allowUnsigned } : { ...defaultSwitches(), allowUnsigned })
  await store.writeLuoshu({ folder })
  await store.writePlugin('mcp', await entryFor(root, { signer: null, granted: mcpGrant, class: 1 }))
  const artifactsRoot = path.join(dataDir, 'plugins', 'artifacts')
  await writeFolder(artifactsRoot, artifacts)
  await store.writePlugin('artifacts', await entryFor(artifactsRoot, { granted: [everything], class: 1 }))
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
  const door = runtime.half('mcp-http-handler', 1, 'utility')
  const mcpHalf = runtime.half('mcp')
  if (gate === 'on') {
    // Each pair's items asked for by mcp under the handler's call and confirmed, as the human would
    for (const [field, paths] of [['client-1', ['inbox/**']], ['client-3', ['inbox/**', 'INBOX/**']]] as const) {
      const { parent } = await request(door, mcpHalf, field)
      await ask(mcpHalf, 'core.identityAsk', { capabilities: [{ type: 'luoshu.read', paths }] }, { parent })
      await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    }
  }
  return { pluginsManager, runtime, folder, hooks, door, mcp: mcpHalf, artifacts: runtime.half('artifacts') }
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

describe('pairs through the joined core', () => {
  it('lets client-1 read inside its pair\'s item and refuses it the private note and a link into it, with the gate on', async () => {
    const { pluginsManager, door, mcp } = await joined('on')
    expect(pluginsManager.plugin('mcp')).toMatchObject({ state: 'ready' })
    const { parent } = await request(door, mcp, 'client-1')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent }))).toBe('inbox text')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'private/b.md' }, { parent }))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/link/b.md' }, { parent }))).toBe('not-granted')
    // The listing for client-1 names the note inbox holds alone
    const listed = await ask(mcp, 'luoshu.list', {}, { parent })
    expect((listed.result as { paths: string[] }).paths).toEqual(['inbox/a.md'])
  })

  it('lets client-2 with no item read nothing and mcp with no parent read on its own grant, with the gate on', async () => {
    const { door, mcp } = await joined('on')
    const { parent } = await request(door, mcp, 'client-2')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent }))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'private/b.md' }, { parent }))).toBe('not-granted')
    expect((await ask(mcp, 'luoshu.list', {}, { parent })).result).toEqual({ paths: [], next: null })
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }))).toBe('inbox text')
  })

  it('refuses artifacts under client-1\'s call since no pair holds plugin.call, artifacts hearing nothing', async () => {
    const { door, mcp, artifacts } = await joined('on')
    const { parent } = await request(door, mcp, 'client-1')
    expect(outcome(await ask(mcp, 'artifacts.query', { text: 'SECRET' }, { parent }))).toBe('not-granted')
    expect(artifacts.inbox.filter(message => message.kind === 'call')).toEqual([])
  })

  it('lets client-2 read inside the items its ask was confirmed for from its next call on and nothing before', async () => {
    const { pluginsManager, door, mcp } = await joined('on')
    const before = await request(door, mcp, 'client-2')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, before))).toBe('not-granted')
    const asked = await ask(mcp, 'core.identityAsk', { capabilities: [{ type: 'luoshu.read', paths: ['inbox/**'] }] }, before)
    expect(asked.result).toEqual({ asked: 'waiting' })
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, before))).toBe('not-granted')
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    const after = await request(door, mcp, 'client-2')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, after))).toBe('inbox text')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'private/b.md' }, after))).toBe('not-granted')
    // The call made before the Confirm, still live, is judged on the grants snapshot now too
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, before))).toBe('inbox text')
  })

  it('refuses client-1\'s next judgement once revoked while its call waits and tells the handler it stays revoked for the run', async () => {
    const { pluginsManager, door, mcp } = await joined('on')
    const { parent } = await request(door, mcp, 'client-1')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent }))).toBe('inbox text')
    const trusted = { kind: 'window', role: 'trusted', n: 1 } as const
    expect(await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client-1' }, trusted)).toEqual({ applied: true })
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent }))).toBe('not-granted')
    expect((await ask(door, 'core.identities', { fields: ['client-1', 'client-3'] })).result).toEqual([
      { field: 'client-1', holds: 'revoked' }, { field: 'client-3', holds: 'items' },
    ])
    // A revoked pair asks for nothing again in the run
    expect(outcome(await ask(mcp, 'core.identityAsk', { capabilities: [{ type: 'luoshu.read', paths: ['inbox/**'] }] }, { parent }))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'core.identityAsk', { capabilities: [{ type: 'luoshu.read', paths: ['inbox/**'] }] }, await request(door, mcp, 'client-1')))).toBe('not-granted')
  })

  it('lets client-1 reach nothing under the handler\'s next call once revoked and still serves client-3', async () => {
    const { pluginsManager, door, mcp } = await joined('on')
    const trusted = { kind: 'window', role: 'trusted', n: 1 } as const
    await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client-1' }, trusted)
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, await request(door, mcp, 'client-1')))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, await request(door, mcp, 'client-3')))).toBe('inbox text')
  })

  it('lets every call under the handler\'s call for client-1 through with the gate off, as any call', async () => {
    const { door, mcp } = await joined('off')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'private/b.md' }, await request(door, mcp, 'client-1')))).toBe('SECRET')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }))).toBe('inbox text')
  })

  // The luoshu resolves inbox/a.md again once inbox is renamed INBOX after prepare and asks the judge about INBOX/a.md,
  // which the grants snapshot keeps apart from inbox. mcp holds every path, so the pair's items decide
  const caseOnly = process.platform === 'win32' || process.platform === 'darwin'
  it.runIf(caseOnly)('judges a pair\'s read again against the pair\'s items when its folder is renamed in case between prepare and perform', async () => {
    const { door, mcp, folder, hooks } = await joined('on')
    const recase = async () => {
      await renamed(path.join(folder, 'inbox'), path.join(folder, 'inbox-was'))
      await renamed(path.join(folder, 'inbox-was'), path.join(folder, 'INBOX'))
    }
    const one = await request(door, mcp, 'client-1')
    hooks.before = recase
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent: one.parent }))).toBe('not-granted')
    await renamed(path.join(folder, 'INBOX'), path.join(folder, 'inbox-was'))
    await renamed(path.join(folder, 'inbox-was'), path.join(folder, 'inbox'))
    const three = await request(door, mcp, 'client-3')
    hooks.before = recase
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, { parent: three.parent }))).toBe('inbox text')
  })
})
