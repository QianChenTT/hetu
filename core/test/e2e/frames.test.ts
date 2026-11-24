import { appendFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { tokenNames } from '../../api/ui.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { partition } from '../../backend/runtime/sessions.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, launch, logged, pageAt, setUp, temp, tick, until, visibleWindows, workersPage, openByHand, writeOpener } from './helpers.ts'

afterEach(cleanup)

// The trusted window takes no click within its input delay
const PAST_DELAY = 1300

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// HETU_PROBES=<file> appends what each probe found, one JSON line each, for the probe report
async function found(probe: string, result: unknown): Promise<void> {
  const file = process.env.HETU_PROBES
  if (file !== undefined && file !== '') await appendFile(file, `${JSON.stringify({ probe, result })}\n`)
}

// The plugin's worker: records every ui event and hands its ctx to the test. A view named tree it draws as one icon of its
// own files
const worker = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const scope = globalThis as Record<string, unknown>
    scope.ctx = ctx
    const heard: unknown[] = []
    scope.heard = heard
    for (const topic of ['view.opened', 'view.message', 'view.shown'] as const) ctx.ui.on(topic, event => heard.push(event))
    ctx.ui.on('view.opened', event => {
      if (event.view === 'tree') void ctx.ui.views.draw(event.instance, { kind: 'icon', id: 'icon', src: 'icon.svg', alt: 'tree icon' }).catch(() => {})
    })
  },
})
`

// A frame's script: takes the drawer's port, says hello with where it is and what the CSP refused, navigates when told
const board = `
var refused = []
document.addEventListener('securitypolicyviolation', function (event) { refused.push(event.violatedDirective + ' ' + event.blockedURI) })
window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.ports[0]) return
  var port = event.ports[0]
  port.onmessage = function (message) {
    var data = JSON.parse(message.data)
    if (data === 'go') location.href = 'again.html'
    if (data === 'spin') setTimeout(function () { for (;;) {} }, 100)
    if (data === 'report') port.postMessage(JSON.stringify({ refused: refused }))
  }
  // Loads from elsewhere on the plugin's own host, which the frame's CSP should refuse
  var script = document.createElement('script')
  script.src = 'hetu://kanban.views/ffffffffffffffffffffffffffffffff/board.js'
  document.head.appendChild(script)
  var image = document.createElement('img')
  image.src = 'hetu://kanban.views/icon/icon.svg'
  document.body.appendChild(image)
  // And from the images host, which only the editor page's own image nodes load from
  var note = document.createElement('img')
  note.src = 'hetu://images/ffffffffffffffffffffffffffffffff'
  document.body.appendChild(note)
  port.postMessage(JSON.stringify({ hello: location.pathname }))
})
`
// A frame's script that reports what it can see of the editor page: where it is and came from, its name, whether the
// parent's document is open to it and whether a style element carrying the nonce it is sent applies in its own page
const peek = `
window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.ports[0]) return
  var port = event.ports[0]
  port.onmessage = function (message) {
    var data = JSON.parse(message.data)
    if (!data || typeof data.nonce !== 'string') return
    var parentDocument = 'open'
    try {
      parentDocument = String(parent.document.documentElement.outerHTML.length)
    } catch (err) {
      parentDocument = err.name
    }
    var style = document.createElement('style')
    style.setAttribute('nonce', data.nonce)
    style.textContent = 'p { color: rgb(1, 2, 3) }'
    document.head.appendChild(style)
    var applied = getComputedStyle(document.querySelector('p')).color === 'rgb(1, 2, 3)'
    port.postMessage(JSON.stringify({ seen: [location.href, document.referrer, window.name].join(' '), parentDocument: parentDocument, applied: applied }))
  }
  port.postMessage(JSON.stringify({ hello: location.pathname }))
})
`
// Each view shown once by a click on its tab, so each frame loads. A frame keeps running hidden while another tab of
// its column shows
async function showEach(editor: Page): Promise<void> {
  const titles = editor.locator('#editors .hetu-title')
  await until(async () => (await titles.count()) > 0)
  const count = await titles.count()
  for (let at = 0; at < count; at++) {
    await titles.nth(at).click()
    await tick(200)
  }
}

const page = (script: string, type = '') => `<!doctype html><html><head><meta charset="utf-8"><script ${type}src="${script}"></script></head><body><p>frame</p></body></html>`

type Frame = { html: string, files: Record<string, string> }

// What else a run holds: kanban's views and other plugins with views of their own, each drawn by the same frame but a
// view named tree, which its worker draws, and a theme kanban declares
type More = { views?: string[], others?: Record<string, string[]>, theme?: object }

async function started(frame: Frame, notes: Record<string, string> = {}, more: More = {}): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, worker: Worker }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(notes)) await writeFile(path.join(folder, name), text)
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: [] })
  await store.writeLuoshu({ folder })
  await writeOpener(dataDir)
  // TODO: drop once the startup screen no longer waits on an approved ui.layout plugin to leave the welcome guide
  await setUp(dataDir)
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': worker })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const granted: Capability[] = [{ type: 'ui.view' }]
  const plugins: [string, string[]][] = [['kanban', more.views ?? ['board']], ...Object.entries(more.others ?? {})]
  for (const [id, views] of plugins) {
    const manifest = workerManifest(id, {
      capabilities: granted,
      entries: { worker: 'worker.js', frames: { board: 'board.html' } },
      views: Object.fromEntries(views.map(view => [view, view === 'tree' ? { title: view, kind: 'view' } : { title: view, kind: 'view', frame: 'board' }])),
      ...(id === 'kanban' && more.theme !== undefined ? { theme: more.theme } : {}),
    })
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(manifest, { 'worker.js': built.text, 'board.html': frame.html, 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>', ...frame.files }))
    await writeApproved(store, id, root, { granted })
  }
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  for (const id of ['kanban', ...Object.keys(more.others ?? {})]) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  const host = await workersPage(app, 'kanban')
  await until(() => host.workers().length === 1)
  return { app, editor, dataDir, worker: host.workers()[0] as Worker }
}

type Heard = { topic: string, instance?: string, data?: unknown }
const heard = (worker: Worker) => worker.evaluate('globalThis.heard') as Promise<Heard[]>
const messages = async (worker: Worker) => (await heard(worker)).filter(event => event.topic === 'view.message').map(event => event.data)
// The data goes in as evaluate's argument, so no code is built from it
const post = (worker: Worker, data: unknown) => worker.evaluate(async sent => {
  const scope = globalThis as unknown as { heard: Heard[], ctx: { ui: { views: { post(instance: string, data: unknown): Promise<void> } } } }
  const opened = scope.heard.find(event => event.topic === 'view.opened')!
  await scope.ctx.ui.views.post(opened.instance!, sent)
}, data)

describe('view frames', () => {
  it('loads a frame from its token\'s path under its CSP, refuses loads from elsewhere and hands it a port with no preload', async () => {
    const { editor, worker } = await started({ html: page('board.js'), files: { 'board.js': board } })
    await until(async () => (await messages(worker)).length >= 1)
    const [hello] = await messages(worker)
    expect(hello).toMatchObject({ hello: expect.stringMatching(/^\/[0-9a-f]{32}\/board\.html$/) })
    await post(worker, 'report')
    await until(async () => (await messages(worker)).some(data => (data as { refused?: unknown }).refused !== undefined))
    const report = (await messages(worker)).find(data => (data as { refused?: unknown }).refused !== undefined) as { refused: string[] }
    await found('csp', { hello, refused: report.refused })
    expect(report.refused.some(entry => entry.startsWith('script-src'))).toBe(true)
    expect(report.refused.some(entry => entry.startsWith('img-src'))).toBe(true)
    // Chromium names only the scheme of a blocked load, so the icon's and the images host's are one each
    expect(report.refused.filter(entry => entry.startsWith('img-src'))).toHaveLength(2)
    const frame = editor.locator('#editors iframe.hetu-frame')
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('removes a frame that navigates after its first load, records it and gives the new page no port', async () => {
    const { editor, worker, dataDir } = await started({ html: page('board.js'), files: { 'board.js': board } })
    await until(async () => (await messages(worker)).length === 1)
    await post(worker, 'go')
    await until(() => logged(dataDir, 'frame.navigated', { plugin: 'kanban' }))
    await until(async () => (await editor.locator('#editors iframe.hetu-frame').count()) === 0)
    await tick(500)
    expect(await messages(worker)).toHaveLength(1)
    await found('navigated after load', { removed: true, recorded: true, hellos: (await messages(worker)).length })
  })

  it('probes a frame that navigates before its first load', async () => {
    const early = 'location.replace("elsewhere.html")'
    const { editor, worker, dataDir } = await started({ html: page('early.js'), files: { 'early.js': early } })
    await until(async () => (await editor.locator('#editors iframe.hetu-frame').count()) === 1)
    await tick(1500)
    const result = {
      hellos: (await messages(worker)).length,
      framesLeft: await editor.locator('#editors iframe.hetu-frame').count(),
      recorded: await logged(dataDir, 'frame.navigated', { plugin: 'kanban' }),
    }
    await found('navigated before load', result)
    // Whichever load came first, the page that got the port is the error page for elsewhere.html, where no code runs
    expect(result.hellos).toBe(0)
  })

  it('never shows a frame the editor page\'s style nonce, which styles nothing in a frame\'s own page either', async () => {
    const { editor, worker } = await started({ html: page('peek.js'), files: { 'peek.js': peek } })
    await until(async () => (await messages(worker)).length === 1)
    const nonce = await editor.evaluate(() => (document.querySelector('script[src="page.js"]') as HTMLScriptElement).nonce)
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    await post(worker, { nonce })
    await until(async () => (await messages(worker)).length === 2)
    const report = (await messages(worker))[1] as { seen: string, parentDocument: string, applied: boolean }
    expect(report.seen).not.toContain(nonce)
    expect(report.parentDocument).toBe('SecurityError')
    expect(report.applied).toBe(false)
  })

  it('probes module scripts in a view', async () => {
    const { worker } = await started({ html: page('module.js', 'type="module" '), files: { 'module.js': board } })
    await tick(3000)
    const ran = (await messages(worker)).length > 0
    await found('module scripts', { ran })
  })

  it('keeps the editor taking typing while a frame loops forever, and says which process the frame runs in', async () => {
    const { app, editor, worker } = await started({ html: page('board.js'), files: { 'board.js': board } }, { 'a.md': '' })
    await until(async () => (await messages(worker)).length === 1)
    const processes = await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')
      return (contents?.mainFrame.framesInSubtree ?? []).map(frame => ({ url: frame.url.replace(/[0-9a-f]{32}/, '<token>'), processId: frame.processId, osProcessId: frame.osProcessId }))
    })
    await post(worker, 'spin')
    await tick(500)
    await openByHand(editor, 'a.md')
    const before = Date.now()
    await editor.locator('.editor:not([hidden]) .cm-content').click()
    await editor.keyboard.type('still typing')
    await until(async () => (await editor.locator('.editor:not([hidden]) .cm-content').innerText()) === 'still typing', 5000)
    const typedMs = Date.now() - before
    await found('frame freeze', { processes, typedMs })
    const editorProcess = processes.find(frame => frame.url === 'hetu://editor/')?.osProcessId
    const frameProcess = processes.find(frame => frame.url.startsWith('hetu://kanban.views/'))?.osProcessId
    expect(frameProcess).not.toBe(editorProcess)
  })
})

// Each frame in the editor page with the process it runs in, its token in its URL
const framed = (app: ElectronApplication) => app.evaluate(({ webContents }) => {
  const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')
  return (contents?.mainFrame.framesInSubtree ?? []).map(frame => ({ url: frame.url, osProcessId: frame.osProcessId }))
})
// What the editor session's protocol handler answers for a URL, asked from main as the page's own loads are
const status = (app: ElectronApplication, url: string) =>
  app.evaluate(async ({ session }, [name, at]) => (await session.fromPartition(name as string).fetch(at as string)).status, [partition('editor'), url])

describe('a host for each plugin\'s frames', () => {
  it('gives each plugin\'s frames a process of their own whose scripts run, one for all of a plugin\'s frames, shows a tree view\'s icon from its plugin\'s host and stops serving a stopped plugin\'s tokens and icons', async () => {
    // An id with an underscore and one of 64 characters, whose host is past a DNS label's 63
    const long = `${'ab_'.repeat(21)}c`
    const { app, editor, dataDir } = await started({ html: page('board.js'), files: { 'board.js': board } }, {}, {
      views: ['board', 'list'], others: { my_board: ['board', 'tree'], [long]: ['board'] },
    })
    await showEach(editor)
    const loaded = async () => (await framed(app)).filter(frame => /^hetu:\/\/[a-z0-9-]+\.views\/[0-9a-f]{32}\/board\.html$/.test(frame.url))
    await until(async () => (await loaded()).length === 4)
    const frames = await loaded()
    const on = (host: string) => frames.filter(frame => frame.url.startsWith(`hetu://${host}/`))
    const kanban = on('kanban.views')
    const mine = on('my--board.views')
    const longest = on(`${'ab--'.repeat(21)}c.views`)
    const editorProcess = (await framed(app)).find(frame => frame.url === 'hetu://editor/')?.osProcessId
    await found('process per plugin', { editorProcess, frames: frames.map(frame => ({ ...frame, url: frame.url.replace(/[0-9a-f]{32}/, '<token>') })) })
    expect([kanban.length, mine.length, longest.length]).toEqual([2, 1, 1])
    expect(kanban[0]!.osProcessId).toBe(kanban[1]!.osProcessId)
    expect(new Set([editorProcess, kanban[0]!.osProcessId, mine[0]!.osProcessId, longest[0]!.osProcessId]).size).toBe(4)

    // Each frame's own script ran under the frame's policy and said hello to its plugin's worker
    for (const [id, count] of [['kanban', 2], ['my_board', 1], [long, 1]] as const) {
      const host = await workersPage(app, id)
      await until(() => host.workers().length === 1)
      const hellos = async () => (await messages(host.workers()[0] as Worker)).filter(data => (data as { hello?: unknown }).hello !== undefined).length
      await until(async () => (await hellos()) === count)
    }

    // The tree view's icon loads in the editor page itself, under the page's policy
    const icon = editor.locator('img[alt="tree icon"]')
    await until(async () => (await icon.count()) === 1)
    expect(await icon.getAttribute('src')).toBe('hetu://my--board.views/icon/icon.svg')
    await until(() => icon.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 4))

    // A token loads its plugin's files on its own host only, and each plugin's icons load on its own host
    const script = (url: string) => url.replace(/board\.html$/, 'board.js')
    expect(await status(app, script(kanban[0]!.url))).toBe(200)
    expect(await status(app, script(kanban[0]!.url).replace('kanban.views', 'my--board.views'))).toBe(404)
    expect(await status(app, 'hetu://kanban.views/icon/icon.svg')).toBe(200)
    expect(await status(app, 'hetu://my--board.views/icon/icon.svg')).toBe(200)

    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const trusted = await pageAt(app, 'hetu://trusted/')
    await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
    await tick(PAST_DELAY)
    await trusted.locator('.plugin', { hasText: 'kanban ·' }).getByRole('button', { name: 'Stop' }).click()
    await until(() => logged(dataDir, 'plugin.stopped', { plugin: 'kanban' }))
    await until(async () => (await status(app, 'hetu://kanban.views/icon/icon.svg')) === 404)
    for (const frame of kanban) expect(await status(app, script(frame.url))).toBe(404)
    expect(await status(app, script(mine[0]!.url))).toBe(200)
    expect(await status(app, 'hetu://my--board.views/icon/icon.svg')).toBe(200)
  })
})

const frameSdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'frame.ts').split(path.sep).join('/')

// A frame's script on @hetu/sdk/frame: tells its worker the theme it connected with, the background color the
// hetu-theme.css its page links to gave it and each theme it hears after
const themed = `
import { connect } from '${frameSdk}'
void connect().then(view => {
  const sheet = getComputedStyle(document.documentElement).getPropertyValue('--hetu-color-bg').trim()
  view.post({ connected: view.theme(), sheet })
  view.onTheme(theme => view.post({ changed: theme }))
})
`
const linked = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="hetu-theme.css"><script src="board.js"></script></head><body></body></html>'

// Every token's value the page draws the frames' layer with, from a theme or shell.css, and the editor's link color
const pageTheme = (editor: Page) => editor.locator('#editors').evaluate((element, names) => {
  const drawn = getComputedStyle(element)
  return Object.fromEntries(names.map(name => [name, drawn.getPropertyValue(name).trim()]).filter(([, value]) => value !== ''))
}, [...tokenNames, 'color-editor-link'].map(name => `--hetu-${name}`))

// The variables of the hetu-theme.css main serves at the root of the first frame's ticket, asked from main as its loads are
async function sheetTheme(app: ElectronApplication): Promise<Record<string, string>> {
  const url = (await framed(app)).find(frame => frame.url.startsWith('hetu://kanban.views/'))!.url.replace(/board\.html$/, 'hetu-theme.css')
  const text = await app.evaluate(async ({ session }, [name, at]) => (await session.fromPartition(name as string).fetch(at as string)).text(), [partition('editor'), url])
  return Object.fromEntries([...text.matchAll(/(--hetu-[a-z0-9-]+): ([^;]*);/g)].map(match => [match[1], match[2]]))
}

describe('the theme in a frame', () => {
  it('hands a frame the page\'s theme, hetu\'s own with none picked, with its port, in hetu-theme.css at its ticket\'s root and on each change, to a frame open since before and one opened since', async () => {
    const source = await temp()
    await writeFolder(source, { 'src/board.ts': themed })
    const [built] = await buildPlugin(source, { entries: { 'board.js': 'src/board.ts' }, write: false })
    // The editor's own colors fail the contrast floor, so the page's variables are the drawer's and not the theme's
    const theme = { tokens: { 'color-bg': '#202020', 'color-accent': '#ff8800', 'color-editor-fg': '#fefefe', 'color-editor-bg': '#ffffff' } }
    const { app, editor, worker } = await started({ html: linked, files: { 'board.js': built!.text } }, {}, { theme })
    await until(async () => (await messages(worker)).length === 1)
    // hetu's own look with no theme picked: shell.css's values and hetu's link color
    const defaults = { ...await pageTheme(editor), '--hetu-color-editor-link': '#1a5fb4' }
    expect(Object.keys(defaults)).toHaveLength(tokenNames.length + 1)
    expect(defaults).toMatchObject({ '--hetu-color-bg': '#ffffff', '--hetu-font-ui': 'system-ui, sans-serif', '--hetu-space': '8px' })
    expect(await messages(worker)).toEqual([{ connected: defaults, sheet: '#ffffff' }])
    await until(async () => (await sheetTheme(app))['--hetu-color-bg'] === '#ffffff')
    expect(await sheetTheme(app)).toEqual(defaults)
    await editor.locator('#views').click()
    await until(async () => editor.locator('#menu').isVisible())
    await editor.locator('#menu select').first().selectOption('kanban')
    await editor.locator('#menu-close').click()
    await until(async () => (await messages(worker)).length === 2)
    const variables = await pageTheme(editor)
    expect(variables).toMatchObject({ '--hetu-color-bg': '#202020', '--hetu-color-editor-fg': '#1f1f1f' })
    expect((await messages(worker))[1]).toEqual({ changed: variables })
    await until(async () => (await sheetTheme(app))['--hetu-color-bg'] === '#202020')
    expect(await sheetTheme(app)).toEqual(variables)

    // The drawer's layout shows one instance of a view, so the first goes before another opens
    await worker.evaluate(async () => {
      const scope = globalThis as unknown as { heard: Heard[], ctx: { ui: { views: { close(instance: string): Promise<void>, open(view: string): Promise<string> } } } }
      await scope.ctx.ui.views.close(scope.heard.find(event => event.topic === 'view.opened')!.instance!)
      await scope.ctx.ui.views.open('board')
    })
    await until(async () => (await messages(worker)).length === 3)
    expect((await messages(worker))[2]).toEqual({ connected: variables, sheet: '#202020' })
    await tick(300)
    expect(await messages(worker)).toHaveLength(3)
  })
})

describe('a frame over its slot', () => {
  // The focus guard and the press mapping take the frame as laid unrotated over its slot's box
  type Box = { x: number, y: number, width: number, height: number }
  const near = (a: Box, b: Box) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1
  const frameBox = (editor: Page) => editor.locator('#editors iframe.hetu-frame').boundingBox()
  const over = async (editor: Page) => {
    const frame = await frameBox(editor)
    if (frame === null || frame.width === 0) return false
    const slots = await editor.locator('#base .hetu-slot').evaluateAll(all => all.map(slot => {
      const at = slot.getBoundingClientRect()
      return { x: at.x, y: at.y, width: at.width, height: at.height }
    }))
    return slots.some(slot => near(frame, slot))
  }
  // A press dragged across the page in steps
  const drag = async (editor: Page, from: { x: number, y: number }, to: { x: number, y: number }) => {
    await editor.mouse.move(from.x, from.y)
    await editor.mouse.down()
    await editor.mouse.move(to.x, to.y, { steps: 10 })
    await editor.mouse.up()
  }

  it('stays laid over its slot when the human resizes the slot\'s column and when the view is dragged to the other side', async () => {
    const { editor, worker } = await started({ html: page('board.js'), files: { 'board.js': board } })
    await until(async () => (await messages(worker)).length >= 1)
    await until(() => over(editor))
    const first = (await frameBox(editor))!
    const stage = (await editor.locator('#stage').boundingBox())!
    const onLeft = first.x + first.width / 2 < stage.x + stage.width / 2
    // The frame is laid over its slot, never moved in the page, so it is the same element throughout
    await editor.locator('#editors iframe.hetu-frame').evaluate(frame => void ((frame as unknown as { kept: boolean }).kept = true))

    // The divider at the frame's inner edge, dragged 120 px into main
    const inner = onLeft ? first.x + first.width : first.x
    const dividers = await editor.locator('#base [data-divider]').evaluateAll(all => all.map(divider => {
      const at = divider.getBoundingClientRect()
      return { x: at.x + at.width / 2, y: at.y + at.height / 2 }
    }))
    const divider = dividers.sort((one, other) => Math.abs(one.x - inner) - Math.abs(other.x - inner))[0]!
    await drag(editor, divider, { x: divider.x + (onLeft ? 120 : -120), y: divider.y })
    await until(async () => ((await frameBox(editor))?.width ?? 0) > first.width + 100)
    await until(() => over(editor))

    // The view's title dragged onto the other side's column
    const title = (await editor.locator('#editors .hetu-title', { hasText: 'kanban · board' }).first().boundingBox())!
    await drag(editor, { x: title.x + 10, y: title.y + title.height / 2 }, { x: onLeft ? stage.x + stage.width - 60 : stage.x + 60, y: stage.y + stage.height / 2 })
    await until(async () => {
      const now = await frameBox(editor)
      return now !== null && (now.x + now.width / 2 < stage.x + stage.width / 2) !== onLeft
    })
    await until(() => over(editor))
    expect(await editor.locator('#editors iframe.hetu-frame').evaluate(frame => (frame as unknown as { kept?: boolean }).kept === true)).toBe(true)
  })
})
