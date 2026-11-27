// One tier 0 instance: the driven build on a data folder and a notes folder of its own, the shipped plugins of a
// profile in it, launched out of the person's way, traced, quit and recorded. The record says only what happened
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright'
import type { TestContext } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { executableIn } from '../../build/package.ts'
import { unpackZip } from '../../backend/plugins-manager/unpack.ts'
import { quiet, stubPicker, type Quieted } from '../drive.ts'
import { writeApproved } from '../plugins-manager-fakes.ts'
import { takeLock } from './lock.ts'
import { waitForMemory } from './memory.ts'
import { drivenOutDir, pluginsProvenance, readBuildStamp, type BuildStamp, type PluginsProvenance } from './provenance.ts'

export const repo = path.join(import.meta.dirname, '..', '..', '..')

// Below this much memory free, a new Electron and its renderers would push the machine into swap
export const MIN_FREE_GB = 1.5

export const pluginsDir = () => process.env.HETU_PLUGINS_DIR ?? path.join(os.homedir(), 'code', 'hetu-plugins')
export const pluginsZip = () => process.env.HETU_PLUGINS_ZIP ?? path.join(pluginsDir(), 'release', 'hetu-plugins.zip')
// Where npm run tier0 packs and stamps the driven build
export const drivenOut = () => path.join(repo, 'dist-package', 'driven')
export const drivenApp = () => executableIn(drivenOutDir(drivenOut()))

// Which shipped plugins an instance holds. Every one but mcp by default, since mcp binds the door's fixed port and
// pipe and two instances holding it clash. A profile with mcp runs one at a time
export type Profile = { name: string, plugins: 'all-but-mcp' | readonly string[] }
export const profiles = {
  shipped: { name: 'shipped', plugins: 'all-but-mcp' },
  door: { name: 'door', plugins: ['file-explorer', 'mcp'] },
  bare: { name: 'bare', plugins: [] },
} as const satisfies Record<string, Profile>
export const isSerial = (ids: readonly string[]) => ids.includes('mcp')

// How the plugins get in: written approved before the start, as after their Confirm
export type Route = 'approved'

// Locks every tier 0 process sees. Starts go one at a time, so each reads free memory after the instance before it
// is up, and the door is held by one instance at a time. Both waits end before the test's own timeout
const START_LOCK = path.join(os.tmpdir(), 'hetu-tier0-start.lock')
const DOOR_LOCK = path.join(os.tmpdir(), 'hetu-tier0-door.lock')

export async function runFacts() {
  const stamp = await readBuildStamp(drivenOut())
  return {
    build: { ...stamp, app: drivenApp() },
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    plugins: await pluginsProvenance(pluginsDir(), pluginsZip()),
  }
}
export type RunFacts = { build: BuildStamp & { app: string }, os: { platform: string, release: string, arch: string }, plugins: PluginsProvenance }

export type Options = {
  profile?: Profile
  route?: Route
  // Files of a notes folder written fresh for this instance, else an empty one
  notes?: Record<string, string>
  // The run's facts when a caller already read them, so a run of many instances hashes the zip once
  facts?: RunFacts
  // Stand-ins for the memory reading and how long to wait for memory, for the gate's own test
  free?: () => number
  memoryWaitMs?: number
}

export type RunRecord = {
  instance: string
  profile: string
  serial: boolean
  build: RunFacts['build']
  os: RunFacts['os']
  // The input routes this instance was driven through
  input: string[]
  // What a page's focus reads as at the quit: emulated when the editor page has it and no window does natively
  focus: 'emulated' | 'native' | 'none' | 'unknown'
  quiet: Quieted
  plugins: PluginsProvenance & { ids: string[], folders: string[], installed: { route: Route, zip: string, sha256: string } }
  launchMs: number
  quitMs: number | null
  exitCode: number | null
  trace: string | null
}

export type Instance = {
  app: ElectronApplication
  folder: string
  data: string
  notes: string
  ids: string[]
  editor(): Promise<Page>
  trusted(): Promise<Page>
  // A click through Playwright, recorded as such
  click(target: Locator): Promise<void>
  // Main's open dialog answering with picked from now on. focusTrusted as a real picker's close does
  picker(picked: string | null, options?: { focusTrusted?: boolean }): Promise<void>
  quit(): Promise<RunRecord>
}

// Starts an instance inside a test. Its cleanup is set before anything else can fail: the app quit, the locks freed,
// a passed instance's folders removed and a failed one's trace and folders kept. Under the memory floor it waits, then
// skips the test saying so
export async function start(context: TestContext, options: Options = {}): Promise<Instance> {
  const profile = options.profile ?? profiles.shipped
  const kept = process.env.HETU_TIER0_RUN || undefined
  const folder = await mkdtemp(kept === undefined ? path.join(os.tmpdir(), `hetu-tier0-${profile.name}-`) : path.join(kept, `${profile.name}-`))
  const data = path.join(folder, 'data')
  const notes = path.join(folder, 'notes')
  const unpacked = path.join(folder, 'unpacked')
  const tracePath = path.join(folder, 'trace.zip')
  const held: { app: ElectronApplication | null, quit: (() => Promise<RunRecord>) | null, releases: (() => Promise<void>)[] } = { app: null, quit: null, releases: [] }
  context.onTestFinished(async ({ task }) => {
    const state = task.result?.state
    try {
      if (held.quit !== null) await held.quit()
      else await held.app?.close()
    } finally {
      for (const release of held.releases.splice(0)) await release()
      await rm(unpacked, { recursive: true, force: true })
      if (state === 'fail') console.warn(`tier 0 kept the failed instance's trace and folders in ${folder}`)
      else if (kept === undefined) await rm(folder, { recursive: true, force: true, maxRetries: 5 })
      else {
        for (const done of [tracePath, data, notes]) await rm(done, { recursive: true, force: true, maxRetries: 5 })
        const recorded = path.join(folder, 'record.json')
        const record = await readFile(recorded, 'utf8').then(text => JSON.parse(text) as RunRecord, () => null)
        if (record !== null) await writeFile(recorded, `${JSON.stringify({ ...record, trace: null }, null, 2)}\n`)
      }
    }
  })

  const releaseStart = await takeLock(START_LOCK, { signal: context.signal, ms: 60_000 })
  held.releases.push(releaseStart)
  const memory = await waitForMemory({ free: options.free, floor: MIN_FREE_GB, waitMs: options.memoryWaitMs ?? 20_000 })
  if (!memory.ok) {
    const reason = `skipped for memory: ${memory.free.toFixed(2)} GB free, under the ${MIN_FREE_GB} GB an instance needs`
    await writeFile(path.join(folder, 'skipped.json'), `${JSON.stringify({ reason }, null, 2)}\n`)
    context.skip(reason)
  }

  const facts = options.facts ?? await runFacts()
  const route = options.route ?? 'approved'
  await mkdir(unpacked)
  const staged = await unpackZip(await readFile(facts.plugins.zip), unpacked)
  if (staged.problem !== null) throw new Error(`the plugin zip didn't unpack: ${staged.problem}`)
  const inZip = (await readdir(unpacked)).sort()
  const ids = profile.plugins === 'all-but-mcp' ? inZip.filter(id => id !== 'mcp') : [...profile.plugins].sort()
  const missing = ids.filter(id => !inZip.includes(id))
  if (missing.length > 0) throw new Error(`the plugin zip has no ${missing.join(', ')}`)
  const installed = { route, zip: facts.plugins.zip, sha256: facts.plugins.sha256 }

  await mkdir(notes, { recursive: true })
  for (const [name, text] of Object.entries(options.notes ?? {})) {
    await mkdir(path.dirname(path.join(notes, name)), { recursive: true })
    await writeFile(path.join(notes, name), text)
  }
  const store = new StateStore(data)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder: notes })
  for (const id of ids) await writeShipped(store, data, path.join(unpacked, id), id)
  if (isSerial(ids)) held.releases.push(await takeLock(DOOR_LOCK, { signal: context.signal, ms: 90_000 }))

  const input = new Set<string>()
  let tracing = false
  let record: RunRecord | null = null
  const begun = Date.now()
  const app = await electron.launch({ executablePath: facts.build.app, args: [], env: { ...processEnv(), HETU_DATA_DIR: data, HETU_QUIET_WINDOWS: 'hidden' } })
  held.app = app
  const launched = Date.now()
  // The first call into main, before anything can bring a window forward
  const quieted = await quiet(app)

  held.quit = async () => {
    if (record !== null) return record
    let focus: RunRecord['focus'] = 'unknown'
    let quitMs: number | null = null
    let exitCode: number | null = null
    try {
      focus = await focusNow(app).catch(() => 'unknown' as const)
      if (tracing) await app.context().tracing.stop({ path: tracePath }).catch((err: unknown) => console.warn(`tier 0 lost the trace: ${String(err)}`))
      const exited = new Promise<number | null>(resolve => app.process().once('exit', code => resolve(code)))
      const asked = Date.now()
      // The quit takes main down while the call is out, so its answer never comes
      void app.evaluate(({ app }) => app.quit()).catch(() => {})
      const ended = await Promise.race([exited, sleep(20_000).then(() => 'hung' as const)])
      if (ended === 'hung') await app.close()
      else [quitMs, exitCode] = [Date.now() - asked, ended]
    } finally {
      const folders = (await readdir(path.join(data, 'plugins'), { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
      record = {
        instance: path.basename(folder), profile: profile.name, serial: isSerial(ids), build: facts.build, os: facts.os,
        input: [...input].sort(), focus, quiet: quieted, plugins: { ...facts.plugins, ids, folders, installed },
        launchMs: launched - begun, quitMs, exitCode, trace: tracing ? tracePath : null,
      }
      await writeFile(path.join(folder, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
    }
    return record
  }
  await app.context().tracing.start({ screenshots: true, snapshots: true })
  tracing = true

  const instance: Instance = {
    app, folder, data, notes, ids,
    editor: async () => {
      const page = await pageAt(app, 'hetu://editor/')
      await until(async () => (await visibleUrls(app)).includes('hetu://editor/'), 'the editor window to show')
      return page
    },
    trusted: () => pageAt(app, 'hetu://trusted/'),
    click: async target => {
      input.add('playwright')
      await target.click()
    },
    picker: (picked, pick = {}) => stubPicker(app, picked, pick),
    quit: () => held.quit!(),
  }
  // The next start reads free memory with this instance up
  await instance.editor()
  await releaseStart()
  return instance
}

// A shipped plugin copied into the plugin folder and written approved, its write grants confirmed, as the human's
// Confirm at install and at first use leave it
async function writeShipped(store: StateStore, data: string, from: string, id: string): Promise<void> {
  const root = path.join(data, 'plugins', id)
  await cp(from, root, { recursive: true })
  const manifest = JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')) as { version: string, capabilities: { type: string }[] }
  const writes = manifest.capabilities.filter(grant => grant.type === 'luoshu.write')
  await writeApproved(store, id, root, { granted: manifest.capabilities as never, version: manifest.version, firstUse: [], confirmed: writes as never })
}

// Whether the editor page has focus and whether any window has it natively
async function focusNow(app: ElectronApplication): Promise<RunRecord['focus']> {
  const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isFocused()))
  if (native) return 'native'
  const page = app.windows().find(found => found.url() === 'hetu://editor/')
  return page !== undefined && await page.evaluate(() => document.hasFocus()) ? 'emulated' : 'none'
}

// Watches which app is frontmost, every 100 ms through the OS, so a run can say hetu never took the person's focus.
// macOS only, elsewhere it watches nothing
export function watchFrontmost(): { stop(): Promise<{ samples: number, pids: number[] }> } {
  if (process.platform !== 'darwin') return { stop: async () => ({ samples: 0, pids: [] }) }
  const script = `ObjC.import('AppKit')
function run() {
  for (;;) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1))
    console.log($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)
  }
}`
  // JXA's console.log writes to stderr
  const poll = spawn('osascript', ['-l', 'JavaScript', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
  let text = ''
  poll.stderr.on('data', chunk => { text += String(chunk) })
  return {
    stop: async () => {
      poll.kill()
      await new Promise(resolve => poll.once('exit', resolve))
      const pids = text.split('\n').filter(line => /^\d+$/.test(line)).map(Number)
      return { samples: pids.length, pids: [...new Set(pids)] }
    },
  }
}

const processEnv = () => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function until(check: () => Promise<boolean> | boolean, what: string, ms = 30_000): Promise<void> {
  for (let waited = 0; !(await check()); waited += 50) {
    if (waited > ms) throw new Error(`waited ${ms / 1000} s for ${what}`)
    await sleep(50)
  }
}

async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  let found: Page | undefined
  await until(() => (found = app.windows().find(page => page.url() === url)) !== undefined, url)
  await found!.waitForLoadState()
  return found!
}

const visibleUrls = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().filter(window => window.isVisible()).map(window => window.webContents.getURL()))
