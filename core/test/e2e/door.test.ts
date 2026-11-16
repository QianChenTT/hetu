import { cp, readdir, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { DOOR_PORT } from '../../api/changes.ts'
import { INSTALL_LIST } from '../../api/install.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { hashFiles, readFiles } from '../../lib/hash-files.ts'
import { buildHost, buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../loader-fakes.ts'
import { cleanup, editorPage, freePort, launch, logged, pageAt, records, repo, temp, tick, until, workersPage } from './helpers.ts'

// The door's proof: the shipped http in its utility process on 127.0.0.1 and a port the test picked, never 4747, with a
// fake mcp in the test install only. The shipped token seam refuses every token, so a request that passes the token
// check runs on an http built from the same source with a seam that takes one test token, in the test install only

const holders: net.Server[] = []

afterEach(async () => {
  await cleanup()
  for (const holder of holders.splice(0)) await new Promise(resolve => holder.close(resolve))
})

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// A first-party id, so it ships in this install as a first-party copy, never in hetu's own list. Its handle takes
// calls from http alone and echoes who called it
const mcp = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    ctx.provide('handle', call => ({ status: 200, body: JSON.stringify({ caller: call.caller, onBehalf: call.onBehalf ?? null }) }))
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

const builtWorker = async (text: string) => {
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': text })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  return built!.text
}

// http from its own source with a seam that takes one test token, in place of the shipped seam that takes none
const keeper = path.join(repo, 'plugins', 'http', 'src', 'keeper.ts').split(path.sep).join('/')
const TEST_TOKEN = 'Bearer test-token-for-the-door'
const seamed = `
import { httpPlugin } from '${keeper}'
export default httpPlugin({ token: async text => (text === '${TEST_TOKEN}' ? { client: 'https://client.example/metadata' } : null) })
`

// The shipped install, with the fake mcp beside it when asked and http built with the test seam when asked
async function install(withMcp: boolean, testSeam = false): Promise<string> {
  const dir = await temp()
  const dist = path.join(repo, 'core', 'dist')
  await cp(path.join(dist, 'plugins'), path.join(dir, 'plugins'), { recursive: true })
  const list = JSON.parse(await readFile(path.join(dist, INSTALL_LIST), 'utf8')) as { format: number, plugins: Record<string, unknown> }
  expect(Object.keys(list.plugins)).toContain('http')
  expect(Object.keys(list.plugins)).not.toContain('mcp')
  if (withMcp) {
    const root = path.join(dir, 'plugins', 'mcp')
    await writeFolder(root, filesFor(workerManifest('mcp', { provides: { actions: { handle: { from: ['http'] } } } }), { 'worker.js': await builtWorker(mcp) }))
    list.plugins.mcp = { path: 'plugins/mcp', version: '1.0.0', hash: hashFiles(await readFiles(root)), firstParty: true }
  }
  if (testSeam) {
    const source = await temp()
    await writeFolder(source, { 'src/host.ts': seamed })
    const root = path.join(dir, 'plugins', 'http')
    await writeFile(path.join(root, 'dist', 'host.js'), (await buildHost(source, 'src/host.ts', ['http'])).text)
    ;(list.plugins.http as { hash: string }).hash = hashFiles(await readFiles(root))
  }
  await writeFile(path.join(dir, INSTALL_LIST), `${JSON.stringify(list, null, 2)}\n`)
  return dir
}

// A data folder with a folder plugin that holds plugin.call on mcp and the door's port in its switches
async function data(port: number): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), port })
  const root = path.join(dataDir, 'plugins', 'caller')
  const granted = [{ type: 'plugin.call' as const, targets: ['mcp'] }]
  await writeFolder(root, filesFor(workerManifest('caller', { capabilities: granted }), { 'worker.js': await builtWorker(caller) }))
  await store.writePlugin('caller', await entryFor(root, { granted }))
  return dataDir
}

async function started(withMcp: boolean, given?: number, options: { testSeam?: boolean, dataDir?: string } = {}): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, port: number }> {
  const port = given ?? await freePort()
  const dataDir = options.dataDir ?? await data(port)
  const app = await launch(dataDir, { HETU_INSTALL_DIR: await install(withMcp, options.testSeam === true) })
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'caller' }))
  return { app, editor, dataDir, port }
}

const canConnect = (port: number) => new Promise<boolean>(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})

// One request written as it is on its own connection, answered with the status line's code
function status(port: number, lines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let raw = ''
    socket.on('data', chunk => { raw += chunk.toString('latin1') })
    socket.on('error', reject)
    socket.on('close', () => resolve(Number(raw.split(' ')[1])))
    socket.once('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n{}`))
  })
}
const post = (port: number, extra: string[]) => status(port, ['POST /mcp HTTP/1.1', ...extra, 'Content-Type: application/json', 'Content-Length: 2', 'Connection: close'])

// A call from the editor through the shell's bridge
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    if ((message as { id?: unknown }).id === id) resolve(message)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [9000 + Math.floor(Math.random() * 1000), action, args] as const) as Promise<{ ok: boolean, result?: unknown }>

const utilityFolders = async () => (await readdir(tmpdir())).filter(name => name.startsWith('hetu-utility-'))

// Past the trusted window's input delay, inside which anything but a read counts for nothing
const PAST_DELAY = 2000

describe('the door', () => {
  // The port is held for the whole run, so no other program takes it while mcp is away
  it('holds its port with no mcp in the install, answering 503 and reaching nothing, http reading ready', async () => {
    const { dataDir, port } = await started(false)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'http' }))
    expect(await canConnect(port)).toBe(true)
    expect(await post(port, [`Host: 127.0.0.1:${port}`, 'Authorization: Bearer any'])).toBe(503)
    expect(await logged(dataDir, 'plugin.failed', { plugin: 'http' })).toBe(false)
    expect((await records(dataDir)).filter(record => record.event === 'audit.call' && record.action === 'mcp.handle')).toEqual([])
  })

  it('refuses another Host and an Origin with 403, reaching nothing, each reason in one http.refused with its count', async () => {
    const { dataDir, port } = await started(true)
    await until(() => canConnect(port))
    expect(await post(port, ['Host: evil.example', 'Authorization: Bearer any'])).toBe(403)
    expect(await post(port, [`Host: localhost:${port}`, 'Authorization: Bearer any'])).toBe(403)
    expect(await post(port, [`Host: 127.0.0.1:${port}`, 'Origin: https://evil.example', 'Authorization: Bearer any'])).toBe(403)
    // The shipped seam refuses every token
    expect(await post(port, [`Host: 127.0.0.1:${port}`, 'Authorization: Bearer any'])).toBe(401)
    await until(async () => (await records(dataDir)).filter(record => record.event === 'http.refused').length === 3)
    await tick(1500)
    const refused = (await records(dataDir)).filter(record => record.event === 'http.refused')
    expect(refused.map(record => [record.reason, record.count]).sort()).toEqual([['host', 2], ['origin', 1], ['token', 1]])
    expect((await records(dataDir)).filter(record => record.event === 'audit.call' && record.action === 'mcp.handle')).toEqual([])
  })

  it('refuses another plugin\'s worker that holds plugin.call on mcp at mcp.handle', async () => {
    const { app, dataDir } = await started(true)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'mcp' }))
    const page = await workersPage(app, 'caller')
    await until(() => page.workers().length === 1)
    const worker = page.workers()[0] as Worker
    const answer = await worker.evaluate(`globalThis.ctx.call('mcp', 'handle', { body: '{}', headers: {} }).then(value => ({ value }), error => ({ refused: error.code }))`)
    expect(answer).toEqual({ refused: 'not-granted' })
  })

  it('reads failed (port-taken) in the trusted window while another program holds its port and comes up on Restart once it is free', async () => {
    const port = await freePort()
    const holder = net.createServer(socket => socket.destroy())
    holders.push(holder)
    await new Promise<void>(resolve => holder.listen({ host: '127.0.0.1', port, exclusive: true }, resolve))
    const { app, editor, dataDir } = await started(true, port)
    await until(() => logged(dataDir, 'plugin.failed', { plugin: 'http', reason: 'port-taken' }))
    expect((await ask(editor, 'security.open')).ok).toBe(true)
    const trusted = await pageAt(app, 'hetu://trusted/')
    const row = trusted.locator('div.plugin', { hasText: 'http · ships with hetu' })
    await until(async () => (await row.locator('p').first().textContent()) === 'http · ships with hetu · utility · failed (port-taken)')
    await new Promise<void>(resolve => holder.close(() => resolve()))
    holders.splice(holders.indexOf(holder), 1)
    expect(await canConnect(port)).toBe(false)
    await tick(PAST_DELAY)
    await row.getByRole('button', { name: 'Restart', exact: true }).click()
    await until(() => canConnect(port))
    expect(await post(port, [`Host: 127.0.0.1:${port}`, 'Authorization: Bearer any'])).toBe(401)
    await until(async () => (await row.locator('p').first().textContent()) === 'http · ships with hetu · utility · ready')
  })

  // The port is the human's per-machine switch: asked for in the trusted window, applied on its Confirm, http started
  // again on it and the Host check following it
  it('moves to the port confirmed in the trusted window, the old port let go and its Host refused', async () => {
    expect(await canConnect(DOOR_PORT)).toBe(false)
    const { app, editor, dataDir, port } = await started(true)
    await until(() => canConnect(port))
    const moved = await freePort()
    expect((await ask(editor, 'security.open')).ok).toBe(true)
    const trusted = await pageAt(app, 'hetu://trusted/')
    await tick(PAST_DELAY)
    expect(await ask(trusted, 'security.request', { change: { kind: 'port.set', port: moved } })).toMatchObject({ ok: true, result: { held: expect.any(String) } })
    await until(async () => (await trusted.locator('#root').innerText()).includes(`Move the agent door to 127.0.0.1:${moved}`))
    expect(await canConnect(moved)).toBe(false)
    await tick(PAST_DELAY)
    await trusted.getByRole('button', { name: 'Confirm' }).click()
    await until(() => canConnect(moved))
    expect(await canConnect(port)).toBe(false)
    expect((await new StateStore(dataDir).load()).state.switches.port).toBe(moved)
    expect(await post(moved, [`Host: 127.0.0.1:${port}`, 'Authorization: Bearer any'])).toBe(403)
    expect(await post(moved, [`Host: 127.0.0.1:${moved}`, 'Authorization: Bearer any'])).toBe(401)
    expect(await canConnect(DOOR_PORT)).toBe(false)
  })

  it('leaves no utility working folder and the port free after a clean quit', async () => {
    const before = await utilityFolders()
    const { app, port } = await started(true)
    await until(() => canConnect(port))
    expect((await utilityFolders()).length).toBeGreaterThan(before.length)
    await app.close()
    await until(async () => !(await canConnect(port)))
    await until(async () => (await utilityFolders()).filter(name => !before.includes(name)).length === 0)
  })
})


// The door made ready, in one data folder: the real build on a port the test picked, 503 with no mcp, served with it,
// a flood with no token leaving a good request served and the port moved through the trusted window's Confirm. Nothing
// on 4747 before or after
describe('the door made ready', () => {
  it('holds the port the test picked, answers 503 with no mcp and serves with it, through a flood and a move', async () => {
    expect(await canConnect(DOOR_PORT)).toBe(false)
    const port = await freePort()
    const dataDir = await data(port)
    const good = (at: number) => post(at, [`Host: 127.0.0.1:${at}`, `Authorization: ${TEST_TOKEN}`])

    const away = await started(false, port, { testSeam: true, dataDir })
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'http' }))
    expect(await canConnect(port)).toBe(true)
    expect(await good(port)).toBe(503)
    await away.app.close()
    await until(async () => !(await canConnect(port)))

    const { app, editor } = await started(true, port, { testSeam: true, dataDir })
    await until(async () => (await good(port)) === 200)
    // 50 requests a second with no token for 2 s, a good one every 200 ms beside them
    const flood: Promise<number>[] = []
    const goods: Promise<number>[] = []
    for (let i = 0; i < 100; i++) {
      flood.push(post(port, [`Host: 127.0.0.1:${port}`]))
      if (i % 10 === 0) goods.push(good(port))
      await tick(20)
    }
    expect(await Promise.all(goods)).toEqual(Array(10).fill(200))
    const answered = await Promise.all(flood)
    expect(answered.filter(code => code === 401).length + answered.filter(code => code === 429).length).toBe(100)
    expect(answered.filter(code => code === 429).length).toBeGreaterThan(0)

    const moved = await freePort()
    expect((await ask(editor, 'security.open')).ok).toBe(true)
    const trusted = await pageAt(app, 'hetu://trusted/')
    await tick(PAST_DELAY)
    expect(await ask(trusted, 'security.request', { change: { kind: 'port.set', port: moved } })).toMatchObject({ ok: true })
    await until(async () => (await trusted.locator('#root').innerText()).includes(`Move the agent door to 127.0.0.1:${moved}`))
    await tick(PAST_DELAY)
    await trusted.getByRole('button', { name: 'Confirm' }).click()
    await until(async () => (await canConnect(moved)) && (await good(moved)) === 200)
    expect(await canConnect(port)).toBe(false)
    expect(await canConnect(DOOR_PORT)).toBe(false)
    await app.close()
    // The utility process can outlive main by a moment
    await until(async () => !(await canConnect(moved)))
    expect(await canConnect(DOOR_PORT)).toBe(false)
  })
})
