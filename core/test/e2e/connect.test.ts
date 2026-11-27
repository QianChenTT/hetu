import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { INPUT_DELAY_MS } from '../../api/trusted.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { command, fakeDoor, handleRefusals, installDoor, outcome, reports, startedWith, writeHolder } from './door-driver.ts'
import { cleanup, logged, pageAt, temp, tick, until, visibleWindows, setUp } from './helpers.ts'
import { ask } from '../drive.ts'

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

// The trusted page, with the test's clock just before the click that showed it. main's input delay starts at the show,
// so no later than that
async function trustedPage(app: ElectronApplication, editor: Page): Promise<{ page: Page, clicked: number }> {
  const notice = editor.getByRole('button', { name: 'A security change is waiting: consent.ask "mcp-http-handler"' })
  await notice.waitFor()
  await tick(PAST_DELAY)
  const clicked = Date.now()
  await notice.click()
  const page = await pageAt(app, 'hetu://trusted/')
  await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
  return { page, clicked }
}

type Marks = { shown?: number, enabled?: number }

// Put in the trusted page before its own code runs: when a request's heading first showed and when its Confirm first
// turned enabled after, each by the page's clock, so a slow machine can't make the check of the delay miss it
function markConfirm(): void {
  if (!location.href.startsWith('hetu://trusted/')) return
  const marks: Marks = {}
  ;(window as unknown as { confirmMarks: Marks }).confirmMarks = marks
  new MutationObserver(() => {
    const request = document.querySelector('section.request')
    if (request === null || request.querySelector('h1') === null) return
    marks.shown ??= performance.now()
    const confirm = [...request.querySelectorAll('button')].find(button => button.textContent === 'Confirm')
    if (marks.enabled === undefined && confirm !== undefined && !confirm.disabled) marks.enabled = performance.now()
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] })
}

const marksOf = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { confirmMarks: Marks }).confirmMarks }))

describe('a connect in the trusted window', () => {
  it('shows the host first, the name and the label in quotes, takes no Confirm inside the delay and hands the yes once', async () => {
    const { app, editor, dataDir, worker } = await started()
    const raised = await connect(worker, asked(3))
    const { handle } = raised.result as { handle: string }
    expect(handle).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(await collect(worker, handle)).toEqual({ answer: 'waiting' })
    // A second while one waits is refused, whoever it is for
    expect(await connect(worker, asked(1, 'other-client'))).toEqual({ refused: 'throttled' })

    await app.context().addInitScript(markConfirm)
    const { page, clicked } = await trustedPage(app, editor)
    const heading = page.locator('section.request h1')
    await until(async () => (await heading.innerText()).startsWith('Connect the client from "claude.ai"'))
    expect(await heading.innerText()).toBe(`Connect the client from "claude.ai" named "Claude Code", which returns to "localhost:33418", through mcp-http-handler as "${CLAUDE}#3"`)
    expect(await heading.locator('span.label').innerText()).toBe(`"${CLAUDE}#3"`)
    expect(await page.locator('section.request li').allInnerTexts()).toEqual([
      'Any program on this computer can connect under that client id and that name, so confirm only a connect you started just now',
      'It reaches no note yet. It asks for items later and each ask waits for your Confirm',
    ])
    expect(await page.locator('section.request').getByRole('button').allInnerTexts()).toEqual(['Confirm', 'Cancel'])

    // Inside the delay the core refuses a Confirm sent anyway. Sent only while the test's clock is in the first half of
    // the delay since the click, the rest left for the call to reach main. A slower machine skips it, the delay checked
    // by the marks below
    const id = ((await ask(editor, 'core.status')).result as { pending: { id: string }[] }).pending[0]!.id
    if (Date.now() - clicked < INPUT_DELAY_MS / 2) {
      expect((await ask(page, 'security.confirm', { requestId: id })).refusal?.code).toBe('throttled')
      expect(await collect(worker, handle)).toEqual({ answer: 'waiting' })
    }

    // The page's Confirm turned enabled no sooner than the delay after the request showed
    const confirm = page.getByRole('button', { name: 'Confirm' })
    await until(async () => (await marksOf(page)).enabled !== undefined)
    const marks = await marksOf(page)
    expect(marks.enabled! - marks.shown!).toBeGreaterThanOrEqual(INPUT_DELAY_MS)

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
    const { page } = await trustedPage(app, editor)
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
