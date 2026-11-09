import { afterEach, describe, expect, it } from 'vitest'
import { filesFor, workerManifest, writeInstall } from '../loader-fakes.ts'
import { cleanup, dataWith, exited, launch, logged, records, temp, until, visibleWindows, workersPage } from './helpers.ts'

afterEach(cleanup)

const at = (record: Record<string, unknown>) => Date.parse(record.at as string)

// A worker that speaks the lifecycle as text on the port the page hands it, the way the SDK will. after runs once it is ready.
// It answers a stop after saveMs, as a plugin saving its state would
const lifecycle = (after = '', saveMs = 0) => `
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
    else if (message.kind === 'stop') setTimeout(() => send({ v: 1, kind: 'stopped' }), ${saveMs})
  }
}
`

describe('sandboxed plugins as workers', () => {
  it('opens a plugin\'s worker host page in a hidden window of its own', async () => {
    const dataDir = await dataWith({ hello: lifecycle() })
    const app = await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'hello' }))
    const page = await workersPage(app, 'hello')
    expect(page.workers()).toHaveLength(1)
    expect((await visibleWindows(app)).filter(url => url.startsWith('hetu://workers/'))).toEqual([])
  })

  it('keeps two community plugins in renderers of their own, so one renderer dying leaves the other plugin up', async () => {
    const dataDir = await dataWith({ one: lifecycle(), two: lifecycle() })
    const app = await launch(dataDir)
    await until(async () => await logged(dataDir, 'plugin.started', { plugin: 'one' }) && await logged(dataDir, 'plugin.started', { plugin: 'two' }))
    const pids = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter(window => window.webContents.getURL().startsWith('hetu://workers/'))
      .map(window => window.webContents.getOSProcessId()))
    expect(new Set(pids).size).toBe(2)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'hetu://workers/?for=one')?.webContents.forcefullyCrashRenderer()
    })
    await until(() => logged(dataDir, 'renderer.gone', { plugins: 'one' }))
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await logged(dataDir, 'plugin.crashed', { plugin: 'two' })).toBe(false)
    expect((await workersPage(app, 'two')).workers()).toHaveLength(1)
  })

  it('starts an approved folder plugin as a worker that reaches ready, then stops it at Quit while its worker still runs', async () => {
    const dataDir = await dataWith({ hello: lifecycle('', 300) })
    const app = await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'hello' }))
    const done = exited(app)
    await app.close()
    expect(await done).toBe(0)
    const all = await records(dataDir)
    const stopping = all.findIndex(record => record.event === 'core.stopping')
    const stopped = all.findIndex(record => record.event === 'plugin.stopped' && record.plugin === 'hello')
    expect(stopping).toBeGreaterThan(-1)
    expect(stopped).toBeGreaterThan(stopping)
    expect(all[stopped]).toMatchObject({ reason: 'shutdown' })
    // It saved and answered its stop well inside the 3 s grace, which only a worker still running can do
    expect(at(all[stopped]) - at(all[stopping])).toBeGreaterThanOrEqual(250)
    expect(at(all[stopped]) - at(all[stopping])).toBeLessThan(1500)
  })
  it('marks a hung worker unresponsive, then stops it at Quit once its grace runs out', async () => {
    const hangs = `
      self.onmessage = event => {
        const port = event.ports[0]
        port.onmessage = ({ data }) => {
          const message = JSON.parse(data)
          if (message.kind === 'init') port.postMessage(JSON.stringify({ v: 1, kind: 'ready' }))
          else if (message.kind === 'ping') for (;;) {}
        }
      }
    `
    const dataDir = await dataWith({ stuck: hangs }, { heartbeatMs: 200, stopGraceMs: 600 })
    const app = await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.unresponsive', { plugin: 'stuck' }))
    const done = exited(app)
    await app.close()
    expect(await done).toBe(0)
    const all = await records(dataDir)
    const stopping = all.find(record => record.event === 'core.stopping')!
    const stopped = all.find(record => record.event === 'plugin.stopped' && record.plugin === 'stuck')!
    expect(stopped).toMatchObject({ reason: 'shutdown' })
    expect(at(stopped) - at(stopping)).toBeGreaterThanOrEqual(550)
  })

  it('ends a community plugin\'s worker that hangs before ready by closing its renderer, a second after its crash', async () => {
    const spins = 'setTimeout(() => { for (;;) {} }, 300)'
    const dataDir = await dataWith({ spins }, { readyMs: 1500 })
    const app = await launch(dataDir)
    const page = await workersPage(app, 'spins')
    await until(() => page.workers().length === 1)
    let closedAt = 0
    page.workers()[0].on('close', () => {
      closedAt = Date.now()
    })
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'spins', reason: 'start-timeout' }))
    await until(() => closedAt > 0, 5000)
    const crashed = (await records(dataDir)).find(record => record.event === 'plugin.crashed' && record.plugin === 'spins')!
    expect(closedAt - at(crashed)).toBeLessThan(1500)
  })

  it('ends a first-party worker that hangs before ready with terminate(), its shared renderer running on', async () => {
    // git ships in this install as a first-party copy, so it runs in the renderer the first-party plugins share, which
    // stays open. Chromium forces a busy worker's end about 2 s after terminate()
    const installDir = await temp()
    await writeInstall(installDir, { git: { files: filesFor(workerManifest('git'), { 'worker.js': 'setTimeout(() => { for (;;) {} }, 300)' }), firstParty: true } })
    const dataDir = await dataWith({}, { readyMs: 1500 })
    const app = await launch(dataDir, { HETU_INSTALL_DIR: installDir })
    const page = await workersPage(app, 'first-party')
    await until(() => page.workers().length === 1)
    let closed = false
    page.workers()[0].on('close', () => {
      closed = true
    })
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'git', reason: 'start-timeout' }))
    await until(() => closed, 3500)
    expect(page.isClosed()).toBe(false)
  })

  it('records a renderer that crashed, with the plugins it held, and each of their workers as crashed', async () => {
    const dataDir = await dataWith({ hello: lifecycle() })
    const app = await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'hello' }))
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'hetu://workers/?for=hello')?.webContents.forcefullyCrashRenderer()
    })
    await until(() => logged(dataDir, 'renderer.gone', { plugins: 'hello' }))
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'hello', reason: 'closed' }))
  })

  it('reads a worker that closes itself as crashed, since its port closes with it', async () => {
    const dataDir = await dataWith({ quits: lifecycle('setTimeout(() => self.close(), 100)') })
    await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'quits', reason: 'closed' }))
  })

  it('has the relay cut off a worker that floods, before main reads its messages', async () => {
    const dataDir = await dataWith({ floods: lifecycle('for (let i = 0; i < 200000; i++) send({ v: 1, kind: "pong" })') })
    const app = await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'floods', reason: 'flood' }))
    expect(await app.evaluate(() => 1)).toBe(1)
  })
})
