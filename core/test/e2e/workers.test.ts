import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, dataWith, exited, launch, logged, records, until, visibleWindows, workersPage } from './helpers.ts'

afterEach(cleanup)

const at = (record: Record<string, unknown>) => Date.parse(record.at as string)

// A worker that speaks the lifecycle on the port the page hands it, the way the SDK will. after runs once it is ready.
// It answers a stop after saveMs, as a plugin saving its state would
const lifecycle = (after = '', saveMs = 0) => `
self.onmessage = event => {
  const port = event.ports[0]
  self.onmessage = null
  port.onmessage = ({ data }) => {
    if (data.kind === 'init') {
      port.postMessage({ v: 1, kind: 'ready' })
      ${after}
    }
    else if (data.kind === 'ping') port.postMessage({ v: 1, kind: 'pong' })
    else if (data.kind === 'stop') setTimeout(() => port.postMessage({ v: 1, kind: 'stopped' }), ${saveMs})
  }
}
`

describe('sandboxed plugins as workers', () => {
  it('opens the worker host page in a hidden window', async () => {
    const app = await launch(await dataWith({}))
    const page = await workersPage(app)
    expect(page.url()).toBe('hetu://workers/')
    expect(await visibleWindows(app)).not.toContain('hetu://workers/')
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
          if (data.kind === 'init') port.postMessage({ v: 1, kind: 'ready' })
          else if (data.kind === 'ping') for (;;) {}
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

  it('ends a worker that hangs before ready with terminate() at its ready deadline, while its page runs on', async () => {
    const spins = 'setTimeout(() => { for (;;) {} }, 300)'
    const dataDir = await dataWith({ spins }, { readyMs: 1500 })
    const app = await launch(dataDir)
    const page = await workersPage(app)
    await until(() => page.workers().length === 1)
    let closed = false
    page.workers()[0].on('close', () => {
      closed = true
    })
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'spins', reason: 'start-timeout' }))
    await until(() => closed, 5000)
    expect(page.isClosed()).toBe(false)
    expect(page.workers()).toHaveLength(0)
  })

  it('records a renderer that crashed, with the plugins it held, and each of their workers as crashed', async () => {
    const dataDir = await dataWith({ hello: lifecycle() })
    const app = await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'hello' }))
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'hetu://workers/')?.webContents.forcefullyCrashRenderer()
    })
    await until(() => logged(dataDir, 'renderer.gone', { plugins: 'hello' }))
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'hello', reason: 'closed' }))
  })

  it('reads a worker that closes itself as crashed, since its port closes with it', async () => {
    const dataDir = await dataWith({ quits: lifecycle('setTimeout(() => self.close(), 100)') })
    await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'quits', reason: 'closed' }))
  })
})
