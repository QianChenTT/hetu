import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../loader-fakes.ts'

export const repo = path.join(import.meta.dirname, '..', '..', '..')
export const electronPath = createRequire(import.meta.url)('electron') as string
// A packed build to drive in place of the source, packaged and not locked, from npm run test:e2e:packaged
export const drivenApp = process.env.HETU_E2E_APP
// How a test starts hetu itself: the packed build with nothing after its name, or electron with the repo
export const appCommand: [string, string[]] = drivenApp === undefined ? [electronPath, [repo]] : [drivenApp, []]
// Ubuntu 24.04 keeps unprivileged user namespaces from Chromium's sandbox, so a start on Linux goes without it, as
// Playwright's own starts do there
export const sandboxArgs = process.platform === 'linux' ? ['--no-sandbox'] : []

const running: ElectronApplication[] = []
const made: string[] = []
const servers: Server[] = []

// For each file's afterEach
export async function cleanup(): Promise<void> {
  // Playwright refuses process() once an app was closed, and close() on a closed one only throws
  for (const app of running.splice(0)) await app.close().catch(() => {})
  for (const server of servers.splice(0)) server.close()
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
}

export async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-e2e-'))
  made.push(dir)
  return dir
}

export function env(extra: Record<string, string>): Record<string, string> {
  const own = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  return { ...Object.fromEntries(own), ...extra }
}

// The built app from the source, as `electron .` starts it, or the packed build HETU_E2E_APP names, on its own data folder, its windows quiet so they take no
// focus from the person at the machine: hidden off every display unless HETU_QUIET_WINDOWS says otherwise, where 1 shows
// them on another display for a person who wants to watch. extra holds more environment, an
// install folder of the test's own among it
// switches are Chromium's, placed before the app
export async function launch(dataDir: string, extra: Record<string, string> = {}, switches: string[] = []): Promise<ElectronApplication> {
  const environment = env({ HETU_DATA_DIR: dataDir, HETU_QUIET_WINDOWS: process.env.HETU_QUIET_WINDOWS ?? 'hidden', ...extra })
  const app = await (drivenApp === undefined
    ? electron.launch({ args: [...switches, repo], env: environment })
    : electron.launch({ executablePath: drivenApp, args: switches, env: environment }))
  running.push(app)
  return app
}

export const exists = (file: string) => stat(file).then(() => true, () => false)
export const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function until(check: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  for (let waited = 0; !(await check()); waited += 50) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(50)
  }
}

// A page by its URL, once the app has opened it. The hidden renderer is a window too
export async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  let found: Page | undefined
  await until(() => {
    found = app.windows().find(page => page.url() === url)
    return found !== undefined
  })
  await found!.waitForLoadState()
  return found!
}

// The editor once its window shows, which waits for its first paint and can come after its page loaded
export async function editorPage(app: ElectronApplication): Promise<Page> {
  const page = await pageAt(app, 'hetu://editor/')
  await until(async () => (await visibleWindows(app)).includes('hetu://editor/'))
  return page
}
// A plugin's worker host page: each community plugin has a renderer of its own and the first-party plugins share one
export const workersPage = (app: ElectronApplication, group: string) => pageAt(app, `hetu://workers/?for=${encodeURIComponent(group)}`)

// The windows a human sees, by URL
export const visibleWindows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().filter(window => window.isVisible()).map(window => window.webContents.getURL()))

// The event log's whole lines, each record with its fields
export async function records(dataDir: string): Promise<Record<string, unknown>[]> {
  let text = ''
  try {
    text = await readFile(path.join(dataDir, 'events', 'events-1.jsonl'), 'utf8')
  } catch {
    return []
  }
  return text.split('\n').slice(0, -1).map(line => JSON.parse(line) as Record<string, unknown>)
}

export const events = async (dataDir: string) => (await records(dataDir)).map(record => record.event)

// Whether the log holds a record of event whose fields include these
export const logged = async (dataDir: string, event: string, fields: Record<string, unknown> = {}) =>
  (await records(dataDir)).some(record => record.event === event && Object.entries(fields).every(([name, value]) => record[name] === value))

// A local server counting each request, standing in for the network
export async function counting(): Promise<{ url: string, hits: () => number }> {
  let hits = 0
  const server = createServer((_request, response) => {
    hits++
    response.end('reached')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}/`, hits: () => hits }
}

export function exited(app: ElectronApplication): Promise<number | null> {
  return new Promise(resolve => app.process().once('exit', code => resolve(code)))
}

// A data folder holding approved folder plugins, each a worker running the source given, and the human's limits for
// all plugins
export async function dataWith(workers: Record<string, string>, limits: Record<string, number> = {}): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), limits: { all: limits, plugins: {} } })
  for (const [id, code] of Object.entries(workers)) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id), { 'worker.js': code }))
    await store.writePlugin(id, await entryFor(root))
  }
  return dataDir
}
