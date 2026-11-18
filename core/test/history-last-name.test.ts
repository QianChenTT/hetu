import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import type { Call, Prepared } from '../api/slots.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore, type Plugin } from '../backend/boot/state.ts'
import { wireCore } from '../backend/wire.ts'
import { createGate } from '../../core-plugins/gate/src/gate.ts'
import { createHistory } from '../../core-plugins/history/src/history.ts'
import { createLuoshu } from '../../core-plugins/luoshu/src/luoshu.ts'
import { coreInstall, entryFor, FakeRuntime, filesFor, hostManifest, tempBase, until, workerManifest, writeFolder, writeInstall } from './loader-fakes.ts'

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close()
})

type Reply = { ok?: boolean, result?: { commit?: string | null, text?: string }, refusal?: { code: string } }

// The joined core over a real boot with the gate, the luoshu and history as they ship and a folder plugin for each
// grant list given. Around history's provider: what happens before a commit of the paths named is performed
async function world(folders: Record<string, Capability[]>) {
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  const folder = path.join(base, 'notes')
  await mkdir(installDir, { recursive: true })
  await mkdir(folder, { recursive: true })
  await writeInstall(installDir, {
    ...coreInstall(),
    luoshu: { files: filesFor(hostManifest('luoshu')) },
    history: { files: filesFor(hostManifest('history', { requires: ['luoshu'] })) },
  })
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder })
  for (const [id, granted] of Object.entries(folders)) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, { capabilities: granted }) as never))
    await store.writePlugin(id, await entryFor(root, { granted, class: 4 } as Partial<Plugin>))
  }
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const luoshu = createLuoshu({ settleMs: 50 })
  const history = createHistory()
  await history.start(dataDir)
  const before = new Map<string, () => Promise<void>>()
  const provider = {
    prepare: history.provider.prepare,
    release: history.provider.release,
    perform: async (call: Call, prepared: Prepared) => {
      const hook = call.action === 'history.commit' ? before.get(JSON.stringify((call.args as { paths: string[] }).paths)) : undefined
      await hook?.()
      return history.provider.perform(call, prepared)
    },
  }
  const runtime = new FakeRuntime()
  runtime.behave = {
    gate: { exports: { gate: createGate() } },
    luoshu: { exports: { provider: luoshu.provider, luoshu: luoshu.role } },
    history: { exports: { provider, history: history.role } },
  }
  const { loader, carrier } = wireCore({ booted, installDir, runtime, confirmDelayMs: 0, debug: () => {} } as never)
  open.push(async () => {
    luoshu.close()
    history.close()
    await loader.shutdown().catch(() => {})
    carrier.close()
    await carrier.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  await loader.start()
  await loader.settled()
  for (const id of Object.keys(folders)) await until(() => loader.plugin(id)?.state === 'ready')
  const ask = async (id: string, action: string, args: unknown) => (await runtime.half(id).ask(action, args, 15_000)) as Reply | null
  return { ask, before }
}

const notGranted = { ok: false, refusal: { code: 'not-granted' } }

// Windows and macOS read two cases of one name as one file
describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('a commit of a note another plugin makes under another case of its last name while the commit waits', () => {
  it('stores none of the other plugin\'s note under the path the gate allowed', async () => {
    const { ask, before } = await world({
      alpha: [{ type: 'luoshu.write', paths: ['r*/**'] }, { type: 'luoshu.read', paths: ['r*/**'] }] as Capability[],
      beta: [
        { type: 'history', access: 'commit', paths: ['r*/n.md'] },
        { type: 'history', access: 'read', paths: ['r*/n.md'] },
      ] as Capability[],
    })
    for (let i = 0; i < 5; i++) {
      expect((await ask('alpha', 'luoshu.write', { path: `r${i}/seed.md`, text: 'seed' }))?.ok).toBe(true)
      // alpha's note lands between the gate's answer on beta's commit and the commit's read of the note
      before.set(JSON.stringify([`r${i}/n.md`]), async () => {
        expect((await ask('alpha', 'luoshu.write', { path: `r${i}/N.md`, text: `ALPHA NOTE ${i}` }))?.ok).toBe(true)
      })
      const made = await ask('beta', 'history.commit', { paths: [`r${i}/n.md`], message: `beta r${i}` })
      expect(made).toMatchObject(notGranted)
      // Once alpha's note has moved on, beta's spelling names its own path again and holds nothing of alpha's
      expect((await ask('alpha', 'luoshu.move', { from: `r${i}/N.md`, to: `r${i}/kept.md` }))?.ok).toBe(true)
      expect(await ask('beta', 'history.log', { path: `r${i}/n.md` })).toMatchObject({ ok: true, result: { commits: [] } })
    }
  }, 60_000)
})
