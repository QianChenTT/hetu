import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { providerActions, type CoreStatus } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import { coreModuleIds, corePluginIds } from '../api/ids.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore } from '../backend/boot/state.ts'
import { quitInOrder } from '../backend/runtime/quit.ts'
import { wireCore } from '../backend/wire.ts'
import { coreInstall, FakeRuntime, filesFor, hostManifest, manifest, tempBase, writeInstall } from './plugins-manager-fakes.ts'

// D-637: hetu with every core module and core plugin switched off is an incomplete note taking app, not a crash
// (D-512). Case A has everything off, case B only the luoshu on

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

type Reply = { ok?: boolean, result?: unknown, refusal?: { code: string } }

// Every id the human can switch off, read from core/api so a new module or core plugin is switched off here too
const everything = [...coreModuleIds, ...corePluginIds]

// The core plugins built today as the build puts them in the install, so their switches have a plugin to keep off
const install = () => ({
  ...coreInstall(),
  'hidden-marks': { files: filesFor(manifest('hidden-marks', { entries: { page: 'dist/page.js' } }), { 'dist/page.js': '// hidden marks' }) },
  'mcp-http-handler': { files: filesFor(hostManifest('mcp-http-handler', { requires: ['storage'] })) },
})

// The joined core as main joins it over a real boot, every core module the real one, with the ids in on left on and
// the luoshu folder picked. Calls come from the editor window. The runtime's own actions go to a stand-in for main's,
// which notes each one, and quit is main's quit in order
async function joined(on: readonly string[] = []) {
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  const folder = path.join(base, 'notes')
  await mkdir(installDir, { recursive: true })
  await mkdir(folder, { recursive: true })
  await writeInstall(installDir, install())
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: everything.filter(id => !on.includes(id)) })
  await store.writeLuoshu({ folder })
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const runtime = new FakeRuntime()
  const served: string[] = []
  const { recording, pluginsManager, router } = wireCore({
    booted, installDir, runtime, confirmDelayMs: 0,
    windows: { serve: async call => (served.push(call.action), null), armed: () => false },
  })
  let quit: Promise<string[]> | null = null
  const quitted = () => (quit ??= quitInOrder({ pluginsManager, router, recording, release: booted.release }))
  open.push(async () => {
    await quitted()
    for (const port of runtime.ports) port.close()
    await rm(base, { recursive: true, force: true })
  })
  await pluginsManager.start()
  await pluginsManager.settled()
  const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
  const waiting = new Map<number, (reply: Reply) => void>()
  const receive = router.window<string>(sender => (sender === 'editor' ? editor : null))
  let next = 1
  const ask = (action: string, args?: unknown) => new Promise<Reply>(resolve => {
    const id = next++
    waiting.set(id, resolve)
    receive('editor', { v: 1, kind: 'call', id, action, args }, message => {
      const reply = message as Reply & { id?: number }
      if (typeof reply.id !== 'number') return
      waiting.get(reply.id)?.(reply)
      waiting.delete(reply.id)
    })
  })
  return { pluginsManager, runtime, dataDir, served, ask, quit: quitted }
}

const codeOf = (reply: Reply) => (reply.ok === true ? 'ok' : reply.refusal?.code)
const VERSION = '0'.repeat(64)

// Each provider action with args its schema takes, so the refusal is the module's and not the args'. A provider action
// added to core/api fails the first check below until it is named here
const providerCalls: Record<string, unknown> = {
  'luoshu.read': { path: 'a.md' },
  'luoshu.list': {},
  'luoshu.write': { path: 'a.md', text: 'hi' },
  'luoshu.remove': { path: 'a.md', baseVersion: VERSION },
  'luoshu.move': { from: 'a.md', to: 'b.md' },
  'lock.set': { paths: ['a.md'], ms: 1000 },
  'lock.clear': { paths: ['a.md'] },
  'lock.held': { paths: ['a.md'] },
  'storage.get': { key: 'k' },
  'storage.set': { key: 'k', value: 1 },
  'storage.delete': { key: 'k' },
  'cache.get': { key: 'k' },
  'cache.set': { key: 'k', value: 1 },
  'cache.delete': { key: 'k' },
  'history.commit': { paths: ['a.md'], message: 'm' },
  'history.log': { path: 'a.md' },
  'history.read': { path: 'a.md', commit: 'a'.repeat(40) },
  'exec.run': { command: ['git', 'status'] },
}

describe('hetu with every core module and core plugin switched off', () => {
  it('boots with no fail-safe and no stopped mode, every module off and no plugin started', async () => {
    const { pluginsManager, runtime, ask } = await joined()
    expect(pluginsManager.stopped()).toBe(null)
    const reply = await ask('core.status')
    expect(reply.ok).toBe(true)
    const status = reply.result as CoreStatus
    expect(status.stopped).toBe(null)
    expect(status.crashed).toEqual([])
    // The gate and the classifier off read as no step, the rest each named off
    expect(Object.values(status.policyJobs).every(state => state === 'off')).toBe(true)
    expect([...Object.keys(status.policyJobs), ...status.modulesOff].sort()).toEqual([...coreModuleIds].sort())
    expect(status.page).toEqual([])
    expect(runtime.started).toEqual([])
    expect(pluginsManager.list().map(row => [row.id, row.state])).toEqual(Object.keys(install()).map(id => [id, 'off']))
  })

  it('answers the editor\'s start calls', async () => {
    const { ask } = await joined()
    // The subscribes of shell.ts, bridge.ts and notes.ts
    for (const topics of [['core.status', 'core.quitting'], ['core.security'], ['luoshu.changed', 'luoshu.outside']]) {
      expect(await ask('events.subscribe', { topics })).toMatchObject({ ok: true, result: { standing: [] } })
    }
    expect(codeOf(await ask('core.status'))).toBe('ok')
    expect(await ask('core.views')).toMatchObject({ ok: true, result: { plugins: [] } })
    // settings.ts's load, which keeps the defaults on a refusal
    expect(codeOf(await ask('storage.get', { key: 'settings' }))).toBe('unavailable')
  })

  it('refuses every provider call unavailable, never throwing', async () => {
    expect(Object.keys(providerCalls).sort()).toEqual(Object.keys(providerActions).sort())
    const { ask } = await joined()
    const codes: Record<string, string | undefined> = {}
    for (const [action, args] of Object.entries(providerCalls)) codes[action] = codeOf(await ask(action, args))
    expect(codes).toEqual(Object.fromEntries(Object.keys(providerCalls).map(action => [action, 'unavailable'])))
  })

  // The runtime serves its own actions whatever the switches say, so opening the trusted window still works
  it('still opens the trusted window, which the runtime serves and no module', async () => {
    const { ask, served } = await joined()
    expect(codeOf(await ask('app.openSecurity'))).toBe('ok')
    expect(served).toEqual(['app.openSecurity'])
  })

  it('quits leaving no hetu.lock', async () => {
    const { dataDir, quit } = await joined()
    expect(await readdir(dataDir)).toContain('hetu.lock')
    expect(await quit()).toEqual([])
    expect(await readdir(dataDir)).not.toContain('hetu.lock')
  })
})

describe('hetu with only the luoshu on', () => {
  it('writes a note, lists it and reads it back with the same text', async () => {
    const { ask } = await joined(['luoshu'])
    const text = '# A note\n\nwritten with everything else off\n'
    expect(codeOf(await ask('luoshu.write', { path: 'a.md', text }))).toBe('ok')
    expect(await ask('luoshu.list', {})).toMatchObject({ ok: true, result: { paths: ['a.md'] } })
    expect(await ask('luoshu.read', { path: 'a.md' })).toMatchObject({ ok: true, result: { path: 'a.md', text } })
  })
})
