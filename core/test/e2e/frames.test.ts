import { appendFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../loader-fakes.ts'
import { cleanup, editorPage, launch, logged, temp, tick, until, workersPage } from './helpers.ts'

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// HETU_PROBES=<file> appends what each probe found, one JSON line each, for the probe report
async function found(probe: string, result: unknown): Promise<void> {
  const file = process.env.HETU_PROBES
  if (file !== undefined && file !== '') await appendFile(file, `${JSON.stringify({ probe, result })}\n`)
}

// The plugin's worker: records every ui event and hands its ctx to the test
const worker = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const scope = globalThis as Record<string, unknown>
    scope.ctx = ctx
    const heard: unknown[] = []
    scope.heard = heard
    for (const topic of ['view.opened', 'view.message', 'view.shown'] as const) ctx.ui.on(topic, event => heard.push(event))
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
  // Loads from elsewhere on the views host, which the frame's CSP should refuse
  var script = document.createElement('script')
  script.src = 'hetu://views/ffffffffffffffffffffffffffffffff/board.js'
  document.head.appendChild(script)
  var image = document.createElement('img')
  image.src = 'hetu://views/icon/kanban/icon.svg'
  document.body.appendChild(image)
  port.postMessage(JSON.stringify({ hello: location.pathname }))
})
`
const page = (script: string, type = '') => `<!doctype html><html><head><meta charset="utf-8"><script ${type}src="${script}"></script></head><body><p>frame</p></body></html>`

type Frame = { html: string, files: Record<string, string> }

async function started(frame: Frame, notes: Record<string, string> = {}): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, worker: Worker }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(notes)) await writeFile(path.join(folder, name), text)
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: [] })
  await store.writeLuoshu({ folder })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': worker })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const granted: Capability[] = [{ type: 'ui.view' }]
  const manifest = workerManifest('kanban', {
    capabilities: granted,
    entries: { worker: 'worker.js', frames: { board: 'board.html' } },
    views: { board: { title: 'Board', kind: 'view', frame: 'board' } },
  })
  const root = path.join(dataDir, 'plugins', 'kanban')
  await writeFolder(root, filesFor(manifest, { 'worker.js': built.text, 'board.html': frame.html, 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', ...frame.files }))
  await store.writePlugin('kanban', await entryFor(root, { granted }))
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'kanban' }))
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
    await editor.keyboard.press('ControlOrMeta+p')
    await until(async () => editor.locator('#palette').isVisible())
    await editor.keyboard.type('a.md')
    await until(async () => (await editor.locator('#palette-list li').first().innerText()) === 'a.md')
    await editor.keyboard.press('Enter')
    await until(async () => (await editor.locator('#title').innerText()).startsWith('a.md'))
    const before = Date.now()
    await editor.locator('.editor:not([hidden]) .cm-content').click()
    await editor.keyboard.type('still typing')
    await until(async () => (await editor.locator('.editor:not([hidden]) .cm-content').innerText()) === 'still typing', 5000)
    const typedMs = Date.now() - before
    await found('frame freeze', { processes, typedMs })
    const editorProcess = processes.find(frame => frame.url === 'hetu://editor/')?.osProcessId
    const frameProcess = processes.find(frame => frame.url.startsWith('hetu://views/'))?.osProcessId
    expect(frameProcess).not.toBe(editorProcess)
  })
})
