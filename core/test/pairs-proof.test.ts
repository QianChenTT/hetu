import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecurityList } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import type { GrantRiskClassifier } from '../api/classes.ts'
import type { Call } from '../api/policy-jobs.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore } from '../backend/boot/state.ts'
import { wireCore } from '../backend/wire.ts'
import {
  coreInstall, FakeRuntime, filesFor, firstPartyEntry, hashOf, hostManifest, tempBase, throwingClassifier, tick, workerManifest, writeFolder,
  writeInstall, type Half, type Message,
} from './plugins-manager-fakes.ts'

const open: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

const everything: Capability = { type: 'luoshu.read', paths: ['**'] }
const inbox: Capability = { type: 'luoshu.read', paths: ['inbox/**'] }
const privateNotes: Capability = { type: 'luoshu.read', paths: ['private/**'] }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const mcpOf = (version: string, capabilities: Capability[]) => filesFor({ ...workerManifest('mcp', { capabilities, provides: { actions: { handle: { from: ['mcp-http-handler'] } } } }), version })

// One folder of notes and one install, booted as often as the proof needs: the real boot, plugins manager, router, gate and
// luoshu, mcp-http-handler the install's utility plugin the test drives as the root of each chain and mcp the install's
// own copy, a worker the test answers for, holding read on every note unless items names its own. history adds hetu's
// history as it ships
async function world(options: { items?: Capability[], history?: boolean } = {}) {
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
    'mcp-http-handler': { files: filesFor(hostManifest('mcp-http-handler', { capabilities: [{ type: 'plugin.call', targets: ['mcp'] }] })) },
    mcp: { files: mcpOf(mcpVersion, items), firstParty: true },
  })
  await install('1.0.0')
  const store = new StateStore(dataDir)
  // History switched off unless the test asks for it, as when the install held none
  await store.writeSwitches({ ...defaultSwitches(), off: options.history === true ? [] : ['history'] })
  await store.writeLuoshu({ folder })
  const root = path.join(dataDir, 'plugins', 'mcp')
  await writeFolder(root, mcpOf('1.0.0', items))
  await store.writePlugin('mcp', firstPartyEntry(await hashOf(root), { granted: items, class: 1 }))
  open.push(() => rm(base, { recursive: true, force: true }))

  // One run of hetu over that folder, ended by the next start or the test's end. The grant risk classifier is the one
  // the core makes unless the run hands another
  let end: (() => Promise<void>) | null = null
  async function start(grantRiskClassifier?: GrantRiskClassifier) {
    await end?.()
    const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
    const runtime = new FakeRuntime()
    // The core modules the core makes, closed at the plugins manager's shutdown
    const modules = grantRiskClassifier === undefined ? {} : { grantRiskClassifier }
    const { recording, pluginsManager, router } = wireCore({ booted, installDir, runtime, modules, confirmDelayMs: 0 })
    const stop = async () => {
      await pluginsManager.shutdown().catch(() => {})
      router.close()
      await recording.flush()
      for (const port of runtime.ports) port.close()
      await booted.release()
    }
    end = async () => {
      end = null
      await stop()
    }
    open.unshift(async () => end?.())
    await pluginsManager.start()
    await pluginsManager.settled()
    const list = async () => await pluginsManager.serve({ callId: 'list', caller: trusted, action: 'security.list', args: undefined, deadline: Date.now() + 30_000 } as Call) as SecurityList
    return { pluginsManager, runtime, list, door: runtime.half('mcp-http-handler', 1, 'utility') }
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

// The handler hands mcp a request for the field, giving the parent mcp's calls under it name
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

// The pair of the handler and the field given the items through mcp's ask and the human's Confirm
async function give(run: { door: Half, runtime: FakeRuntime, pluginsManager: { pending(): { id: string }[], confirm(id: string, options: object): Promise<void> } }, field: string, capabilities: Capability[]) {
  const mcp = run.runtime.half('mcp')
  expect((await ask(mcp, 'core.identityAsk', { capabilities }, await request(run.door, mcp, field))).result).toEqual({ asked: 'waiting' })
  await run.pluginsManager.confirm(run.pluginsManager.pending().at(-1)!.id, {})
}

describe('a pair\'s items in the joined core', () => {
  it('asks, confirms, keeps another pair\'s ask good, revokes, forgets every pair at a restart, withdraws on a stop and passes with the gate off', async () => {
    const proof = await world()
    let run = await proof.start()
    let mcp = run.runtime.half('mcp')

    // #1 asks for luoshu.read on inbox/**. The trusted window shows the field and the scope in quotes
    const one = await request(run.door, mcp, 'client#1')
    expect(await read(mcp, one, 'inbox/a.md')).toBe('not-granted')
    expect((await ask(mcp, 'core.identityAsk', { capabilities: [inbox] }, one)).result).toEqual({ asked: 'waiting' })
    const two = await request(run.door, mcp, 'client#2')
    expect((await ask(mcp, 'core.identityAsk', { capabilities: [privateNotes] }, two)).result).toEqual({ asked: 'waiting' })
    const shown = (await run.list()).requests
    expect(shown.map(held => held.text)).toEqual([
      'Give "client#1" under mcp-http-handler what it asks for through mcp', 'Give "client#2" under mcp-http-handler what it asks for through mcp',
    ])
    expect(shown[0].notes[0]).toBe('It asks for: luoshu.read on "inbox/**"')
    // Before the Confirm #1 reads nothing, after it inbox and not private
    expect(await read(mcp, one, 'inbox/a.md')).toBe('not-granted')
    await run.pluginsManager.confirm(shown[0].id, {})
    expect(await read(mcp, one, 'inbox/a.md')).toBe('inbox text')
    expect(await read(mcp, one, 'private/b.md')).toBe('not-granted')

    // #2's ask read only its own pair, which #1's Confirm left as it was, so it stays good
    await run.pluginsManager.confirm(shown[1].id, {})
    expect(await read(mcp, two, 'private/b.md')).toBe('private text')

    // Revoke of #1 refuses its next call at once and the core tells the handler it is revoked
    expect(await run.pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client#1' }, trusted)).toEqual({ applied: true })
    expect(await read(mcp, one, 'inbox/a.md')).toBe('not-granted')
    expect((await ask(run.door, 'core.identities', { fields: ['client#1', 'client#2'] })).result).toEqual([
      { field: 'client#1', holds: 'revoked' }, { field: 'client#2', holds: 'items' },
    ])
    expect((await run.list()).identities).toEqual([
      { root: 'mcp-http-handler', field: 'client#2', items: [privateNotes], revoked: false }, { root: 'mcp-http-handler', field: 'client#1', items: [], revoked: true },
    ])
    // No state file holds a pair
    expect(Object.keys(await proof.stored())).not.toContain('agents')

    // The next run of hetu, an update of mcp with it, holds no pair: #2 reads nothing and asks again, #1 too since its
    // revoke held for the run. The grant risk classifier fails each call in this run
    await proof.install('1.1.0')
    run = await proof.start(throwingClassifier())
    mcp = run.runtime.half('mcp')
    expect((await proof.stored()).version).toBe('1.1.0')
    expect((await run.list()).identities).toEqual([])
    const again = await request(run.door, mcp, 'client#2')
    expect(await read(mcp, again, 'private/b.md')).toBe('not-granted')
    expect((await ask(run.door, 'core.identities', { fields: ['client#1', 'client#2'] })).result).toEqual([
      { field: 'client#1', holds: 'none' }, { field: 'client#2', holds: 'none' },
    ])
    expect((await ask(mcp, 'core.identityAsk', { capabilities: [inbox] }, await request(run.door, mcp, 'client#1'))).result).toEqual({ asked: 'waiting' })

    // A Confirm after mcp stopped is refused
    const waiting = run.pluginsManager.pending()[0].id
    expect(await run.pluginsManager.request({ kind: 'plugin.off', plugin: 'mcp' }, trusted)).toEqual({ applied: true })
    await run.pluginsManager.settled()
    await expect(run.pluginsManager.confirm(waiting, {})).rejects.toMatchObject({ code: 'not-found' })
    expect((await run.list()).identities).toEqual([])

    // With the gate switched off by the human every call under the handler's call passes, as any call does
    expect(await run.pluginsManager.request({ kind: 'plugin.on', plugin: 'mcp' }, trusted)).toMatchObject({ held: expect.any(String) })
    await run.pluginsManager.confirm(run.pluginsManager.pending()[0].id, {})
    await run.pluginsManager.settled()
    const off = await run.pluginsManager.request({ kind: 'plugin.off', plugin: 'gate' }, trusted)
    if (!('held' in off)) throw new Error('the gate went off at once')
    await run.pluginsManager.confirm(off.held, { typed: 'gate' })
    mcp = run.runtime.half('mcp', 2)
    expect(await read(mcp, await request(run.door, mcp, 'client#2'), 'inbox/a.md')).toBe('inbox text')
  })
})

describe('a connect in the joined core', () => {
  const CLAUDE = 'https://claude.ai/oauth/claude-code-client-metadata'
  const asked = (number: number, client = CLAUDE) => ({ client, name: 'Claude Code', redirect: 'http://localhost:33418/callback', field: `${client}#${number}` })
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
  const answerOf = async (door: Half, handle: string) => ((await ask(door, 'core.consentAnswer', { handle })).result as { answer: string }).answer

  it('connects a new field under a client id another pair holds items under, once, refuses a second, drops it with the handler and lets a revoked pair reach nothing', async () => {
    const proof = await world()
    const run = await proof.start()
    const mcp = run.runtime.half('mcp')
    await give(run, `${CLAUDE}#1`, [inbox])
    expect((await ask(mcp, 'core.identityAsk', { capabilities: [inbox] }, await request(run.door, mcp, `${CLAUDE}#2`))).result).toEqual({ asked: 'waiting' })
    await run.pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: `${CLAUDE}#2` }, trusted)

    // The handler raises a connect for #3 under the client id #1 holds inbox under. The trusted window shows the host
    // first, the name in quotes and the new field
    const handle = handleOf(await ask(run.door, 'core.consentAsk', asked(3)))
    const shown = (await run.list()).requests
    expect(shown.map(held => [held.kind, held.text, held.field])).toEqual([[
      'consent.ask', `Connect the client from "claude.ai" named "Claude Code", which returns to "localhost:33418", through mcp-http-handler as "${CLAUDE}#3"`, `${CLAUDE}#3`,
    ]])
    // Before the Confirm the collect answers waiting, a second connect while it waits is refused
    expect(await answerOf(run.door, handle)).toBe('waiting')
    expect(outcome(await ask(run.door, 'core.consentAsk', asked(1, 'other-client')))).toBe('throttled')
    await run.pluginsManager.confirm(shown[0]!.id, {})
    expect(await answerOf(run.door, handle)).toBe('yes')
    expect(await answerOf(run.door, handle)).toBe('gone')
    // The new pair holds nothing, #1 still holds its items
    expect((await ask(run.door, 'core.identities', { fields: [`${CLAUDE}#1`, `${CLAUDE}#3`] })).result).toEqual([
      { field: `${CLAUDE}#1`, holds: 'items' }, { field: `${CLAUDE}#3`, holds: 'none' },
    ])
    const three = await request(run.door, mcp, `${CLAUDE}#3`)
    expect(await read(mcp, three, 'inbox/a.md')).toBe('not-granted')
    const one = await request(run.door, mcp, `${CLAUDE}#1`)
    expect(await read(mcp, one, 'inbox/a.md')).toBe('inbox text')

    // A connect waiting when the handler restarts is gone and can't be confirmed
    const waiting = handleOf(await ask(run.door, 'core.consentAsk', asked(4)))
    const id = run.pluginsManager.pending()[0]!.id
    await run.pluginsManager.serve({ callId: 'restart', caller: trusted, action: 'core.restart', args: { plugin: 'mcp-http-handler' }, deadline: Date.now() + 30_000 } as Call)
    await run.pluginsManager.settled()
    const door = latest(run.runtime, 'mcp-http-handler', 'utility')
    expect(run.pluginsManager.pending()).toEqual([])
    await expect(run.pluginsManager.confirm(id, {})).rejects.toMatchObject({ code: 'not-found' })
    expect(await answerOf(door, waiting)).toBe('gone')

    // A connect for a revoked pair is refused and a call under the handler's call for it reaches nothing
    expect(outcome(await ask(door, 'core.consentAsk', asked(2)))).toBe('not-granted')
    expect(run.pluginsManager.pending()).toEqual([])
    const mcpThen = latest(run.runtime, 'mcp')
    expect(await read(mcpThen, await request(door, mcpThen, `${CLAUDE}#2`), 'inbox/a.md')).toBe('not-granted')

    // With the gate switched off a connect is raised and confirmed and every call under the handler's call for the new
    // field passes
    const off = await run.pluginsManager.request({ kind: 'plugin.off', plugin: 'gate' }, trusted)
    if (!('held' in off)) throw new Error('the gate went off at once')
    await run.pluginsManager.confirm(off.held, { typed: 'gate' })
    await run.pluginsManager.settled()
    const now = latest(run.runtime, 'mcp-http-handler', 'utility')
    const five = handleOf(await ask(now, 'core.consentAsk', asked(5)))
    await run.pluginsManager.confirm(run.pluginsManager.pending()[0]!.id, {})
    expect(await answerOf(now, five)).toBe('yes')
    const mcpNow = latest(run.runtime, 'mcp')
    expect(await read(mcpNow, await request(now, mcpNow, `${CLAUDE}#5`), 'inbox/a.md')).toBe('inbox text')
  })
})

describe('the provider actions under a pair\'s chain in the joined core', () => {
  const inboxWrite: Capability = { type: 'luoshu.write', paths: ['inbox/**'] }
  const privateWrite: Capability = { type: 'luoshu.write', paths: ['private/**'] }
  const historyOf = (access: 'read' | 'commit', paths: string[]): Capability => ({ type: 'history', access, paths })

  it('reaches each provider for a pair, judged against mcp\'s items and the pair\'s', async () => {
    // mcp reads every note and its history and writes only in inbox. #1 reads inbox and its history and writes in both
    // folders. #2 holds nothing
    const proof = await world({ items: [everything, inboxWrite, historyOf('read', ['**'])], history: true })
    const run = await proof.start()
    const mcp = run.runtime.half('mcp')
    await give(run, 'client#1', [inbox, inboxWrite, privateWrite, historyOf('read', ['inbox/**'])])
    const one = await request(run.door, mcp, 'client#1')
    const two = await request(run.door, mcp, 'client#2')

    // A read: inbox for #1, not private, which mcp reads and #1 doesn't
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, one))).toBe('inbox text')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'private/b.md' }, one))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/a.md' }, two))).toBe('not-granted')

    // A listing: only what the pair may list, nothing for #2
    expect((await ask(mcp, 'luoshu.list', {}, one)).result).toEqual({ paths: ['inbox/a.md'], next: null })
    expect((await ask(mcp, 'luoshu.list', {}, two)).result).toEqual({ paths: [], next: null })

    // A write: inbox, which both hold. Not private, which #1 holds and mcp doesn't
    const written = await ask(mcp, 'luoshu.write', { path: 'inbox/new.md', text: 'new text' }, one)
    expect(written.result).toEqual({ version: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(outcome(await ask(mcp, 'luoshu.read', { path: 'inbox/new.md' }, one))).toBe('new text')
    expect(outcome(await ask(mcp, 'luoshu.write', { path: 'private/c.md', text: 'x' }, one))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'luoshu.write', { path: 'inbox/other.md', text: 'x' }, two))).toBe('not-granted')

    // A note's history: inbox for #1, answered by history with no commit yet. Not private, whose history mcp reads and
    // #1 doesn't
    expect((await ask(mcp, 'history.log', { path: 'inbox/a.md' }, one)).result).toEqual({ commits: [] })
    expect(outcome(await ask(mcp, 'history.log', { path: 'private/b.md' }, one))).toBe('not-granted')
    expect(outcome(await ask(mcp, 'history.log', { path: 'inbox/a.md' }, two))).toBe('not-granted')
  })
})
