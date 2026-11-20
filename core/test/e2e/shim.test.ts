import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { cp, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { userInfo } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_LIST } from '../../api/install.ts'
import { pipeName } from '../../api/pipe.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { hashFiles, readFiles } from '../../lib/hash-files.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder } from '../plugins-manager-fakes.ts'
import { appCommand, cleanup, editorPage, env, launch, logged, pageAt, repo, sandboxArgs, temp, tick, until, visibleWindows } from './helpers.ts'

// The shim's proof: hetu.exe --mcp-stdio twice against a running hetu with the shipped http and a fake mcp in the
// test install only. The first claude-code session waits for one Confirm in the trusted window, the second joins with
// none, each reaching mcp.handle on behalf of a label of its own. The pipe is the user's own, so nothing may answer on
// it before the test's hetu does

const shims: ChildProcessWithoutNullStreams[] = []

afterEach(async () => {
  for (const shim of shims.splice(0)) shim.kill()
  await cleanup()
})

const PIPE = pipeName(process.platform, userInfo().username)
// The trusted window's input delay and a little more, so a click after it lands
const PAST_DELAY = 1300
const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// A first-party id, so it ships in this install as a first-party copy. Its handle answers a request with its id and
// the label it was called on behalf of, and a notification with nothing
const mcp = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    ctx.provide('handle', (call, args) => {
      const { id } = JSON.parse(args.body)
      if (id === undefined) return { status: 202, body: null }
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: { onBehalf: call.onBehalf ?? null } }) }
    })
  },
})
`

// The shipped install with the fake mcp beside it
async function install(): Promise<string> {
  const dir = await temp()
  const dist = path.join(repo, 'core', 'dist')
  await cp(path.join(dist, 'plugins'), path.join(dir, 'plugins'), { recursive: true })
  const list = JSON.parse(await readFile(path.join(dist, INSTALL_LIST), 'utf8')) as { format: number, plugins: Record<string, unknown> }
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': mcp })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const root = path.join(dir, 'plugins', 'mcp')
  await writeFolder(root, filesFor(workerManifest('mcp', { provides: { actions: { handle: { from: ['mcp-http-handler'] } } } }), { 'worker.js': built!.text }))
  list.plugins.mcp = { path: 'plugins/mcp', version: '1.0.0', hash: hashFiles(await readFiles(root)), firstParty: true }
  await writeFile(path.join(dir, INSTALL_LIST), `${JSON.stringify(list, null, 2)}\n`)
  return dir
}

const pipeAnswers = () => new Promise<boolean>(resolve => {
  const socket = net.connect(PIPE)
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})

type Shim = { lines: () => unknown[], send: (message: unknown) => void, end: () => void, exit: Promise<number | null> }

// hetu --mcp-stdio as an MCP client starts it, on the test's data folder, each stdout line read as JSON
function shim(dataDir: string, installDir: string): Shim {
  const [command, args] = appCommand
  const child = spawn(command, [...sandboxArgs, ...args, '--mcp-stdio'], {
    env: env({ HETU_DATA_DIR: dataDir, HETU_INSTALL_DIR: installDir }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  shims.push(child)
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
  child.stderr.resume()
  const exit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  return {
    lines: () => out.split('\n').slice(0, -1).map(line => JSON.parse(line) as unknown),
    send: message => child.stdin.write(`${JSON.stringify(message)}\n`),
    end: () => child.stdin.end(),
    exit,
  }
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } } }
const label = (line: unknown) => (line as { result: { onBehalf: string } }).result.onBehalf

describe('hetu --mcp-stdio', () => {
  it('relays two claude-code sessions to mcp.handle, each on a label of its own, after one Confirm', async () => {
    expect(await pipeAnswers()).toBe(false)
    const dataDir = await temp()
    await new StateStore(dataDir).writeSwitches(defaultSwitches())
    const installDir = await install()
    const app = await launch(dataDir, { HETU_INSTALL_DIR: installDir })
    const editor = await editorPage(app)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'mcp' }))
    await until(() => pipeAnswers())

    const first = shim(dataDir, installDir)
    first.send(initialize)
    const notice = editor.getByRole('button', { name: 'A security change is waiting: consent.ask "mcp-http-handler"' })
    await notice.waitFor()
    await tick(PAST_DELAY)
    await notice.click()
    const trusted = await pageAt(app, 'hetu://trusted/')
    await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
    const heading = trusted.locator('section.request h1')
    await until(async () => (await heading.innerText()).startsWith('Connect the client "claude-code"'))
    expect(await heading.innerText()).toMatch(/^Connect the client "claude-code" with no name, a program on this computer reaching hetu over the local pipe, through mcp-http-handler as "claude-code#[1-9]\d*"$/)
    await tick(PAST_DELAY)
    await trusted.getByRole('button', { name: 'Confirm' }).click()

    await until(() => first.lines().length === 1, 20_000)
    const one = label(first.lines()[0])
    expect(one).toMatch(/^claude-code#[1-9]\d*$/)
    expect(first.lines()[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { onBehalf: one } })
    // A notification gets nothing back and the connection keeps serving
    first.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    first.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await until(() => first.lines().length === 2)
    expect(first.lines()[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { onBehalf: one } })

    // The second session of a client confirmed in this run joins with no connect of its own
    const second = shim(dataDir, installDir)
    second.send(initialize)
    await until(() => second.lines().length === 1, 20_000)
    const two = label(second.lines()[0])
    expect(two).toMatch(/^claude-code#[1-9]\d*$/)
    expect(two).not.toBe(one)
    expect(await notice.count()).toBe(0)

    // stdin's end closes each shim once its answers came back
    first.end()
    second.end()
    expect(await first.exit).toBe(0)
    expect(await second.exit).toBe(0)
  })
})
