import { createSocket } from 'node:dgram'
import { appendFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { partition, ROLES, type Role } from '../../backend/runtime/sessions.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../plugins-manager-fakes.ts'
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
// A frame's script that, sent ICE servers, opens a peer connection to each and offers, as an artifact sending a note
// out through WebRTC would. It reports each connection's gathering state 3 s later
const rtc = `
window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.ports[0]) return
  var port = event.ports[0]
  port.onmessage = function (message) {
    var data = JSON.parse(message.data)
    if (!data || !Array.isArray(data.servers)) return
    Promise.all(data.servers.map(function (server) {
      var connection = new RTCPeerConnection({ iceServers: [server] })
      connection.createDataChannel('out')
      return connection.createOffer().then(function (offer) { return connection.setLocalDescription(offer) }).then(function () { return connection })
    })).then(function (opened) {
      setTimeout(function () {
        port.postMessage(JSON.stringify({ tried: opened.map(function (connection) { return connection.iceGatheringState }) }))
        opened.forEach(function (connection) { connection.close() })
      }, 3000)
    }, function (err) { port.postMessage(JSON.stringify({ failed: String(err) })) })
  }
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

// What the frame reported after its peer connections tried to reach the ICE servers it was sent
async function rtcReport(worker: Worker, servers: object[]): Promise<{ tried?: string[], failed?: string }> {
  await until(async () => (await messages(worker)).length === 1)
  await post(worker, { servers })
  const report = (data: unknown) => (data as { tried?: unknown }).tried !== undefined || (data as { failed?: unknown }).failed !== undefined
  await until(async () => (await messages(worker)).some(report))
  return (await messages(worker)).find(report) as { tried?: string[], failed?: string }
}

describe('WebRTC from a view frame', () => {
  it('sends no STUN packet over UDP to a server on loopback, with every web contents sending no UDP outside a proxy', async () => {
    const stun = createSocket('udp4')
    let packets = 0
    stun.on('message', () => packets++)
    await new Promise<void>(resolve => stun.bind(0, '127.0.0.1', resolve))
    try {
      const { app, worker } = await started({ html: page('rtc.js'), files: { 'rtc.js': rtc } })
      const report = await rtcReport(worker, [{ urls: `stun:127.0.0.1:${stun.address().port}` }])
      expect(report).toEqual({ tried: [expect.any(String)] })
      expect(packets).toBe(0)
      const policies = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => contents.getWebRTCIPHandlingPolicy()))
      expect(policies.length).toBeGreaterThanOrEqual(2)
      expect(new Set(policies)).toEqual(new Set(['disable_non_proxied_udp']))
    } finally {
      stun.close()
    }
  })

  it('opens no TURN connection over TCP to a server on loopback, with every session behind a proxy that leads nowhere', async () => {
    let connections = 0
    const turn = createServer(socket => {
      connections++
      socket.destroy()
    })
    await new Promise<void>(resolve => turn.listen(0, '127.0.0.1', resolve))
    try {
      const { app, worker } = await started({ html: page('rtc.js'), files: { 'rtc.js': rtc } })
      const { port } = turn.address() as { port: number }
      const report = await rtcReport(worker, [{ urls: `turn:127.0.0.1:${port}?transport=tcp`, username: 'note text', credential: 'x' }])
      expect(report).toEqual({ tried: [expect.any(String)] })
      expect(connections).toBe(0)
      const partitions = (Object.keys(ROLES) as Role[]).map(partition)
      const proxies = await app.evaluate(({ session }, names) => Promise.all([session.defaultSession, ...names.map(name => session.fromPartition(name))]
        .flatMap(each => ['http://127.0.0.1/', 'https://example.com/'].map(url => each.resolveProxy(url)))), partitions)
      expect(proxies).toHaveLength(8)
      expect(new Set(proxies)).toEqual(new Set(['SOCKS5 127.0.0.1:1']))
    } finally {
      turn.close()
    }
  })
})
