import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker as PageWorker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { INPUT_DELAY_MS } from '../../api/trusted.ts'
import { defaultSwitches, StateStore, type Plugin, type Switches } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, hashOf, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { makeZip } from '../zip-maker.ts'
import { cleanup, editorPage, exited, launch, logged, pageAt, records, temp, tick, until, visibleWindows, workersPage } from './helpers.ts'
import { ask, stubPicker } from '../drive.ts'

afterEach(cleanup)

// The input delay and a little more, so a click after it lands
const PAST_DELAY = 1300

// An empty install folder, so no door runs and the door reads as missing. The gate and the other core modules ship
// inside the core
const install = temp

// A worker speaking the lifecycle as text on the port its page hands it. after runs once it is ready
const lifecycle = (after = '') => `
self.onmessage = event => {
  const port = event.ports[0]
  self.onmessage = null
  const send = message => port.postMessage(JSON.stringify(message))
  port.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.kind === 'init') {
      send({ v: 1, kind: 'ready' })
      ${after}
    }
    else if (message.kind === 'ping') send({ v: 1, kind: 'pong' })
    else if (message.kind === 'stop') send({ v: 1, kind: 'stopped' })
  }
}
`

type Worker = { code: string, manifest?: object, entry?: Partial<Plugin> }

// An approved plugin holding nothing that never draws, which ends the startup flow, so the trusted window opens only
// when asked. startup leaves it out
const quiet: Worker = { code: lifecycle(), manifest: { capabilities: [] }, entry: { granted: [] } }

async function data(options: { switches?: Partial<Switches>, workers?: Record<string, Worker>, before?: (dataDir: string) => Promise<void>, startup?: boolean } = {}): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), ...options.switches })
  const workers = { ...(options.startup === true ? {} : { quiet }), ...options.workers }
  for (const [id, worker] of Object.entries(workers)) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, worker.manifest ?? {}), { 'worker.js': worker.code }))
    await writeApproved(store, id, root, worker.entry ?? {})
  }
  await options.before?.(dataDir)
  return dataDir
}

// hetu from the source, never starting itself again, so a test starts each next run
const start = async (dataDir: string, installDir: string) => launch(dataDir, { HETU_INSTALL_DIR: installDir, HETU_NO_RELAUNCH: '1' })

async function trustedPage(app: ElectronApplication): Promise<Page> {
  const page = await pageAt(app, 'hetu://trusted/')
  await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
  return page
}

const text = (page: Page) => page.locator('#root').innerText()
const showing = (page: Page, line: string) => until(async () => (await text(page)).includes(line))
// One tab drawn at a time, Plugins first
const tabTo = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click()

// The core's log is the one security control left whose failure stops hetu. Its folder swapped for a file makes every
// write fail. logFailMs lowered makes it count as failed soon
describe('the core\'s log failing while hetu runs', () => {
  const folder = (dataDir: string) => path.join(dataDir, 'events')
  // Windows refuses to rename a folder while a file in it is open, which the log's own append or a scanner holds for
  // a moment, so a refused rename is tried again for up to 10 s
  async function moved(from: string, to: string): Promise<void> {
    for (let tries = 0; ; tries++) {
      try {
        return await rename(from, to)
      } catch (err) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '') || tries >= 50) throw err
        await tick(200)
      }
    }
  }
  async function breakLog(dataDir: string): Promise<void> {
    await moved(folder(dataDir), `${folder(dataDir)}-away`)
    await writeFile(folder(dataDir), '')
  }
  async function mendLog(dataDir: string): Promise<void> {
    await rm(folder(dataDir), { force: true, maxRetries: 5, retryDelay: 100 })
    await moved(`${folder(dataDir)}-away`, folder(dataDir))
  }
  const readied = async (dataDir: string) => (await records(dataDir)).filter(record => record.event === 'core.ready').length

  it('quits with an error to start again, then stops in the stopped mode when it fails in the next run', async () => {
    const dataDir = await data({ switches: { limits: { all: { logFailMs: 1000 }, plugins: {} } } })
    const installDir = await install()
    const app = await start(dataDir, installDir)
    const editor = await editorPage(app)
    await until(async () => await readied(dataDir) === 1)
    const done = exited(app)
    await breakLog(dataDir)
    // An applied change writes a record that can't land
    await ask(editor, 'security.request', { change: { kind: 'confirmOff', on: false } })
    expect(await done).toBe(1)
    expect(await readFile(path.join(dataDir, 'failed-once'), 'utf8')).toBe('log')
    await mendLog(dataDir)

    const again = await start(dataDir, installDir)
    const second = await editorPage(again)
    await until(async () => await readied(dataDir) === 2)
    await breakLog(dataDir)
    await ask(second, 'security.request', { change: { kind: 'confirmOff', on: false } })
    const page = await trustedPage(again)
    await showing(page, 'hetu already started again once after a failure')
    await until(async () => (await visibleWindows(again)).length === 1)
  })

  // Restart hetu goes the way Try again goes, through app.relaunch
  it('keeps the restart marker through Restart hetu and clears it on a clean Quit', async () => {
    const dataDir = await data({ before: async dir => writeFile(path.join(dir, 'failed-once'), 'log') })
    const installDir = await install()
    for (const [button, kept] of [['Restart hetu', true], ['Quit', false]] as const) {
      const app = await start(dataDir, installDir)
      const editor = await editorPage(app)
      await tick(PAST_DELAY)
      await editor.getByRole('button', { name: 'Plugins and security' }).click()
      const page = await trustedPage(app)
      await tick(PAST_DELAY)
      const done = exited(app)
      await page.getByRole('button', { name: button, exact: true }).click()
      expect(await done).toBe(0)
      expect(await readFile(path.join(dataDir, 'failed-once'), 'utf8').then(() => true, () => false), button).toBe(kept)
    }
  })
})

type NoticeTimes = { timeOrigin: number, shown?: number, clicked?: number }

// Room for a time to trail the moment it records and for the clocks of two processes to differ
const CLOCK_SLACK_MS = 50

// Put in the editor page before its own code runs, or through evaluate when that came too late: when the notice named
// first showed and when the first click on it landed, each by the page's clock the shell times notices by, with the
// page's time origin to turn them into epoch ms. The click is recorded as it bubbles up to the window, after the
// notice's own handler read the clock. Put in once the notice already showed, shown stays unset
function recordNoticeTimes(name: string): void {
  if (!location.href.startsWith('hetu://editor/')) return
  const holder = window as unknown as { noticeTimes?: NoticeTimes }
  if (holder.noticeTimes !== undefined) return
  const times: NoticeTimes = { timeOrigin: performance.timeOrigin }
  holder.noticeTimes = times
  const isNotice = (node: unknown) => node instanceof HTMLButtonElement && node.textContent === name
  const noticeShowing = () => [...document.querySelectorAll('button')].some(isNotice)
  const alreadyShowing = noticeShowing()
  new MutationObserver(() => {
    if (!alreadyShowing && times.shown === undefined && noticeShowing()) times.shown = performance.now()
  }).observe(document, { subtree: true, childList: true })
  window.addEventListener('click', event => {
    if (times.clicked === undefined && isNotice(event.target)) times.clicked = performance.now()
  })
}

const noticeTimes = (editor: Page) => editor.evaluate(() => ({ ...(window as unknown as { noticeTimes: NoticeTimes }).noticeTimes }))

// When main created the first window that loads the trusted page, in epoch ms
const recordTrustedCreated = (app: ElectronApplication) => app.evaluate(({ app: electronApp }) => {
  const holder = globalThis as { trustedCreatedAt?: number }
  electronApp.on('browser-window-created', (_event, window) => {
    const created = Date.now()
    window.once('ready-to-show', () => {
      if (window.webContents.getURL().startsWith('hetu://trusted/')) holder.trustedCreatedAt ??= created
    })
  })
})

// When main created the first trusted window, waiting up to ms for one
async function trustedCreatedAt(app: ElectronApplication, ms = 0): Promise<number | undefined> {
  const created = () => app.evaluate(() => (globalThis as { trustedCreatedAt?: number }).trustedCreatedAt)
  for (let waited = 0; waited < ms && await created() === undefined; waited += 50) await tick(50)
  return created()
}

describe('a prompt a plugin\'s call raises', () => {
  // asker's plugin.call to target asks at its first use, since asker reads notes and target has network, the pair the
  // grant risk classifier makes ask. Both hold class 4 already, so the pass at start raises no notice of a move.
  // asker calls target.hello as soon as it is ready
  const workers = {
    target: { code: lifecycle(), manifest: { provides: { actions: { hello: {} } } }, entry: { granted: [{ type: 'net.fetch', hosts: ['example.com'] }], class: 4 } },
    // It requires target, so it starts once target is ready to be called
    asker: {
      manifest: { requires: ['target'] },
      code: lifecycle('send({ v: 1, kind: \'call\', id: 1, action: \'target.hello\', args: {} })'),
      entry: {
        granted: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'plugin.call', targets: ['target'] }],
        firstUse: [{ type: 'plugin.call', targets: ['target'] }], class: 4,
      },
    },
  } satisfies Record<string, Worker>

  it('waits as a notice, opens the trusted window only on a click past its delay, and a Confirm sent early confirms nothing', async () => {
    const dataDir = await data({ workers })
    const app = await start(dataDir, await install())
    const name = 'The plugin "asker" asks to use something for the first time'
    await app.context().addInitScript(recordNoticeTimes, name)
    await recordTrustedCreated(app)
    const editor = await editorPage(app)
    await editor.evaluate(recordNoticeTimes, name)
    const notice = editor.getByRole('button', { name })
    await notice.waitFor()
    // The call opened nothing, and a click as the notice appears opens nothing either. Checked only when the click
    // landed inside the delay by the page's clock. A slower machine skips it, the delay checked by when the trusted
    // window was created at the end
    await notice.click()
    await tick(500)
    const times = await noticeTimes(editor)
    expect(times.shown, 'notice drawn before its times were recorded').toBeDefined()
    expect(times.clicked, 'the click on the notice was not recorded').toBeDefined()
    const early = times.clicked! - times.shown! < INPUT_DELAY_MS - CLOCK_SLACK_MS
    if (early) {
      expect(await visibleWindows(app)).toEqual(['hetu://editor/'])
    } else if (await trustedCreatedAt(app, 3000) !== undefined) {
      // The click past the delay opened the trusted window. Closed, so the click below opens it again with a delay of
      // its own
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().startsWith('hetu://trusted/')) window.close()
      })
      await until(() => !app.windows().some(page => page.url() === 'hetu://trusted/'))
    }
    // No window but the trusted one confirms
    const status = (await ask(editor, 'core.status')).result as { pending: { id: string, kind: string }[] }
    const request = status.pending[0]
    expect(request.kind).toBe('item.on')
    expect((await ask(editor, 'security.confirm', { requestId: request.id })).refusal?.code).toBe('not-granted')

    await tick(PAST_DELAY)
    await notice.click()
    const page = await trustedPage(app)
    await showing(page, 'Let asker call the plugin "target"')
    // Inside the delay: the core refuses a Confirm whatever the page sends, and main drops a click on Cancel
    expect((await ask(page, 'security.confirm', { requestId: request.id })).refusal?.code).toBe('throttled')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await tick(200)
    expect((await ask(editor, 'core.status')).result).toMatchObject({ pending: [{ id: request.id }] })

    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await until(() => logged(dataDir, 'security.applied', { kind: 'item.on', target: 'asker' }))
    const entry = (await new StateStore(dataDir).load()).state.plugins.asker
    expect(entry.firstUse).toEqual([])

    // Past the delay the early check above was skipped, so this one shows the trusted window wasn't created sooner
    // than the delay after the notice showed. Inside the delay the window comes from the later click, so the early
    // check is the guard there
    if (!early) {
      const created = await trustedCreatedAt(app)
      expect(created).toBeDefined()
      expect(created! - (times.timeOrigin + times.shown!)).toBeGreaterThanOrEqual(INPUT_DELAY_MS - CLOCK_SLACK_MS)
    }
  })

  it('keeps the trusted page where it is when it tries to navigate', async () => {
    const dataDir = await data()
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await page.evaluate(() => { location.href = 'hetu://editor/' })
    await tick(300)
    expect(page.url()).toBe('hetu://trusted/')
  })
})

describe('the plugin list', () => {
  it('stops a hung worker for the human while another plugin floods', async () => {
    const dataDir = await data({
      switches: { limits: { all: { heartbeatMs: 300 }, plugins: {} } },
      workers: {
        hung: { code: lifecycle('setTimeout(() => { for (;;) {} }, 50)') },
        flood: { code: lifecycle('setInterval(() => { for (let i = 0; i < 5000; i++) send({ v: 1, kind: \'pong\' }) }, 0)') },
      },
    })
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    await until(() => logged(dataDir, 'plugin.unresponsive', { plugin: 'hung' }))
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await showing(page, 'hung · plugin folder · sandboxed · unresponsive')
    await tick(PAST_DELAY)
    await page.locator('.plugin', { hasText: 'hung ·' }).getByRole('button', { name: 'Stop' }).click()
    await until(() => logged(dataDir, 'plugin.stopped', { plugin: 'hung' }))
    await showing(page, 'hung · plugin folder · sandboxed · stopped (human)')
  })
})

describe('the switches and limits', () => {
  it('sets a limit and a switch from their sections, each waiting for its Confirm', async () => {
    const dataDir = await data()
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await until(async () => (await page.locator('section.install').count()) === 1)
    expect(await page.locator('section.install').innerText()).toContain('On macOS, programs running as you can change hetu’s install')
    await tick(PAST_DELAY)
    await tabTo(page, 'Limits')
    await showing(page, 'readyMs · fixed 10000')
    await page.getByLabel('New value for readyMs').fill('20000')
    await page.locator('.limit', { hasText: 'readyMs ·' }).getByRole('button', { name: 'Set' }).click()
    await showing(page, 'Set readyMs to 20000 for every plugin')
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await showing(page, 'readyMs · fixed 10000 · all: 20000')
    expect((await new StateStore(dataDir).load()).state.switches.limits.all).toEqual({ readyMs: 20000 })

    await tabTo(page, 'Switches')
    await page.locator('p', { hasText: 'Confirm off for this window: off' }).getByRole('button', { name: 'Switch on' }).click()
    await showing(page, 'Apply changes made in this window without a Confirm')
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await showing(page, 'Confirm off for this window: on')

    await tabTo(page, 'Limits')
    await page.getByLabel('New value for readyMs').fill('ten')
    await page.locator('.limit', { hasText: 'readyMs ·' }).getByRole('button', { name: 'Set' }).click()
    await showing(page, 'Type a whole number from 1 up')
  })

  it('switches the gate off only once the human typed its id and confirmed after the delay, the banner saying so', async () => {
    const dataDir = await data()
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await showing(page, 'gate · ships with hetu')
    await tick(PAST_DELAY)
    await page.locator('.plugin', { hasText: 'gate · ships with hetu' }).getByRole('button', { name: 'Switch off' }).click()
    await showing(page, 'Switch gate off')
    const confirm = page.getByRole('button', { name: 'Confirm' })
    await tick(PAST_DELAY)
    expect(await confirm.isDisabled()).toBe(true)
    await page.getByLabel('Type gate to confirm').fill('gat')
    expect(await confirm.isDisabled()).toBe(true)
    await page.getByLabel('Type gate to confirm').fill('gate')
    expect(await confirm.isDisabled()).toBe(false)
    await confirm.click()
    await until(() => logged(dataDir, 'security.confirm', { kind: 'plugin.off', target: 'gate' }))
    // The record lands before the change applies
    await until(async () => (await new StateStore(dataDir).load()).state.switches.off.includes('gate'))
    await until(async () => (await editor.locator('#banner li').allTextContents()).includes('gate: off'))
  })
})

describe('the identities list', () => {
  const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')
  // asker hands its context to the test, which calls callee on behalf of a field. callee asks the human for read on
  // inbox for the pair of the call it got, asker and that field
  const asker = `import { definePlugin } from '${sdk}'
export default definePlugin({ start(ctx) { ;(globalThis as Record<string, unknown>).ctx = ctx } })
`
  const callee = `import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    ctx.provide('ask', call => call.ctx.call('core', 'identityAsk', { capabilities: [{ type: 'luoshu.read', paths: ['inbox/**'] }] }))
  },
})
`
  const built = async (code: string) => {
    const source = await temp()
    await writeFolder(source, { 'src/worker.ts': code })
    const [one] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
    return one!.text
  }
  const askFor = (worker: PageWorker, field: string) => worker.evaluate(field => (globalThis as unknown as {
    ctx: { call(target: string, action: string, args: unknown, options: object): Promise<unknown> }
  }).ctx.call('callee', 'ask', {}, { onBehalf: field }), field)

  it('lists each pair the human gave items by its field in quotes under its root plugin in a face that wraps, revoking one at once', async () => {
    const calls = [{ type: 'plugin.call' as const, targets: ['callee'] }]
    const dataDir = await data({
      workers: {
        asker: { code: await built(asker), manifest: { requires: ['callee'], capabilities: calls }, entry: { granted: calls } },
        callee: { code: await built(callee), manifest: { provides: { actions: { ask: {} } } } },
      },
    })
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'asker' }))
    const workers = await workersPage(app, 'asker')
    await until(() => workers.workers().length === 1)
    const worker = workers.workers()[0] as PageWorker
    const prefix = 'https://claude.ai/oauth/'
    const long = `${prefix}${'x'.repeat(255 - prefix.length)}-7`
    const fields = [long, 'client-1', 'cIient-1']

    // Each ask waits for the human, who confirms it in the trusted window once its delay passed
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    for (const field of fields) {
      expect(await askFor(worker, field)).toEqual({ asked: 'waiting' })
      await until(async () => (await page.locator('section.request h1 span.label').innerText().catch(() => '')) === JSON.stringify(field))
      expect(await page.locator('section.request h1').innerText()).toBe(`Give ${JSON.stringify(field)} under asker what it asks for through callee`)
      await tick(PAST_DELAY)
      await page.getByRole('button', { name: 'Confirm' }).click()
      await until(async () => (await page.locator('section.request').count()) === 0)
    }
    await tabTo(page, 'Identities')
    await showing(page, '"cIient-1" under asker · Read the notes at "inbox/**"')
    const identities = page.locator('section.identities')
    expect(await identities.locator('h2').innerText()).toBe('Identities')
    expect(await identities.innerText()).not.toMatch(/\bagents?\b/i)

    // One more ask stays waiting, so its heading is measured beside the rows
    expect(await askFor(worker, 'client-2')).toEqual({ asked: 'waiting' })
    await until(async () => (await page.locator('section.request h1 span.label').innerText().catch(() => '')) === '"client-2"')
    const measured = await page.evaluate(() => {
      const width = document.documentElement.clientWidth
      const lines = [...document.querySelectorAll('section.identities p.identity'), document.querySelector('section.request h1')!]
      const all = lines.map(line => {
        const drawn = line.querySelector('.label')!
        const text = drawn.firstChild!
        // The box of the field's last two characters
        const end = document.createRange()
        end.setStart(text, text.textContent!.length - 2)
        end.setEnd(text, text.textContent!.length)
        const style = getComputedStyle(drawn)
        return { label: drawn.textContent, font: style.fontFamily, wrap: style.overflowWrap, fits: line.scrollWidth <= line.clientWidth, right: Math.ceil(end.getBoundingClientRect().right) }
      })
      // The face the field is drawn in: every character as wide as every other, so the system had a fixed-width one
      const span = document.querySelector('section.identities .label')!
      const pen = document.createElement('canvas').getContext('2d')!
      pen.font = `${getComputedStyle(span).fontSize} ${getComputedStyle(span).fontFamily}`
      const widths = Object.fromEntries(['I', 'l', '1', 'i', 'm', 'W'].map(glyph => [glyph, pen.measureText(glyph).width]))
      return { width, scroll: document.documentElement.scrollWidth, all, widths }
    })
    expect(measured.scroll).toBeLessThanOrEqual(measured.width)
    for (const drawn of measured.all) {
      expect(drawn.font).toContain('monospace')
      expect(drawn.wrap).toBe('anywhere')
      expect(drawn.fits).toBe(true)
      expect(drawn.right).toBeLessThanOrEqual(measured.width)
    }
    expect(measured.all.map(drawn => drawn.label)).toEqual([...fields.map(field => JSON.stringify(field)), '"client-2"'])
    expect(new Set(Object.values(measured.widths)).size).toBe(1)

    // Cancel and revoke turns the waiting pair away, Revoke takes a pair's items at once with no Confirm
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Cancel and revoke' }).click()
    await showing(page, '"client-2" under asker · revoked until hetu quits')
    await tick(PAST_DELAY)
    await identities.locator('p.identity', { hasText: '"client-1"' }).getByRole('button', { name: 'Revoke' }).click()
    await showing(page, '"client-1" under asker · revoked until hetu quits')
    expect(await page.locator('section.request').count()).toBe(0)
    expect(await identities.locator('p.identity', { hasText: '"client-1"' }).getByRole('button').count()).toBe(0)
    expect(await logged(dataDir, 'security.applied', { kind: 'identity.revoke', target: 'asker', field: 'client-1', by: 'narrows' })).toBe(true)
    // A revoked pair asks for nothing again in the run
    await expect(askFor(worker, 'client-1')).rejects.toThrow(/not-granted/)
  })
})

describe('a plugin’s class', () => {
  // target holds network. writer reads and can call target, so together they could send notes out: class 4, and the
  // plugin.call that brings the network in asks at its first use
  const workers = {
    target: { code: lifecycle(), manifest: { provides: { actions: { hello: {} } } }, entry: { granted: [{ type: 'net.fetch', hosts: ['example.com'] }], class: 3 } },
  } satisfies Record<string, Worker>

  it('shows on the approval and the plugin list, and the item that closes a read plus network pair asks at its first use', async () => {
    const dataDir = await data({
      workers,
      before: async dir => {
        const root = path.join(dir, 'plugins', 'writer')
        const capabilities = [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'plugin.call', targets: ['target'] }]
        await writeFolder(root, filesFor(workerManifest('writer', { requires: ['target'], capabilities }), {
          'worker.js': lifecycle('send({ v: 1, kind: \'call\', id: 1, action: \'target.hello\', args: {} })'),
        }))
        // An approval writes no signer until plugin provenance, so this build is trusted as the human would trust one
        const store = new StateStore(dir)
        const { switches } = (await store.load()).state
        await store.writeSwitches({ ...switches, allowUnsigned: [...switches.allowUnsigned, await hashOf(root)] })
      },
    })
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    // The grant risk classifier is a core module, on from the start
    await until(() => logged(dataDir, 'core.ready', { 'grant-risk-classifier': 'on' }))
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await showing(page, 'writer · plugin folder · sandboxed · found (new) · class unknown, counted as 4')
    await tick(PAST_DELAY)
    await page.locator('.plugin', { hasText: 'writer ·' }).getByRole('button', { name: 'Approve' }).click()
    await showing(page, 'Class 4, Powerful: it can read notes and reach the network, so it could send notes out')
    await showing(page, 'Through the plugins it calls it can send data to and get data from "example.com" over the network')
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await showing(page, 'class 4')
    const notice = editor.getByRole('button', { name: 'The plugin "writer" asks to use something for the first time' })
    await notice.waitFor()
    const entry = (await new StateStore(dataDir).load()).state.plugins.writer
    expect(entry).toMatchObject({ class: 4, firstUse: [{ type: 'plugin.call', targets: ['target'] }] })
  })
})

// The roadmap's first proof end to end: a plugin's worker reaches no security or window lifecycle action
describe('a plugin', () => {
  it('reaches no security.* or window lifecycle action, each refused not-granted and recorded', async () => {
    const actions = ['security.request', 'security.confirm', 'security.cancel', 'app.openSecurity', 'security.list', 'core.stop', 'core.restart', 'app.quit', 'app.relaunch']
    const calls = actions.map((action, i) => `send({ v: 1, kind: 'call', id: ${i + 1}, action: '${action}', args: ${action === 'security.request' ? "{ change: { kind: 'plugin.off', plugin: 'gate' } }" : action.startsWith('core.') && action !== 'app.quit' && action !== 'app.relaunch' ? "{ plugin: 'reacher' }" : action === 'security.confirm' || action === 'security.cancel' ? "{ requestId: 'r1' }" : '{}'} })`).join('\n')
    const dataDir = await data({ workers: { reacher: { code: lifecycle(calls) } } })
    const app = await start(dataDir, await install())
    await editorPage(app)
    for (const action of actions) {
      await until(() => logged(dataDir, 'audit.call', { action, code: 'not-granted' }))
    }
    expect(await logged(dataDir, 'security.request')).toBe(false)
    expect(await visibleWindows(app)).toEqual(['hetu://editor/'])
  })
})

// hetu ships no plugin, so the trusted window opens by itself over the editor on the startup flow every install goes
// through. With no plugin installed it has no way out and the window stays, and Quit still quits hetu
describe('the startup flow', () => {
  it('opens over the editor at start, goes a step at a time with no way out, keeps its window open and quits on Quit', async () => {
    const app = await start(await data({ startup: true }), await install())
    await editorPage(app)
    const page = await trustedPage(app)
    const guide = page.getByRole('region', { name: 'Get started with hetu' })
    await until(async () => await guide.count() === 1)
    expect(await page.getByRole('tab', { selected: true }).innerText()).toBe('Get started')
    expect(await guide.getByRole('heading', { level: 3 }).innerText()).toBe('Step 1 of 4: Pick the notes folder')
    expect(await guide.getByRole('button', { name: 'Pick a folder' }).count()).toBe(1)
    await tick(PAST_DELAY)
    await guide.getByRole('button', { name: 'Next' }).click()
    await until(async () => (await guide.getByRole('heading', { level: 3 }).innerText()) === 'Step 2 of 4: Install your first plugin')
    expect(await guide.getByLabel('or from a GitHub link, a suggestion to edit or replace').inputValue()).toBe('https://github.com/QianChenTT/hetu-plugins')
    await guide.getByRole('button', { name: 'Back' }).click()
    await until(async () => (await guide.getByRole('heading', { level: 3 }).innerText()) === 'Step 1 of 4: Pick the notes folder')
    expect(await guide.getByRole('button', { name: 'Go to Plugins' }).count()).toBe(0)
    for (let step = 2; step <= 4; step++) {
      await guide.getByRole('button', { name: 'Next' }).click()
      await until(async () => (await guide.getByRole('heading', { level: 3 }).innerText()).startsWith(`Step ${step} of 4`))
    }
    expect(await guide.getByRole('button', { name: 'Next' }).count()).toBe(0)
    expect(await guide.getByRole('button', { name: 'Done' }).count()).toBe(0)
    expect(await guide.getByRole('button', { name: 'Go to Plugins' }).count()).toBe(0)
    // Closing the window does nothing while the flow is due
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL() === 'hetu://trusted/') window.close()
    })
    await tick(500)
    expect((await visibleWindows(app)).sort()).toEqual(['hetu://editor/', 'hetu://trusted/'])
    const done = exited(app)
    await page.getByRole('button', { name: 'Quit', exact: true }).click()
    expect(await done).toBe(0)
  })

  it('goes to a step by its name and stays on Install after an install, its Confirm still waiting out the delay', async () => {
    const dataDir = await data({ startup: true })
    const zip = path.join(await temp(), 'greeter.zip')
    const files = filesFor(workerManifest('greeter', { name: 'Greeter', capabilities: [{ type: 'luoshu.read', paths: ['notes/**'] }] }), { 'worker.js': lifecycle() })
    await writeFile(zip, makeZip(Object.entries(files).map(([name, text]) => ({ name, data: text }))))
    const app = await start(dataDir, await install())
    await stubPicker(app, zip)
    await editorPage(app)
    const page = await trustedPage(app)
    const guide = page.getByRole('region', { name: 'Get started with hetu' })
    const heading = () => guide.getByRole('heading', { level: 3 }).innerText()
    const steps = guide.getByRole('list', { name: 'Steps' })
    await until(async () => await guide.count() === 1)
    await tick(PAST_DELAY)
    await steps.getByRole('button', { name: 'Install your first plugin' }).click()
    await until(async () => (await heading()) === 'Step 2 of 4: Install your first plugin')
    expect(await steps.getByRole('button', { name: 'Install your first plugin' }).getAttribute('aria-current')).toBe('step')
    await guide.getByRole('button', { name: 'Install from a zip' }).click()
    await showing(page, '"Greeter" (greeter), version 1.0.0')
    await tick(PAST_DELAY)
    await page.locator('section.installing').getByRole('button', { name: 'Install', exact: true }).click()
    await showing(page, 'greeter: Class 1, Reader')
    const confirm = page.getByRole('button', { name: 'Confirm' })
    // A step picked while the Confirm is new arms nothing early
    await steps.getByRole('button', { name: 'Approve it' }).click()
    await until(async () => (await heading()) === 'Step 3 of 4: Approve it')
    // One line says where the plugin installed is approved, with no Approve of its own
    expect(await guide.locator('.guide-step p').first().innerText()).toBe('Approve what you installed in its Confirm at the top of this window, or with Approve in the Plugins tab for a plugin copied in by hand')
    expect(await guide.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0)
    expect(await confirm.isDisabled()).toBe(true)
    await steps.getByRole('button', { name: 'Install your first plugin' }).click()
    await tick(PAST_DELAY)
    await confirm.click()
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'greeter' }))
    await showing(page, '1 plugin in the plugin folder')
    expect(await heading()).toBe('Step 2 of 4: Install your first plugin')
    // A plugin installed ends the flow: the guide stays where it was, now with a way out, and shows again from its tab
    await guide.getByRole('button', { name: 'Go to Plugins' }).click()
    await until(async () => await guide.count() === 0)
    expect(await page.getByRole('heading', { name: 'Plugins', exact: true }).count()).toBe(1)
    await page.getByRole('tab', { name: 'Get started', exact: true }).click()
    await until(async () => await guide.count() === 1)
  })
})

// The Install button wired to main: main's own dialog picks the zip, main stages it, the page names it by its handle
describe('the Install button', () => {
  it('installs a plugin zip picked in main’s dialog through one Confirm, which stores the class shown and starts it', async () => {
    const dataDir = await data()
    const zip = path.join(await temp(), 'greeter.zip')
    const files = filesFor(workerManifest('greeter', { name: 'Greeter', capabilities: [{ type: 'luoshu.read', paths: ['notes/**'] }] }), { 'worker.js': lifecycle() })
    await writeFile(zip, makeZip(Object.entries(files).map(([name, text]) => ({ name, data: text }))))
    const app = await start(dataDir, await install())
    await stubPicker(app, zip)
    const editor = await editorPage(app)
    await until(() => logged(dataDir, 'core.ready'))
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await tick(PAST_DELAY)
    // Cancel drops the staging main made
    await page.getByRole('button', { name: 'Install from a zip' }).first().click()
    await showing(page, '"Greeter" (greeter), version 1.0.0')
    await page.locator('section.installing').getByRole('button', { name: 'Cancel' }).click()
    await until(async () => !(await text(page)).includes('"Greeter" (greeter)'))
    await until(async () => (await readdir(path.join(dataDir, 'staging', 'installs'))).length === 0)
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Install from a zip' }).first().click()
    await showing(page, '"Greeter" (greeter), version 1.0.0')
    await showing(page, `From the zip "${zip}"`)
    expect(await text(page)).toContain('Read the notes at "notes/**"')
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Install', exact: true }).click()
    await showing(page, 'greeter: Class 1, Reader')
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'greeter' }))
    const { state } = await new StateStore(dataDir).load()
    expect(state.plugins.greeter).toMatchObject({ class: 1, signer: null, granted: [{ type: 'luoshu.read', paths: ['notes/**'] }] })
    expect(state.switches.allowUnsigned).toContain(await hashOf(path.join(dataDir, 'plugins', 'greeter')))
    expect(await readdir(path.join(dataDir, 'staging', 'installs'))).toEqual([])
  })
})

// The page draws itself anew on every event, so focus and the caret are put back on the control drawn in its place
describe('the trusted page across a redraw', () => {
  it('keeps a link being typed focused with its caret when an event redraws the page, beside a status line read aloud', async () => {
    const app = await start(await data(), await install())
    const editor = await editorPage(app)
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    const field = page.locator('.plugins input[data-key="link:list"]')
    await until(async () => await field.count() === 1)
    await field.fill('https://github.com/someone/plu')
    await field.evaluate(input => {
      (input as HTMLInputElement).setSelectionRange(8, 8)
      ;(input as unknown as { drawnBefore: boolean }).drawnBefore = true
    })
    // A request from the editor makes the core tell every window, so the trusted page reads its list and draws again
    await ask(editor, 'security.request', { change: { kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null } })
    await showing(page, 'Set readyMs to 20000 for every plugin')
    expect(await page.evaluate(() => {
      const active = document.activeElement as HTMLInputElement & { drawnBefore?: boolean }
      return { key: active.dataset.key, drawnBefore: active.drawnBefore === true, value: active.value, start: active.selectionStart }
    })).toEqual({ key: 'link:list', drawnBefore: false, value: 'https://github.com/someone/plu', start: 8 })
    expect(await page.getByRole('status').count()).toBe(1)
  })
})
