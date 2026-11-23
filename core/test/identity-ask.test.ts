import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreActions, type SecurityList } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import type { Call } from '../api/policy-jobs.ts'
import { EventLog } from '../lib/event-log.ts'
import { allowAll, cleanup, coreInstall, entryFor, filesFor, harness, hostManifest, until, workerManifest, type FakeLink } from './plugins-manager-fakes.ts'

// A pair's items as the plugins manager holds them: asked for by the plugin the root of a chain called, confirmed by the
// human, kept in memory for the run and handed to the gate keyed by the root plugin and the field

afterEach(cleanup)

const read: Capability = { type: 'luoshu.read', paths: ['**'] }
const inbox: Capability = { type: 'luoshu.read', paths: ['inbox/**'] }
const write: Capability = { type: 'luoshu.write', paths: ['inbox/**'] }
const log: Capability = { type: 'history', access: 'read', paths: ['inbox/**'] }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const mcp: Caller = { kind: 'plugin', id: 'mcp', half: 'worker', incarnation: 1 }
const handler: Caller = { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 }
const beta: Caller = { kind: 'plugin', id: 'beta', half: 'worker', incarnation: 1 }
const gamma: Caller = { kind: 'plugin', id: 'gamma', half: 'worker', incarnation: 1 }
const code = (work: Promise<unknown>) => work.then(() => null, (err: { code?: string }) => err.code ?? String(err))
const item = (capability: Capability) => ({ capability, off: false, firstUse: false })

// mcp and beta in the plugin folder, mcp-http-handler as the install's utility plugin, a clock the test moves. The
// handler's chains reach mcp, beta's reach gamma
async function started(base?: string) {
  const clock = { now: 1000 }
  const gate = allowAll()
  const mcpFiles = filesFor(workerManifest('mcp', { capabilities: [read] }))
  const betaFiles = filesFor(workerManifest('beta', { capabilities: [{ type: 'plugin.call', targets: ['gamma'] }] }))
  const gammaFiles = filesFor(workerManifest('gamma', { capabilities: [read] }))
  const made = await harness({
    ...(base !== undefined ? { base } : {}),
    install: {
      ...coreInstall(),
      'mcp-http-handler': { files: filesFor(hostManifest('mcp-http-handler', { capabilities: [{ type: 'plugin.call', targets: ['mcp'] }] })) },
    },
    folder: { mcp: mcpFiles, beta: betaFiles, gamma: gammaFiles },
    entries: {
      mcp: root => entryFor(root, { signer: null, granted: [read], class: 1 }),
      beta: root => entryFor(root, { granted: [{ type: 'plugin.call', targets: ['gamma'] }] }),
      gamma: root => entryFor(root, { granted: [read] }),
    },
    modules: { gate },
    pluginsManager: { clock: () => clock.now, confirmDelayMs: 0 },
  })
  await made.pluginsManager.start()
  let n = 0
  const serve = (caller: Caller, action: string, args: unknown, extra: Partial<Call> = {}) => made.pluginsManager.serve({
    callId: `call-${++n}`, caller, root: caller, action, args, deadline: Date.now() + 30_000, ...extra,
  } as Call)
  // core.identityAsk as the router hands it over once its floor passed: from the plugin the root called, the chain's
  // root and the field it set
  const ask = (field: string | undefined, capabilities: Capability[], from: Caller = mcp, root: Caller = handler) =>
    serve(from, 'core.identityAsk', { capabilities }, { root, ...(field !== undefined ? { onBehalf: field } : {}) })
  const list = async () => await serve(trusted, 'security.list', undefined) as SecurityList
  const identities = (fields: string[], from: Caller = handler) => serve(from, 'core.identities', { fields })
  const confirmAll = async () => {
    for (const one of made.pluginsManager.pending()) await made.pluginsManager.confirm(one.id, {})
  }
  // The pair holding the items, asked for and confirmed
  const granted = async (field: string, capabilities: Capability[], from: Caller = mcp, root: Caller = handler) => {
    await ask(field, capabilities, from, root)
    await confirmAll()
  }
  const snapshot = () => gate.seen.at(-1)!
  const files = async () => {
    const dir = path.join(made.dataDir, 'state')
    return { switches: await readFile(path.join(dir, 'switches.json'), 'utf8'), mcp: await readFile(path.join(dir, 'plugins', 'mcp.json'), 'utf8') }
  }
  return { ...made, gate, clock, ask, list, identities, granted, confirmAll, snapshot, files }
}

describe('an ask for a pair\'s items', () => {
  it('takes an ask from the plugin the root called for the pair of the root plugin and the field, whichever plugins they are', async () => {
    const { pluginsManager, ask, list } = await started()
    expect(await ask('client-1', [inbox, write])).toEqual({ asked: 'waiting' })
    expect(await ask('note-bot', [log], gamma, beta)).toEqual({ asked: 'waiting' })
    expect(pluginsManager.pending().map(one => [one.kind, one.plugin])).toEqual([['identity.ask', 'mcp'], ['identity.ask', 'gamma']])
    const shown = (await list()).requests
    expect(shown.map(one => [one.root, one.field])).toEqual([['mcp-http-handler', 'client-1'], ['beta', 'note-bot']])
    expect(shown[0].text).toBe('Give "client-1" under mcp-http-handler what it asks for through mcp')
    expect(shown[0].notes).toEqual([
      'It asks for: luoshu.read on "inbox/**"', 'It asks for: luoshu.write on "inbox/**"',
      'Each call made for it reaches only what the calling plugin holds as well', 'mcp-http-handler may pass on to it what a plugin it called found that it may read, without holding that itself', 'It holds the items until hetu quits',
      'Cancel and revoke turns it away until hetu quits, as Revoke in the identities list does once it holds an item',
    ])
    expect(shown[0].type).toBeNull()
  })

  it('refuses an ask with no pair: no field, a window at the root or a caller that is no plugin', async () => {
    const { pluginsManager, ask } = await started()
    expect(await code(ask(undefined, [inbox]))).toBe('not-granted')
    expect(await code(ask('client-1', [inbox], mcp, editor))).toBe('not-granted')
    expect(await code(ask('client-1', [inbox], editor, handler))).toBe('not-granted')
    expect(pluginsManager.pending()).toEqual([])
  })

  it('answers a second ask for the same items as the first and refuses a different ask while one waits for the pair', async () => {
    const { pluginsManager, ask } = await started()
    await ask('client-1', [inbox, write])
    expect(await ask('client-1', [write, { paths: ['inbox/**'], type: 'luoshu.read' }])).toEqual({ asked: 'waiting' })
    expect(pluginsManager.pending()).toHaveLength(1)
    expect(await code(ask('client-1', [inbox]))).toBe('throttled')
    expect(pluginsManager.pending()).toHaveLength(1)
  })

  it('keeps the same field under two root plugins as two pairs', async () => {
    const { pluginsManager, ask, snapshot } = await started()
    await ask('x', [write])
    expect(await ask('x', [inbox], gamma, beta)).toEqual({ asked: 'waiting' })
    expect(pluginsManager.pending()).toHaveLength(2)
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { x: [item(write)] } })
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { x: [item(write)] }, beta: { x: [item(inbox)] } })
  })

  it('holds sixteen asks waiting under one root plugin, its next refused, while an ask under another root plugin still waits', async () => {
    const { pluginsManager, ask } = await started()
    for (let n = 1; n <= 16; n++) expect(await ask(`spam-${n}`, [inbox], gamma, beta)).toEqual({ asked: 'waiting' })
    expect(await code(ask('spam-17', [inbox], gamma, beta))).toBe('throttled')
    expect(await ask('client-1', [inbox])).toEqual({ asked: 'waiting' })
    expect(pluginsManager.pending()).toHaveLength(17)
  })

  it('refuses a pair the human cancelled an ask of for a minute, then takes its ask again', async () => {
    const { pluginsManager, ask, clock } = await started()
    await ask('client-1', [inbox])
    await pluginsManager.cancel(pluginsManager.pending()[0].id)
    expect(await code(ask('client-1', [write]))).toBe('throttled')
    // The same field under another root plugin is another pair
    expect(await ask('client-1', [inbox], gamma, beta)).toEqual({ asked: 'waiting' })
    clock.now += 59_999
    expect(await code(ask('client-1', [inbox]))).toBe('throttled')
    clock.now += 1
    expect(await ask('client-1', [inbox])).toEqual({ asked: 'waiting' })
  })

  it('refuses an item of a type no pair may hold, in the contract and in the plugins manager', async () => {
    const { pluginsManager, ask } = await started()
    const asked = coreActions['core.identityAsk'].args
    for (const capability of [
      { type: 'plugin.call', targets: ['mcp'] }, { type: 'exec', commands: [['git']], env: [] }, { type: 'net.fetch', hosts: ['example.com'] },
      { type: 'storage' }, { type: 'events.subscribe', topics: ['mcp.changed'] },
    ] as Capability[]) {
      expect(asked.safeParse({ capabilities: [capability] }).success).toBe(false)
      expect(await code(ask('client-1', [inbox, capability]))).toBe('invalid')
    }
    expect(asked.safeParse({ capabilities: [inbox, write, log, { type: 'luoshu.list', paths: ['**'] }] }).success).toBe(true)
    expect(pluginsManager.pending()).toEqual([])
  })

  it('answers granted with no request for items the pair holds already and asks for only the ones it lacks', async () => {
    const { pluginsManager, ask, granted, list } = await started()
    await granted('client-1', [inbox])
    expect(await ask('client-1', [inbox])).toEqual({ asked: 'granted' })
    expect(pluginsManager.pending()).toEqual([])
    await ask('client-1', [inbox, write])
    expect((await list()).requests[0].notes[0]).toBe('It asks for: luoshu.write on "inbox/**"')
  })

  it('quotes each scope as a widen does, a quote in it escaped', async () => {
    const { ask, list } = await started()
    await ask('https://claude.ai/oauth/claude-code-client-metadata#3', [{ type: 'luoshu.read', paths: ['say "yes"/**', 'a, b/**'] }])
    const shown = (await list()).requests[0]
    expect(shown.text).toBe('Give "https://claude.ai/oauth/claude-code-client-metadata" under mcp-http-handler what it asks for through mcp')
    expect(shown.notes[0]).toBe('It asks for: luoshu.read on "say \\"yes\\"/**", "a, b/**"')
  })

  it('refuses at the raise an ask that would put the pair past a plugin\'s own caps, the items it holds counted', async () => {
    const { pluginsManager, ask, granted } = await started()
    const wide = Array.from({ length: 8 }, (_, n) => ({ type: 'luoshu.read', paths: Array.from({ length: 64 }, (_, m) => `w${n}/${m}/**`) }) as Capability)
    expect(await code(ask('client-1', wide))).toBe('invalid')
    const many = Array.from({ length: 60 }, (_, n) => `n${n}/**`)
    await granted('client-1', [{ type: 'luoshu.read', paths: many }])
    const past = { type: 'luoshu.read', paths: ['a/**', 'b/**', 'c/**', 'd/**', 'e/**'] } as Capability
    expect(await code(ask('client-1', [past]))).toBe('invalid')
    expect(pluginsManager.pending()).toEqual([])
    // Another pair holds its own
    expect(await ask('client-2', [past])).toEqual({ asked: 'waiting' })
  })

  it('refuses at the raise an ask that would put the root plugin\'s pairs past 256 items in all, then takes one under another root', async () => {
    const { pluginsManager, ask, confirmAll } = await started()
    for (let field = 0; field < 32; field++) {
      const items = Array.from({ length: 8 }, (_, n) => ({ type: 'luoshu.read', paths: [`f${field}n${n}/**`] }) as Capability)
      expect(await ask(`client-${field + 1}`, items)).toEqual({ asked: 'waiting' })
      await confirmAll()
    }
    expect(await code(ask('client-99', [inbox]))).toBe('invalid')
    expect(pluginsManager.pending()).toEqual([])
    expect(await ask('client-99', [inbox], gamma, beta)).toEqual({ asked: 'waiting' })
  })
})

describe('the Confirm of an ask', () => {
  it('adds the items to the pair in memory, hands the gate the next grants snapshot and writes no state file', async () => {
    const { pluginsManager, ask, granted, snapshot, files, link } = await started()
    const before = await files()
    await granted('client-10', [inbox])
    await ask('client-1', [write, inbox])
    const views = snapshot().n
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    expect(snapshot().n).toBeGreaterThan(views)
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { 'client-10': [item(inbox)], 'client-1': [item(inbox), item(write)] } })
    expect(Object.getPrototypeOf(snapshot().pairs!['mcp-http-handler'])).toBe(null)
    expect(Object.isFrozen(snapshot().pairs!['mcp-http-handler']['client-1'][0].capability)).toBe(true)
    expect(snapshot().plugins.mcp).toEqual([item(read)])
    expect(await files()).toEqual(before)
    expect(link.events('security.applied').at(-1)).toMatchObject({ kind: 'identity.ask', target: 'mcp-http-handler', field: 'client-1', by: 'confirm' })
  })

  it('goes stale once the pair\'s own items changed after it was raised, then takes the pair\'s ask again', async () => {
    const { pluginsManager, ask, link, snapshot } = await started()
    await ask('client-1', [inbox])
    const waiting = pluginsManager.pending()[0].id
    // Applied directly, as a test or the plugins manager's own work may, while the ask waits
    await pluginsManager.apply({ kind: 'identity.ask', plugin: 'mcp', root: 'mcp-http-handler', field: 'client-1', capabilities: [write] })
    expect(await code(pluginsManager.confirm(waiting, {}))).toBe('stale')
    expect(link.events('security.stale')).toMatchObject([{ kind: 'identity.ask', target: 'mcp-http-handler', field: 'client-1' }])
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { 'client-1': [item(write)] } })
    expect(await ask('client-1', [inbox])).toEqual({ asked: 'waiting' })
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { 'client-1': [item(write), item(inbox)] } })
  })

  it('stays good across another pair\'s Confirm, a revoke of another pair and a write of a plugin\'s entry or the switches', async () => {
    const { pluginsManager, ask, granted, snapshot } = await started()
    await granted('client-3', [inbox])
    await ask('client-2', [write])
    await ask('client-1', [inbox])
    const [two, one] = pluginsManager.pending()
    await pluginsManager.confirm(two.id, {})
    await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client-3' }, trusted)
    await pluginsManager.request({ kind: 'item.off', plugin: 'mcp', capability: read }, trusted)
    await pluginsManager.request({ kind: 'devMode', plugin: 'beta', on: false }, trusted)
    await pluginsManager.confirm(one.id, {})
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { 'client-2': [item(write)], 'client-1': [item(inbox)] } })
  })

  it('leaves no pair\'s items and no revoke for the next run of hetu, the pair asking again', async () => {
    const first = await started()
    await first.granted('client-1', [inbox])
    await first.ask('client-2', [read])
    await first.pluginsManager.cancel(first.pluginsManager.pending()[0].id)
    await first.pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client-2' }, trusted)
    expect(first.snapshot().revoked).toEqual({ 'mcp-http-handler': ['client-2'] })
    await first.pluginsManager.shutdown()
    const next = await started(first.base)
    expect(next.snapshot().pairs).toEqual({})
    expect(next.snapshot().revoked).toEqual({})
    expect((await next.list()).identities).toEqual([])
    expect(await next.ask('client-1', [inbox])).toEqual({ asked: 'waiting' })
    expect(await next.ask('client-2', [read])).toEqual({ asked: 'waiting' })
  })
})

describe('a revoke of a pair', () => {
  it('takes every item of the pair at once with no Confirm from any window and marks it revoked for the run', async () => {
    const { pluginsManager, granted, snapshot, files, link } = await started()
    await granted('client-1', [inbox, write])
    await granted('client-10', [inbox])
    await granted('client-1', [log], gamma, beta)
    const before = await files()
    expect(await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client-1' }, editor)).toEqual({ applied: true })
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { 'client-10': [item(inbox)] }, beta: { 'client-1': [item(log)] } })
    expect(snapshot().revoked).toEqual({ 'mcp-http-handler': ['client-1'] })
    expect(pluginsManager.pending()).toEqual([])
    expect(await files()).toEqual(before)
    expect(link.events('security.applied').at(-1)).toMatchObject({ kind: 'identity.revoke', target: 'mcp-http-handler', field: 'client-1', by: 'narrows' })
  })

  it('withdraws the pair\'s waiting ask, refuses its next ask and fails a Confirm that would give it items', async () => {
    const { pluginsManager, ask, granted, link } = await started()
    await granted('client-1', [inbox])
    await ask('client-1', [read])
    await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client-1' }, trusted)
    expect(pluginsManager.pending()).toEqual([])
    expect(link.events('security.withdrawn')).toMatchObject([{ kind: 'identity.ask', target: 'mcp-http-handler', field: 'client-1' }])
    expect(await code(ask('client-1', [inbox]))).toBe('not-granted')
    expect(await code(pluginsManager.apply({ kind: 'identity.ask', plugin: 'mcp', root: 'mcp-http-handler', field: 'client-1', capabilities: [inbox] }))).not.toBeNull()
  })

  it('withdraws a waiting ask of a pair that holds nothing yet and marks it, changing nothing for a pair that never asked', async () => {
    const { pluginsManager, ask, snapshot, link } = await started()
    await ask('client-2', [read])
    await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client-2' }, trusted)
    expect(snapshot().revoked).toEqual({ 'mcp-http-handler': ['client-2'] })
    const applied = link.events('security.applied').length
    const views = snapshot().n
    for (const field of ['client-9', 'client-2']) {
      expect(await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field }, editor)).toEqual({ applied: true })
    }
    expect(await pluginsManager.request({ kind: 'identity.revoke', root: 'beta', field: 'client-2' }, editor)).toEqual({ applied: true })
    expect(snapshot().revoked).toEqual({ 'mcp-http-handler': ['client-2'] })
    expect(snapshot().n).toBe(views)
    expect(link.events('security.applied')).toHaveLength(applied)
  })

  it('turns away a pair whose ask the human cancelled while its pause runs and marks nothing once it ran out', async () => {
    const { pluginsManager, ask, clock, snapshot } = await started()
    await ask('nag-1', [read])
    await ask('nag-2', [read])
    for (const one of pluginsManager.pending()) await pluginsManager.cancel(one.id)
    await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'nag-1' }, trusted)
    clock.now += 60_000
    await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'nag-2' }, trusted)
    expect(snapshot().revoked).toEqual({ 'mcp-http-handler': ['nag-1'] })
    expect(await code(ask('nag-1', [read]))).toBe('not-granted')
    expect(await ask('nag-2', [read])).toEqual({ asked: 'waiting' })
  })
})

describe('the pair of a field with a #', () => {
  it('keys the pair on the field up to its first #, so each session of a client shares its ask, items and revoke', async () => {
    const { pluginsManager, ask, granted, identities, list, snapshot, link } = await started()
    await granted('claude-code#1', [inbox])
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { 'claude-code': [item(inbox)] } })
    // Another session holds the client's items already and asks only for what the client lacks, once for the client
    expect(await ask('claude-code#2', [inbox])).toEqual({ asked: 'granted' })
    expect(await ask('claude-code#2', [write])).toEqual({ asked: 'waiting' })
    expect(await code(ask('claude-code#3', [log]))).toBe('throttled')
    const shown = (await list()).requests
    expect(shown.map(one => [one.root, one.field, one.text])).toEqual([['mcp-http-handler', 'claude-code', 'Give "claude-code" under mcp-http-handler what it asks for through mcp']])
    await pluginsManager.confirm(shown[0].id, {})
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { 'claude-code': [item(inbox), item(write)] } })
    expect(await identities(['claude-code#1', 'claude-code#7', 'claude-code', 'other#1'])).toEqual([
      { field: 'claude-code#1', holds: 'items' }, { field: 'claude-code#7', holds: 'items' }, { field: 'claude-code', holds: 'items' }, { field: 'other#1', holds: 'none' },
    ])
    // A revoke naming any session revokes the client, which its record names
    expect(await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'claude-code#9' }, trusted)).toEqual({ applied: true })
    expect(snapshot().revoked).toEqual({ 'mcp-http-handler': ['claude-code'] })
    expect(link.events('security.applied').at(-1)).toMatchObject({ kind: 'identity.revoke', target: 'mcp-http-handler', field: 'claude-code', by: 'narrows' })
    expect(await identities(['claude-code#1', 'claude-code'])).toEqual([{ field: 'claude-code#1', holds: 'revoked' }, { field: 'claude-code', holds: 'revoked' }])
    expect(await code(ask('claude-code#4', [inbox]))).toBe('not-granted')
  })
})

describe('the identities', () => {
  it('lists for the trusted window each pair with items and each revoked one, from memory', async () => {
    const { pluginsManager, ask, granted, list } = await started()
    await granted('client-1', [inbox, write])
    await granted('client-10', [inbox])
    await granted('note-bot', [log], gamma, beta)
    await ask('client-3', [read])
    await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client-3' }, trusted)
    expect((await list()).identities).toEqual([
      { root: 'mcp-http-handler', field: 'client-1', items: [inbox, write], revoked: false },
      { root: 'mcp-http-handler', field: 'client-10', items: [inbox], revoked: false },
      { root: 'beta', field: 'note-bot', items: [log], revoked: false },
      { root: 'mcp-http-handler', field: 'client-3', items: [], revoked: true },
    ])
  })

  it('answers core.identities about the calling plugin\'s own pairs alone', async () => {
    const { pluginsManager, ask, granted, identities } = await started()
    await granted('client-1', [inbox])
    await granted('client-2', [inbox], gamma, beta)
    await ask('client-3', [read])
    await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client-3' }, trusted)
    expect(await identities(['client-1', 'client-2', 'client-3'])).toEqual([
      { field: 'client-1', holds: 'items' }, { field: 'client-2', holds: 'none' }, { field: 'client-3', holds: 'revoked' },
    ])
    expect(await identities(['client-1', 'client-2'], beta)).toEqual([{ field: 'client-1', holds: 'none' }, { field: 'client-2', holds: 'items' }])
  })
})

describe('an ask that lapses or is withdrawn', () => {
  it('lapses five minutes after it was raised and then can\'t be confirmed', async () => {
    const { pluginsManager, ask, clock, link, snapshot } = await started()
    await ask('client-1', [inbox])
    const id = pluginsManager.pending()[0].id
    clock.now += 5 * 60_000 - 1
    expect(pluginsManager.pending()).toHaveLength(1)
    clock.now += 1
    expect(pluginsManager.pending()).toEqual([])
    expect(link.events('security.lapsed')).toMatchObject([{ kind: 'identity.ask', target: 'mcp-http-handler', field: 'client-1', window: 'core' }])
    expect(await code(pluginsManager.confirm(id, {}))).toBe('not-found')
    expect(snapshot().pairs).toEqual({})
  })

  it.each([['the plugin that asked', gamma], ['the root plugin', beta]])('withdraws the pair\'s waiting ask when %s stops', async (_who, caller) => {
    const { pluginsManager, ask, link } = await started()
    await ask('client-1', [inbox], gamma, beta)
    await ask('client-1', [inbox])
    pluginsManager.crashed(caller, 'closed')
    expect(pluginsManager.pending().map(one => one.plugin)).toEqual(['mcp'])
    expect(link.events('security.withdrawn')).toMatchObject([{ kind: 'identity.ask', target: 'beta' }])
  })

  it('withdraws the pair\'s waiting ask when the human switches the plugin that asked off', async () => {
    const { pluginsManager, ask } = await started()
    await ask('client-1', [inbox])
    await pluginsManager.request({ kind: 'plugin.off', plugin: 'mcp' }, trusted)
    await pluginsManager.settled()
    expect(pluginsManager.pending()).toEqual([])
  })

  // The Confirm's record held back until the test lands it, so the ask can go while the Confirm waits on it. Resolves
  // once the Confirm waits on its record, with what lands it
  function holdConfirm(link: FakeLink): Promise<() => void> {
    return new Promise(held => {
      link.landing = event => (event === 'security.confirm' ? new Promise(resolve => held(() => resolve('landed'))) : 'landed')
    })
  }

  it('applies nothing for a Confirm whose ask was withdrawn while its record landed', async () => {
    const { pluginsManager, ask, link, runtime, snapshot } = await started()
    await ask('client-1', [inbox])
    const holding = holdConfirm(link)
    const confirming = code(pluginsManager.confirm(pluginsManager.pending()[0].id, {}))
    const land = await holding
    runtime.half('mcp').crash()
    await until(() => pluginsManager.pending().length === 0)
    land()
    expect(await confirming).toBe('not-found')
    expect(snapshot().pairs).toEqual({})
  })

  it('applies nothing for a Confirm whose ask lapsed while its record landed and still applies one whose ask stayed', async () => {
    const { pluginsManager, ask, link, clock, snapshot } = await started()
    await ask('client-1', [inbox])
    clock.now += 5 * 60_000 - 1
    let holding = holdConfirm(link)
    let confirming = code(pluginsManager.confirm(pluginsManager.pending()[0].id, {}))
    let land = await holding
    clock.now += 1
    land()
    expect(await confirming).toBe('not-found')
    expect(snapshot().pairs).toEqual({})
    await ask('client-1', [inbox])
    holding = holdConfirm(link)
    confirming = code(pluginsManager.confirm(pluginsManager.pending()[0].id, {}))
    land = await holding
    land()
    expect(await confirming).toBeNull()
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { 'client-1': [item(inbox)] } })
  })
})

describe('the records of an ask, its Confirm and a revoke', () => {
  // A field with quotes, a space and a letter outside ASCII, which the records carry whole
  const field = 'say "yes" bot \u00e9'

  it('name the root plugin as their target and the field beside it, each one line of the event log read back whole', async () => {
    const { pluginsManager, ask, link, base } = await started()
    await ask(field, [inbox])
    await pluginsManager.confirm(pluginsManager.pending()[0].id, {})
    expect(await pluginsManager.request({ kind: 'identity.revoke', root: 'mcp-http-handler', field }, trusted)).toEqual({ applied: true })
    const written = link.records.filter(record => record.event.startsWith('security.'))
    expect(written.map(record => [record.event, record.fields.kind, record.fields.target, record.fields.field])).toEqual([
      ['security.request', 'identity.ask', 'mcp-http-handler', field], ['security.confirm', 'identity.ask', 'mcp-http-handler', field],
      ['security.applied', 'identity.ask', 'mcp-http-handler', field], ['security.applied', 'identity.revoke', 'mcp-http-handler', field],
    ])
    const events = new EventLog(path.join(base, 'records'))
    await events.open()
    for (const record of written) await events.append(record.event, record.fields)
    const lines = (await readFile(path.join(base, 'records', 'events', 'events-1.jsonl'), 'utf8')).split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(written.length)
    expect(lines.map(line => JSON.parse(line).field)).toEqual(written.map(() => field))
    expect(await events.verify()).toMatchObject({ ok: true })
  })
})

describe('a root plugin removed or reset', () => {
  it.each(['plugin.remove', 'plugin.reset'] as const)('drops its pairs\' items on %s and keeps their revoked fields for the run', async kind => {
    const { pluginsManager, ask, granted, snapshot } = await started()
    await granted('client-1', [inbox], gamma, beta)
    await granted('client-1', [inbox])
    await ask('nag-1', [read], gamma, beta)
    await pluginsManager.request({ kind: 'identity.revoke', root: 'beta', field: 'nag-1' }, trusted)
    const held = await pluginsManager.request({ kind, plugin: 'beta' }, trusted)
    if ('held' in held) await pluginsManager.confirm(held.held, {})
    await pluginsManager.settled()
    expect(snapshot().pairs).toEqual({ 'mcp-http-handler': { 'client-1': [item(inbox)] } })
    expect(snapshot().revoked).toEqual({ beta: ['nag-1'] })
  })
})
