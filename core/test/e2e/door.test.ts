import { cp, readdir, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_LIST } from '../../api/install.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { hashFiles, readFiles } from '../../lib/hash-files.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../loader-fakes.ts'
import { cleanup, editorPage, launch, logged, pageAt, records, repo, temp, tick, until, workersPage } from './helpers.ts'

// The door's proof: the shipped http in its utility process on 127.0.0.1:4747, with a fake mcp in the test install
// only. The shipped token seam refuses every token, so a request that passes the token check runs in the join test

const holders: net.Server[] = []

afterEach(async () => {
  await cleanup()
  for (const holder of holders.splice(0)) await new Promise(resolve => holder.close(resolve))
})

const PORT = 4747
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

// The shipped install, with the fake mcp beside it when asked
async function install(withMcp: boolean): Promise<string> {
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
  await writeFile(path.join(dir, INSTALL_LIST), `${JSON.stringify(list, null, 2)}\n`)
  return dir
}

// A data folder with a folder plugin that holds plugin.call on mcp
async function data(): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  const root = path.join(dataDir, 'plugins', 'caller')
  const granted = [{ type: 'plugin.call' as const, targets: ['mcp'] }]
  await writeFolder(root, filesFor(workerManifest('caller', { capabilities: granted }), { 'worker.js': await builtWorker(caller) }))
  await store.writePlugin('caller', await entryFor(root, { granted }))
  return dataDir
}

async function started(withMcp: boolean): Promise<{ app: ElectronApplication, editor: Page, dataDir: string }> {
  const dataDir = await data()
  const app = await launch(dataDir, { HETU_INSTALL_DIR: await install(withMcp) })
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'caller' }))
  return { app, editor, dataDir }
}

const canConnect = () => new Promise<boolean>(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port: PORT })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})

// One request written as it is on its own connection, answered with the status line's code
function status(lines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT })
    let raw = ''
    socket.on('data', chunk => { raw += chunk.toString('latin1') })
    socket.on('error', reject)
    socket.on('close', () => resolve(Number(raw.split(' ')[1])))
    socket.once('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n{}`))
  })
}
const post = (extra: string[]) => status(['POST /mcp HTTP/1.1', ...extra, 'Content-Type: application/json', 'Content-Length: 2', 'Connection: close'])

// A call from the editor through the shell's bridge
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    if ((message as { id?: unknown }).id === id) resolve(message)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [9000 + Math.floor(Math.random() * 1000), action, args] as const) as Promise<{ ok: boolean, result?: unknown }>

const utilityFolders = async () => (await readdir(tmpdir())).filter(name => name.startsWith('hetu-utility-'))

describe('the door', () => {
  it('stays closed with no mcp in the install, http reading ready', async () => {
    expect(await canConnect()).toBe(false)
    const { dataDir } = await started(false)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'http' }))
    await tick(500)
    expect(await canConnect()).toBe(false)
    expect(await logged(dataDir, 'plugin.failed', { plugin: 'http' })).toBe(false)
  })

  it('refuses another Host and an Origin with 403, reaching nothing, each reason in one http.refused with its count', async () => {
    expect(await canConnect()).toBe(false)
    const { dataDir } = await started(true)
    await until(() => canConnect())
    expect(await post(['Host: evil.example', 'Authorization: Bearer any'])).toBe(403)
    expect(await post(['Host: localhost:4747', 'Authorization: Bearer any'])).toBe(403)
    expect(await post(['Host: 127.0.0.1:4747', 'Origin: https://evil.example', 'Authorization: Bearer any'])).toBe(403)
    // The shipped seam refuses every token
    expect(await post(['Host: 127.0.0.1:4747', 'Authorization: Bearer any'])).toBe(401)
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

  it('reads failed (port-taken) in the trusted window while another program holds 127.0.0.1:4747 and comes up on Restart once it is free', async () => {
    expect(await canConnect()).toBe(false)
    const holder = net.createServer(socket => socket.destroy())
    holders.push(holder)
    await new Promise<void>(resolve => holder.listen({ host: '127.0.0.1', port: PORT, exclusive: true }, resolve))
    const { app, editor, dataDir } = await started(true)
    await until(() => logged(dataDir, 'plugin.failed', { plugin: 'http', reason: 'port-taken' }))
    expect((await ask(editor, 'security.open')).ok).toBe(true)
    const trusted = await pageAt(app, 'hetu://trusted/')
    const row = trusted.locator('div.plugin', { hasText: 'http · ships with hetu' })
    await until(async () => (await row.locator('p').first().textContent()) === 'http · ships with hetu · utility · failed (port-taken)')
    await new Promise<void>(resolve => holder.close(() => resolve()))
    holders.splice(holders.indexOf(holder), 1)
    expect(await canConnect()).toBe(false)
    // Past the trusted window's input delay, inside which a click counts for nothing
    await tick(2000)
    await row.getByRole('button', { name: 'Restart', exact: true }).click()
    await until(() => canConnect())
    expect(await post(['Host: 127.0.0.1:4747', 'Authorization: Bearer any'])).toBe(401)
    await until(async () => (await row.locator('p').first().textContent()) === 'http · ships with hetu · utility · ready')
  })

  it('leaves no utility working folder and the port free after a clean quit', async () => {
    expect(await canConnect()).toBe(false)
    const before = await utilityFolders()
    const { app } = await started(true)
    await until(() => canConnect())
    expect((await utilityFolders()).length).toBeGreaterThan(before.length)
    await app.close()
    await until(async () => !(await canConnect()))
    await until(async () => (await utilityFolders()).filter(name => !before.includes(name)).length === 0)
  })
})
