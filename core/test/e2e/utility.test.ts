import { cp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_LIST } from '../../api/install.ts'
import { API_VERSION } from '../../api/manifest.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { baseEnv } from '../../lib/clean-env.ts'
import { hashFiles, readFiles } from '../../lib/hash-files.ts'
import { buildHost, buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../loader-fakes.ts'
import { cleanup, editorPage, launch, logged, records, repo, temp, until, workersPage } from './helpers.ts'

// The utility place's proof: http's host entry in a utility process, here a hello plugin standing in for http, called
// by a folder plugin's worker. Not run while test windows can't stay off the screen

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// The hello utility plugin: what it was told and what it finds from inside, its own caller as the core names it, a
// hang and a flood. The flood runs its clock fast so the SDK's pacing lets every message through at once, as a
// taken-over half could
const hello = `
import { readdirSync } from 'node:fs'
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    ctx.provide('hello', async () => ({
      self: await ctx.call('core', 'self', {}),
      dataDir: ctx.dataDir,
      envNames: Object.keys(process.env).sort(),
      envText: Object.values(process.env).join('\\n'),
      cwd: process.cwd(),
      cwdEntries: readdirSync(process.cwd()).length,
      pid: process.pid,
    }))
    ctx.provide('hang', () => {
      setTimeout(() => { for (;;) {} }, 50)
      return 'hanging'
    })
    ctx.provide('flood', () => {
      let now = 0
      performance.now = () => (now += 10_000)
      for (let i = 0; i < 20_000; i++) void ctx.call('core', 'self', {}).catch(() => {})
      return 'flooding'
    })
  },
})
`

// A folder plugin whose worker hands its context to the test
const caller = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    ;(globalThis as Record<string, unknown>).ctx = ctx
  },
})
`

type Facts = { self: unknown, dataDir: string | null, envNames: string[], envText: string, cwd: string, cwdEntries: number, pid: number }

// The shipped install with the hello plugin as http beside it
async function install(): Promise<string> {
  const dir = await temp()
  const dist = path.join(repo, 'core', 'dist')
  await cp(path.join(dist, 'plugins'), path.join(dir, 'plugins'), { recursive: true })
  const list = JSON.parse(await readFile(path.join(dist, INSTALL_LIST), 'utf8')) as { format: number, plugins: Record<string, unknown> }
  const source = await temp()
  await writeFolder(source, { 'src/host.ts': hello })
  const built = await buildHost(source, 'src/host.ts', ['fs'])
  const root = path.join(dir, 'plugins', 'http')
  const manifest = { id: 'http', name: 'http', version: '1.0.0', api: `^${API_VERSION}`, entries: { host: 'dist/host.js' }, node: ['fs'], provides: { actions: { hello: { from: ['caller'] }, hang: { from: ['caller'] }, flood: { from: ['caller'] } } } }
  await writeFolder(root, { 'hetu-plugin.json': `${JSON.stringify(manifest, null, 2)}\n`, 'dist/host.js': built.text })
  list.plugins.http = { path: 'plugins/http', version: '1.0.0', hash: hashFiles(await readFiles(root)) }
  await writeFile(path.join(dir, INSTALL_LIST), `${JSON.stringify(list, null, 2)}\n`)
  return dir
}

// A data folder with the caller approved to call http, and http's heartbeat, rate and call deadline lowered so a hang
// and a flood show within a test. A flooding half's calls the carrier drops free their place in flight at the deadline,
// so about 320 messages a second go out against a flood cap of 100 in a second
async function data(): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({
    ...defaultSwitches(),
    limits: { all: {}, plugins: { http: { heartbeatMs: 300, heartbeatMisses: 2, messagesPerSecond: 10, floodMs: 1000, callDeadlineMs: 200 } } },
  })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': caller })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const root = path.join(dataDir, 'plugins', 'caller')
  const granted = [{ type: 'plugin.call' as const, targets: ['http'] }]
  await writeFolder(root, filesFor(workerManifest('caller', { requires: ['http'], capabilities: granted }), { 'worker.js': built!.text }))
  await store.writePlugin('caller', await entryFor(root, { granted }))
  return dataDir
}

async function started(): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, worker: Worker }> {
  const dataDir = await data()
  const app = await launch(dataDir, { HETU_INSTALL_DIR: await install() })
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'caller' }))
  const page = await workersPage(app, 'caller')
  await until(() => page.workers().length === 1)
  return { app, editor, dataDir, worker: page.workers()[0] as Worker }
}

const call = <T>(worker: Worker, action: string) =>
  worker.evaluate(`globalThis.ctx.call('http', '${action}', {})`) as Promise<T>

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A call from the editor through the shell's bridge
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    if ((message as { id?: unknown }).id === id) resolve(message)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [9000 + Math.floor(Math.random() * 1000), action, args] as const) as Promise<{ ok: boolean, result?: unknown }>

describe('a utility half', () => {
  it('answers a call as the core names it, the host half of http, and is told no data folder and none of main\'s environment', async () => {
    const { worker, dataDir } = await started()
    expect(await logged(dataDir, 'plugin.started', { plugin: 'http' })).toBe(true)
    const facts = await call<Facts>(worker, 'hello')
    expect(facts.self).toEqual({ kind: 'plugin', id: 'http', half: 'host', incarnation: 1 })
    expect(facts.dataDir).toBe(null)
    expect(facts.envNames).toEqual(Object.keys(baseEnv()).sort())
    expect(facts.envText).not.toContain(dataDir)
    expect(facts.cwdEntries).toBe(0)
    expect(facts.cwd.startsWith(dataDir)).toBe(false)
    expect(facts.pid).not.toBe(process.pid)
  })

  it('is killed once hung and reads crashed, and hetu runs on', async () => {
    const { worker, editor, dataDir } = await started()
    const { pid } = await call<Facts>(worker, 'hello')
    expect(await call<string>(worker, 'hang')).toBe('hanging')
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'http', reason: 'unresponsive' }))
    await until(() => !alive(pid))
    expect((await ask(editor, 'core.status')).ok).toBe(true)
  })

  it('has its way closed for a flood, reads crashed and starts again on core.restart', async () => {
    const { worker, editor, dataDir } = await started()
    const { pid } = await call<Facts>(worker, 'hello')
    expect(await call<string>(worker, 'flood')).toBe('flooding')
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'http', reason: 'flood' }))
    await until(() => !alive(pid))
    expect((await ask(editor, 'core.status')).ok).toBe(true)
    expect((await ask(editor, 'core.restart', { plugin: 'http' })).ok).toBe(true)
    await until(async () => (await records(dataDir)).filter(record => record.event === 'plugin.started' && record.plugin === 'http').length === 2)
  })
})
