import { copyFile, readdir } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { DOOR_FILE } from '../../backend/plugins-manager/verify.ts'
import { hashFiles, readFiles } from '../../lib/hash-files.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, launch, logged, pageAt, records, repo, temp, tick, until, workersPage } from './helpers.ts'

// The door's proof: the shipped http in its utility process on 127.0.0.1:4747, with a fake mcp in the plugin folder.
// The shipped token seam refuses every token, so a request that passes the token check runs in the join test

const holders: net.Server[] = []

afterEach(async () => {
  await cleanup()
  for (const holder of holders.splice(0)) await new Promise(resolve => holder.close(resolve))
})

const PORT = 4747
const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// A plugin-folder plugin hetu doesn't ship, approved unsigned by its hash, holding door.handle. It serves the role and
// echoes who called it
const mcp = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    ctx.provide('door.handle', call => ({ status: 200, body: JSON.stringify({ caller: call.caller, onBehalf: call.onBehalf ?? null }) }))
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

// An install folder holding the door as built, which holds no mcp
async function install(): Promise<string> {
  const dir = await temp()
  await copyFile(path.join(repo, 'core', 'dist', DOOR_FILE), path.join(dir, DOOR_FILE))
  return dir
}

// How the fake mcp sits in the plugin folder: approved unsigned by its hash, unsigned with no allowUnsigned naming its
// hash, or not there
type Mcp = 'approved' | 'unsigned' | 'none'

const role = { type: 'door.handle' as const }

// A data folder with a folder plugin that holds plugin.call on mcp and the fake mcp beside it as asked
async function data(mcpAs: Mcp): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  const root = path.join(dataDir, 'plugins', 'caller')
  const granted = [{ type: 'plugin.call' as const, targets: ['mcp'] }]
  await writeFolder(root, filesFor(workerManifest('caller', { capabilities: granted }), { 'worker.js': await builtWorker(caller) }))
  await store.writePlugin('caller', await entryFor(root, { granted }))
  const allowUnsigned: string[] = [hashFiles(await readFiles(root))]
  if (mcpAs !== 'none') {
    const mcpRoot = path.join(dataDir, 'plugins', 'mcp')
    await writeFolder(mcpRoot, filesFor(workerManifest('mcp', { capabilities: [role] }), { 'worker.js': await builtWorker(mcp) }))
    if (mcpAs === 'approved') allowUnsigned.push(hashFiles(await readFiles(mcpRoot)))
    await store.writePlugin('mcp', await entryFor(mcpRoot, { granted: [role] }))
  }
  await store.writeSwitches({ ...defaultSwitches(), allowUnsigned })
  return dataDir
}

async function started(mcpAs: Mcp): Promise<{ app: ElectronApplication, editor: Page, dataDir: string }> {
  const dataDir = await data(mcpAs)
  const app = await launch(dataDir, { HETU_INSTALL_DIR: await install() })
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
  it('stays closed with no mcp in the plugin folder, http reading ready', async () => {
    expect(await canConnect()).toBe(false)
    const { dataDir } = await started('none')
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'mcp-http-handler' }))
    await tick(500)
    expect(await canConnect()).toBe(false)
    expect(await logged(dataDir, 'plugin.failed', { plugin: 'mcp-http-handler' })).toBe(false)
  })

  it('stays closed while the folder mcp is refused unsigned, no allowUnsigned naming its hash', async () => {
    expect(await canConnect()).toBe(false)
    const { dataDir } = await started('unsigned')
    await until(() => logged(dataDir, 'plugin.refused', { plugin: 'mcp', reason: 'unsigned' }))
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'mcp-http-handler' }))
    await tick(500)
    expect(await canConnect()).toBe(false)
    expect(await logged(dataDir, 'plugin.started', { plugin: 'mcp' })).toBe(false)
  })

  it('opens once the folder mcp approved unsigned by its hash is up and answers a bad token 401', async () => {
    expect(await canConnect()).toBe(false)
    const { dataDir } = await started('approved')
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'mcp' }))
    await until(() => canConnect())
    expect(await post(['Host: 127.0.0.1:4747', 'Authorization: Bearer any'])).toBe(401)
  })

  it('refuses another Host and an Origin with 403, reaching nothing, each reason in one mcp-http-handler.refused with its count', async () => {
    expect(await canConnect()).toBe(false)
    const { dataDir } = await started('approved')
    await until(() => canConnect())
    expect(await post(['Host: evil.example', 'Authorization: Bearer any'])).toBe(403)
    expect(await post(['Host: localhost:4747', 'Authorization: Bearer any'])).toBe(403)
    expect(await post(['Host: 127.0.0.1:4747', 'Origin: https://evil.example', 'Authorization: Bearer any'])).toBe(403)
    // The shipped seam refuses every token
    expect(await post(['Host: 127.0.0.1:4747', 'Authorization: Bearer any'])).toBe(401)
    await until(async () => (await records(dataDir)).filter(record => record.event === 'mcp-http-handler.refused').length === 3)
    await tick(1500)
    const refused = (await records(dataDir)).filter(record => record.event === 'mcp-http-handler.refused')
    expect(refused.map(record => [record.reason, record.count]).sort()).toEqual([['host', 2], ['origin', 1], ['token', 1]])
    expect((await records(dataDir)).filter(record => record.event === 'audit.call' && record.action === 'door.handle')).toEqual([])
  })

  it('refuses another plugin\'s worker that holds plugin.call on mcp at door.handle and finds no mcp.handle', async () => {
    const { app, dataDir } = await started('approved')
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'mcp' }))
    const page = await workersPage(app, 'caller')
    await until(() => page.workers().length === 1)
    const worker = page.workers()[0] as Worker
    const ask = (target: string) => worker.evaluate(`globalThis.ctx.call('${target}', 'handle', { body: '{}', headers: {} }, { onBehalf: 'claude-code#1' }).then(value => ({ value }), error => ({ refused: error.code }))`)
    expect(await ask('door')).toEqual({ refused: 'not-granted' })
    expect(await ask('mcp')).toEqual({ refused: 'not-found' })
  })

  it('reads failed (port-taken) in the trusted window while another program holds 127.0.0.1:4747 and comes up on Restart once it is free', async () => {
    expect(await canConnect()).toBe(false)
    const holder = net.createServer(socket => socket.destroy())
    holders.push(holder)
    await new Promise<void>(resolve => holder.listen({ host: '127.0.0.1', port: PORT, exclusive: true }, resolve))
    const { app, editor, dataDir } = await started('approved')
    await until(() => logged(dataDir, 'plugin.failed', { plugin: 'mcp-http-handler', reason: 'port-taken' }))
    expect((await ask(editor, 'app.openSecurity')).ok).toBe(true)
    const trusted = await pageAt(app, 'hetu://trusted/')
    const row = trusted.locator('div.plugin', { hasText: 'mcp-http-handler · ships with hetu' })
    await until(async () => (await row.locator('p').first().textContent()) === 'mcp-http-handler · ships with hetu · utility · failed (port-taken)')
    await new Promise<void>(resolve => holder.close(() => resolve()))
    holders.splice(holders.indexOf(holder), 1)
    expect(await canConnect()).toBe(false)
    // Past the trusted window's input delay, inside which a click counts for nothing
    await tick(2000)
    await row.getByRole('button', { name: 'Restart', exact: true }).click()
    await until(() => canConnect())
    expect(await post(['Host: 127.0.0.1:4747', 'Authorization: Bearer any'])).toBe(401)
    await until(async () => (await row.locator('p').first().textContent()) === 'mcp-http-handler · ships with hetu · utility · ready')
  })

  it('leaves no utility working folder and the port free after a clean quit', async () => {
    expect(await canConnect()).toBe(false)
    const before = await utilityFolders()
    const { app } = await started('approved')
    await until(() => canConnect())
    expect((await utilityFolders()).length).toBeGreaterThan(before.length)
    await app.close()
    await until(async () => !(await canConnect()))
    await until(async () => (await utilityFolders()).filter(name => !before.includes(name)).length === 0)
  })
})
