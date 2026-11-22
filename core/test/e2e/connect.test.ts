import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildHost, buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeDoor, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, launch, logged, pageAt, temp, tick, until, visibleWindows, workersPage } from './helpers.ts'

// A client's connect in the built app: a fake http in its utility process asks the core for the connect and collects
// the answer, which a folder plugin's worker drives. The trusted window draws the request in the core's words

afterEach(cleanup)

// The input delay and a little more, so a click after it lands
const PAST_DELAY = 1300
const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// The fake http: connect asks the core for a connect and collect asks for the answer to a handle, each giving back the
// result or the refusal's code. A short deadline, since the SDK tries a throttled call again until its deadline
const http = `
import { definePlugin } from '${sdk}'
const settled = work => work.then(result => ({ result }), err => ({ refused: err.code ?? String(err) }))
export default definePlugin({
  start(ctx) {
    ctx.provide('connect', (_call, args) => settled(ctx.call('core', 'consentAsk', args, { timeoutMs: 500 })))
    ctx.provide('collect', (_call, args) => settled(ctx.call('core', 'consentAnswer', args, { timeoutMs: 500 })))
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

// An install folder holding the fake http as the door in place of the shipped one
async function install(): Promise<string> {
  const dir = await temp()
  const source = await temp()
  await writeFolder(source, { 'src/host.ts': http })
  const built = await buildHost(source, 'src/host.ts', [])
  await writeDoor(dir, built.text)
  return dir
}

// A data folder with the caller approved to call http
async function data(): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': caller })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const root = path.join(dataDir, 'plugins', 'caller')
  const granted = [{ type: 'plugin.call' as const, targets: ['mcp-http-handler'] }]
  await writeFolder(root, filesFor(workerManifest('caller', { requires: ['mcp-http-handler'], capabilities: granted }), { 'worker.js': built!.text }))
  await writeApproved(store, 'caller', root, { granted })
  return dataDir
}

type Settled = { result?: unknown, refused?: string }

async function started(): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, worker: Worker }> {
  const dataDir = await data()
  const app = await launch(dataDir, { HETU_INSTALL_DIR: await install() })
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'caller' }))
  const page = await workersPage(app, 'caller')
  await until(() => page.workers().length === 1)
  return { app, editor, dataDir, worker: page.workers()[0] as Worker }
}

const CLAUDE = 'https://claude.ai/oauth/claude-code-client-metadata'
const asked = (number: number, client = CLAUDE) => ({ client, name: 'Claude Code', redirect: 'http://localhost:33418/callback', field: `${client}#${number}` })
const through = (worker: Worker, action: string, args: unknown) =>
  worker.evaluate(([action, args]) => (globalThis as unknown as { ctx: { call(t: string, a: string, x: unknown): Promise<unknown> } }).ctx.call('mcp-http-handler', action, args), [action, args] as const) as Promise<Settled>
const connect = async (worker: Worker, args: unknown) => through(worker, 'connect', args)
const collect = async (worker: Worker, handle: string) => (await through(worker, 'collect', { handle })).result

async function trustedPage(app: ElectronApplication, editor: Page): Promise<Page> {
  const notice = editor.getByRole('button', { name: 'A security change is waiting: consent.ask "mcp-http-handler"' })
  await notice.waitFor()
  await tick(PAST_DELAY)
  await notice.click()
  const page = await pageAt(app, 'hetu://trusted/')
  await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
  return page
}

type Reply = { ok: boolean, result?: unknown, refusal?: { code: string } }
let next = 5000

// A call through a page's bridge, as its own code makes one
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    const reply = message as { kind?: string, id?: number }
    if (reply.kind === 'reply' && reply.id === id) resolve(reply)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [next++, action, args] as const) as Promise<Reply>

describe('a connect in the trusted window', () => {
  it('shows the host first, the name and the label in quotes, takes no Confirm inside the delay and hands the yes once', async () => {
    const { app, editor, dataDir, worker } = await started()
    const raised = await connect(worker, asked(3))
    const { handle } = raised.result as { handle: string }
    expect(handle).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(await collect(worker, handle)).toEqual({ answer: 'waiting' })
    // A second while one waits is refused, whoever it is for
    expect(await connect(worker, asked(1, 'other-client'))).toEqual({ refused: 'throttled' })

    const page = await trustedPage(app, editor)
    const heading = page.locator('section.request h1')
    await until(async () => (await heading.innerText()).startsWith('Connect the client from "claude.ai"'))
    expect(await heading.innerText()).toBe(`Connect the client from "claude.ai" named "Claude Code", which returns to "localhost:33418", through mcp-http-handler as "${CLAUDE}#3"`)
    expect(await heading.locator('span.label').innerText()).toBe(`"${CLAUDE}#3"`)
    expect(await page.locator('section.request li').allInnerTexts()).toEqual([
      'Any program on this computer can connect under that client id and that name, so confirm only a connect you started just now',
      'It reaches no note yet. It asks for items later and each ask waits for your Confirm',
    ])
    expect(await page.locator('section.request').getByRole('button').allInnerTexts()).toEqual(['Confirm', 'Cancel'])

    // Inside the delay the page's Confirm is disabled and the core refuses one sent anyway
    const confirm = page.getByRole('button', { name: 'Confirm' })
    expect(await confirm.isDisabled()).toBe(true)
    const id = ((await ask(editor, 'core.status')).result as { pending: { id: string }[] }).pending[0]!.id
    expect((await ask(page, 'security.confirm', { requestId: id })).refusal?.code).toBe('throttled')
    expect(await collect(worker, handle)).toEqual({ answer: 'waiting' })

    await tick(PAST_DELAY)
    await confirm.click()
    await until(() => logged(dataDir, 'security.applied', { kind: 'consent.ask', target: 'mcp-http-handler', field: `${CLAUDE}#3`, by: 'confirm' }))
    expect(await collect(worker, handle)).toEqual({ answer: 'yes' })
    expect(await collect(worker, handle)).toEqual({ answer: 'gone' })
  })

  it('hands a Cancel as no once, then a connect waiting when http restarts is gone and can\'t be confirmed', async () => {
    const { app, editor, worker } = await started()
    const first = ((await connect(worker, asked(4))).result as { handle: string }).handle
    const page = await trustedPage(app, editor)
    await until(async () => (await page.locator('section.request h1').innerText()).includes('#4"'))
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await page.locator('section.request').count()) === 0)
    expect(await collect(worker, first)).toEqual({ answer: 'no' })
    expect(await collect(worker, first)).toEqual({ answer: 'gone' })
    // The same client id waits a minute after a Cancel, another is taken
    expect(await connect(worker, asked(5))).toEqual({ refused: 'throttled' })
    const second = ((await connect(worker, asked(1, 'other-client'))).result as { handle: string }).handle
    const id = ((await ask(editor, 'core.status')).result as { pending: { id: string }[] }).pending[0]!.id
    // Drawn in a window open past its own delay, the new request's Confirm waits the delay again
    await until(async () => (await page.locator('section.request h1').innerText().catch(() => '')).includes('"other-client#1"'))
    expect(await page.getByRole('button', { name: 'Confirm' }).isDisabled()).toBe(true)

    // The human restarts http from the trusted window: the waiting connect is withdrawn with it
    expect((await ask(page, 'core.restart', { plugin: 'mcp-http-handler' })).ok).toBe(true)
    await until(async () => ((await ask(editor, 'core.status')).result as { pending: unknown[] }).pending.length === 0)
    await tick(PAST_DELAY)
    expect((await ask(page, 'security.confirm', { requestId: id })).refusal?.code).toBe('not-found')
    // The caller needs http, so it starts again with it, then asks the new http about the old handle
    const workers = await workersPage(app, 'caller')
    const again: { worker: Worker | null } = { worker: null }
    await until(async () => {
      again.worker = workers.workers().find(one => one !== worker) ?? null
      if (again.worker === null) return false
      return ((await through(again.worker, 'collect', { handle: second }).catch(() => ({}))) as Settled).result !== undefined
    }, 20_000)
    expect(await collect(again.worker!, second)).toEqual({ answer: 'gone' })
  })
})
