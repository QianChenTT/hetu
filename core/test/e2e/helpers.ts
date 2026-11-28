import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { quiet, standIns } from '../drive.ts'

export const repo = path.join(import.meta.dirname, '..', '..', '..')
export const electronPath = createRequire(import.meta.url)('electron') as string
// A packed build to drive in place of the source, packaged and not locked, from npm run test:e2e:packaged
export const drivenApp = process.env.HETU_E2E_APP
// How a test starts hetu itself: the packed build with nothing after its name, or electron with the repo
export const appCommand: [string, string[]] = drivenApp === undefined ? [electronPath, [repo]] : [drivenApp, []]
// Ubuntu 24.04 keeps unprivileged user namespaces from Chromium's sandbox, so a start on Linux goes without it, as
// Playwright's own starts do there
export const sandboxArgs = process.platform === 'linux' ? ['--no-sandbox'] : []

// A plugin listing every note as a row carrying it, in a view, so a test opens a note as the human does: a click on its
// row. Views draw with no layout too
const OPENER_ID = 'note-list'
const openerCode = (sdk: string) => `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const instances = new Set<string>()
    const draw = async () => {
      const paths: string[] = []
      let after: string | undefined
      for (;;) {
        const page = await ctx.luoshu.list(after === undefined ? {} : { after })
        paths.push(...page.paths)
        if (page.next === null) break
        after = page.next
      }
      const tree = { kind: 'box', id: 'root', children: paths.map((path, at) => ({ kind: 'button', id: 'n' + at, text: path, drag: { type: 'note', value: path } })) }
      for (const instance of instances) await ctx.ui.views.draw(instance, tree).catch(() => {})
    }
    ctx.ui.on('view.opened', event => {
      instances.add(event.instance)
      void draw().catch(() => {})
    })
    void ctx.events.on(['luoshu.changed', 'luoshu.outside'], () => void draw().catch(() => {})).catch(() => {})
  },
})
`
let openerBuilt: string | null = null

// The opener approved in a data folder, before hetu starts on it
export async function writeOpener(dataDir: string): Promise<void> {
  if (openerBuilt === null) {
    const source = await temp()
    const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')
    await writeFolder(source, { 'src/worker.ts': openerCode(sdk) })
    const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
    openerBuilt = built!.text
  }
  const granted = [
    { type: 'ui.view' as const }, { type: 'luoshu.list' as const, paths: ['**'] },
    { type: 'events.subscribe' as const, topics: ['luoshu.changed', 'luoshu.outside'] },
  ]
  const root = path.join(dataDir, 'plugins', OPENER_ID)
  await writeFolder(root, filesFor(workerManifest(OPENER_ID, { capabilities: granted, views: { notes: { title: 'Notes', kind: 'view' } } }), { 'worker.js': openerBuilt }))
  await writeApproved(new StateStore(dataDir), OPENER_ID, root, { granted })
}

// Opens a note through the opener's row, a click as the human makes, then waits for it in the bar
export async function openByHand(editor: Page, name: string): Promise<void> {
  const row = editor.locator('#editors').getByRole('button', { name, exact: true })
  await until(async () => (await row.count()) === 1 && await row.isVisible())
  await row.click()
  await until(async () => (await editor.locator('#title').innerText()).startsWith(name))
}

// A set-up hetu: an approved plugin holding nothing that answers the lifecycle and never draws. A plugin installed ends
// the startup flow, so the trusted window opens only when asked
const QUIET = `
self.onmessage = event => {
  const port = event.ports[0]
  self.onmessage = null
  const send = message => port.postMessage(JSON.stringify(message))
  port.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.kind === 'init') send({ v: 1, kind: 'ready' })
    else if (message.kind === 'ping') send({ v: 1, kind: 'pong' })
    else if (message.kind === 'stop') send({ v: 1, kind: 'stopped' })
  }
}
`
export async function setUp(dataDir: string): Promise<void> {
  const root = path.join(dataDir, 'plugins', 'quiet')
  await writeFolder(root, filesFor(workerManifest('quiet', { capabilities: [] }), { 'worker.js': QUIET }))
  await writeApproved(new StateStore(dataDir), 'quiet', root, { granted: [] })
}

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
// focus from the person at the machine: hidden and never the active app unless HETU_QUIET_WINDOWS is exactly 1, which
// shows them on another display for a person who wants to watch. extra holds more environment, an
// install folder of the test's own among it
// switches are Chromium's, placed before the app. takesFocus leaves the app free to become the active one and its
// windows to take the mouse, for a test of real focus that runs only when the screen is free for it
export async function launch(
  dataDir: string, extra: Record<string, string> = {}, switches: string[] = [], options: { takesFocus?: boolean } = {},
): Promise<ElectronApplication> {
  // A run from the source loads fail-fast.cjs first, so main throwing ends the run instead of opening a dialog on the
  // desktop. A packed build takes no NODE_OPTIONS
  const failFast: Record<string, string> = drivenApp === undefined ? { NODE_OPTIONS: `--require=${JSON.stringify(path.join(import.meta.dirname, 'fail-fast.cjs'))}` } : {}
  const environment = env({ HETU_DATA_DIR: dataDir, HETU_QUIET_WINDOWS: process.env.HETU_QUIET_WINDOWS === '1' ? '1' : 'hidden', ...failFast, ...extra })
  const app = await (drivenApp === undefined
    ? electron.launch({ args: [...switches, repo], env: environment })
    : electron.launch({ executablePath: drivenApp, args: switches, env: environment }))
  running.push(app)
  // An app some tests start to see it quit at once has no windows left to keep quiet, so a failure is told, not thrown
  if (environment.HETU_QUIET_WINDOWS === 'hidden' && options.takesFocus !== true) {
    // What the quiet launch stands in for, said in the test's output as it happens
    app.on('console', message => {
      if (message.text().startsWith('quiet launch: ')) console.log(message.text())
    })
    await quiet(app).then(() => standIns(app)).catch((err: unknown) => console.warn(`the quiet launch was not applied: ${String(err)}`))
  }
  return app
}

export const exists = (file: string) => stat(file).then(() => true, () => false)
export const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function until(check: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
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
// A plugin's worker host page, each plugin in a renderer of its own
export const workersPage = (app: ElectronApplication, id: string) => pageAt(app, `hetu://workers/?for=${encodeURIComponent(id)}`)

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
    await writeApproved(store, id, root)
  }
  return dataDir
}
