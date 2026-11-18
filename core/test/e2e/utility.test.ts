import { cp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_LIST } from '../../api/install.ts'
import { API_VERSION } from '../../api/manifest.ts'
import { defaultSwitches, StateStore, type Switches } from '../../backend/boot/state.ts'
import { baseEnv } from '../../lib/clean-env.ts'
import { hashFiles, readFiles } from '../../lib/hash-files.ts'
import { buildHost, buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../loader-fakes.ts'
import { cleanup, editorPage, launch, logged, pageAt, records, repo, temp, until, workersPage } from './helpers.ts'

// The utility place's proof: http's host entry in a utility process, here a hello plugin standing in for http, called
// by a folder plugin's worker

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

// What a child on macOS has from outside main's environment: Chromium's launcher passes every child its Mach port
// validation policy, and CoreFoundation sets the user's text encoding from the uid when it is unset
const notFromMain = process.platform === 'darwin' ? ['MACH_PORT_RENDEZVOUS_PEER_VALDATION', '__CF_USER_TEXT_ENCODING'] : []

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
  const root = path.join(dir, 'plugins', 'mcp-http-handler')
  const manifest = { id: 'mcp-http-handler', name: 'mcp-http-handler', version: '1.0.0', api: `^${API_VERSION}`, entries: { host: 'dist/host.js' }, node: ['fs'], provides: { actions: { hello: { from: ['caller'] }, hang: { from: ['caller'] }, flood: { from: ['caller'] } } } }
  await writeFolder(root, { 'hetu-plugin.json': `${JSON.stringify(manifest, null, 2)}\n`, 'dist/host.js': built.text })
  list.plugins['mcp-http-handler'] = { path: 'plugins/mcp-http-handler', version: '1.0.0', hash: hashFiles(await readFiles(root)) }
  await writeFile(path.join(dir, INSTALL_LIST), `${JSON.stringify(list, null, 2)}\n`)
  return dir
}

// A data folder with the caller approved to call http, and http's heartbeat and rate lowered so a hang shows within a
// test. more holds more of http's limits and switches more of the switches
async function data(more: Record<string, number> = {}, switches: Partial<Switches> = {}): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({
    ...defaultSwitches(),
    limits: { all: {}, plugins: { 'mcp-http-handler': { heartbeatMs: 300, heartbeatMisses: 2, messagesPerSecond: 10, floodMs: 1000, ...more } } },
    ...switches,
  })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': caller })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const root = path.join(dataDir, 'plugins', 'caller')
  const granted = [{ type: 'plugin.call' as const, targets: ['mcp-http-handler'] }]
  await writeFolder(root, filesFor(workerManifest('caller', { requires: ['mcp-http-handler'], capabilities: granted }), { 'worker.js': built!.text }))
  await store.writePlugin('caller', await entryFor(root, { granted }))
  return dataDir
}

async function started(
  more: Record<string, number> = {},
  switches: Partial<Switches> = {},
): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, worker: Worker }> {
  const dataDir = await data(more, switches)
  const app = await launch(dataDir, { HETU_INSTALL_DIR: await install() })
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'caller' }))
  const page = await workersPage(app, 'caller')
  await until(() => page.workers().length === 1)
  return { app, editor, dataDir, worker: page.workers()[0] as Worker }
}

const call = <T>(worker: Worker, action: string) =>
  worker.evaluate(`globalThis.ctx.call('mcp-http-handler', '${action}', {})`) as Promise<T>

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
    expect(await logged(dataDir, 'plugin.started', { plugin: 'mcp-http-handler' })).toBe(true)
    const facts = await call<Facts>(worker, 'hello')
    expect(facts.self).toEqual({ kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 })
    expect(facts.dataDir).toBe(null)
    expect(facts.envNames).toEqual([...Object.keys(baseEnv()), ...notFromMain].sort())
    expect(facts.envText).not.toContain(dataDir)
    expect(facts.cwdEntries).toBe(0)
    expect(facts.cwd.startsWith(dataDir)).toBe(false)
    expect(facts.pid).not.toBe(process.pid)
  })

  it('is killed once hung and reads crashed, and hetu runs on', async () => {
    const { worker, editor, dataDir } = await started()
    const { pid } = await call<Facts>(worker, 'hello')
    expect(await call<string>(worker, 'hang')).toBe('hanging')
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'mcp-http-handler', reason: 'unresponsive' }))
    await until(() => !alive(pid))
    expect((await ask(editor, 'core.status')).ok).toBe(true)
  })

  // A flood cap of 20 in a second, which the burst of the flood call crosses before http answers it. A half over its
  // rate loses its pongs, but everything main hears from it counts as alive, so it is never read as hung while it floods
  // and only the cap ends it. The answer never reaches main and the caller requires http, so it stops with http and
  // its call is refused
  it('has its way closed for a flood, reads crashed and starts again on core.restart from the trusted window alone', async () => {
    const { app, worker, editor, dataDir } = await started({ floodFactor: 2 })
    const { pid } = await call<Facts>(worker, 'hello')
    const answer = await worker.evaluate(`globalThis.ctx.call('mcp-http-handler', 'flood', {}).then(value => ({ value }), error => ({ refused: error.code }))`)
    expect(answer).toHaveProperty('refused')
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'mcp-http-handler', reason: 'flood' }))
    await until(() => !alive(pid))
    expect((await ask(editor, 'core.status')).ok).toBe(true)
    expect(await ask(editor, 'core.restart', { plugin: 'mcp-http-handler' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect((await ask(editor, 'security.open')).ok).toBe(true)
    const trusted = await pageAt(app, 'hetu://trusted/')
    // Past the trusted window's input delay, inside which a request counts for nothing
    await new Promise(resolve => setTimeout(resolve, 2000))
    expect((await ask(trusted, 'core.restart', { plugin: 'mcp-http-handler' })).ok).toBe(true)
    await until(async () => (await records(dataDir)).filter(record => record.event === 'plugin.started' && record.plugin === 'mcp-http-handler').length === 2)
  })

  // Lowered from 50 to 10 a second through the trusted window while the caller keeps 8 calls in flight for 6 s. Paced
  // at the old rate the half would send about 45 a second and lose what main drops past 10, so calls would time out.
  // Main hears it all the same, so a dropped pong never kills it
  it('paces itself to a rate the human lowers while it runs and is never cut off for it', async () => {
    const { app, editor, worker, dataDir } = await started({ heartbeatMs: 2000, messagesPerSecond: 50 }, { confirmOff: true })
    const { pid } = await call<Facts>(worker, 'hello')
    expect((await ask(editor, 'security.open')).ok).toBe(true)
    const trusted = await pageAt(app, 'hetu://trusted/')
    // Past the trusted window's input delay, inside which a request counts for nothing
    await new Promise(resolve => setTimeout(resolve, 2000))
    const change = { kind: 'limit.set', constant: 'messagesPerSecond', value: 10, plugin: 'mcp-http-handler' }
    expect(await ask(trusted, 'security.request', { change })).toMatchObject({ ok: true, result: { applied: true } })
    const load = await worker.evaluate(`(async () => {
      const end = Date.now() + 6000
      let answered = 0
      const refused = []
      const one = async () => {
        while (Date.now() < end) {
          try {
            await globalThis.ctx.call('mcp-http-handler', 'hello', {})
            answered++
          } catch (error) {
            refused.push(error.code)
            return
          }
        }
      }
      await Promise.all(Array.from({ length: 8 }, one))
      return { answered, refused }
    })()`) as { answered: number, refused: string[] }
    expect(load.refused).toEqual([])
    expect(load.answered).toBeGreaterThan(0)
    expect(await logged(dataDir, 'plugin.crashed', { plugin: 'mcp-http-handler' })).toBe(false)
    expect(alive(pid)).toBe(true)
  })
})
