import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { command, fakeDoor, handleRefusals, installDoor, outcome, reports, startedWith, writeHolder } from './door-driver.ts'
import { cleanup, logged, pageAt, temp, tick, until, visibleWindows, setUp } from './helpers.ts'

// A client's connect in the built app: a fake door in its utility process asks the core for the connect and collects
// the answer, each on a command a folder plugin holding door.handle hands it. The trusted window draws the request in
// the core's words

afterEach(cleanup)

// The input delay and a little more, so a click after it lands
const PAST_DELAY = 1300

// The fake door's commands: connect asks the core for a connect and collect asks for the answer to a handle. A short
// deadline, since the SDK tries a throttled call again until its deadline
const commands = `{
  connect: (ctx, args) => ctx.call('core', 'consentAsk', args, { timeoutMs: 500 }),
  collect: (ctx, args) => ctx.call('core', 'consentAnswer', args, { timeoutMs: 500 }),
}`

// A data folder with the holder approved
async function data(): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await writeHolder(store, dataDir)
  await setUp(dataDir)
  return dataDir
}

const started = async () => startedWith(await data(), await installDoor(fakeDoor(commands)))

const CLAUDE = 'https://claude.ai/oauth/claude-code-client-metadata'
const asked = (number: number, client = CLAUDE) => ({ client, name: 'Claude Code', redirect: 'http://localhost:33418/callback', field: `${client}#${number}` })
const connect = async (worker: Worker, args: unknown) => outcome(await command(worker, 'connect', args))
const collect = async (worker: Worker, handle: string) => (await command(worker, 'collect', { handle })).result

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
    expect(await handleRefusals(worker)).toEqual([])
  })

  it('hands a Cancel as no once, then a connect waiting when the door restarts is gone and can\'t be confirmed', async () => {
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

    // The human restarts the door from the trusted window: the waiting connect is withdrawn with it
    expect((await ask(page, 'core.restart', { plugin: 'mcp-http-handler' })).ok).toBe(true)
    await until(async () => ((await ask(editor, 'core.status')).result as { pending: unknown[] }).pending.length === 0)
    await tick(PAST_DELAY)
    expect((await ask(page, 'security.confirm', { requestId: id })).refusal?.code).toBe('not-found')
    // The door started again reaches the holder as its second incarnation, which asks about the old handle
    await until(async () => (await reports(worker)).some(report => report.incarnation === 2), 20_000)
    const after = await command(worker, 'collect', { handle: second })
    expect(after.incarnation).toBe(2)
    expect(after.result).toEqual({ answer: 'gone' })
  })
})
