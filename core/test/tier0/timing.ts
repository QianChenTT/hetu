// Tier 0's timing: how long hetu takes to start, to draw the first note and to quit on the driven build, read from the
// app's own clocks (the event log's at stamps, main's and the pages' Date.now) and checked against a baseline
import { execFileSync, type ChildProcess } from 'node:child_process'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import type { TestContext } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { DRAFT_GRACE_MS } from '../../backend/runtime/quit.ts'
import { quiet, type Quieted } from '../drive.ts'
import { writeApproved } from '../plugins-manager-fakes.ts'
import { drivenApp, pageAt, processEnv, sleep, START_LOCK, until } from './instance.ts'
import { takeLock } from './lock.ts'
import { freeGb } from './memory.ts'

// Each measure, where it starts and ends and what it takes in. Every start measure begins at main's first log record,
// so Electron's own process start and Playwright's attach before main's code runs are left out. A log stamp is taken
// when the log's writer starts the record's batch, after any wait in its queue, so a long queue moves it later than
// the event. editor reads main's own clock at both ends for that reason
export const MEASURES = {
  ready: 'first boot.check stamp to the core.ready stamp: boot checks, the core modules and every plugin started',
  shown: 'first boot.check stamp to main calling show or showInactive on the editor window, read in main',
  editor: 'the editor window made, which main does once the core started, to that show call: its page loaded and drawn',
  firstNote: 'pointerdown on the explorer\'s row (the frame\'s clock) to the note\'s text in the shown editor (the page\'s clock)',
  quit: `app.quit() in main (main's clock) to the process exit seen by the test, less the ${DRAFT_GRACE_MS} ms draft grace: core.stopping, windows closed, the process gone`,
} as const
export type Measure = keyof typeof MEASURES
// cold: the first start on a data folder, with no Chromium caches and no earlier log. warm: a restart of the same folder
export type Kind = 'cold' | 'warm'
// The machine as a run found it: free memory, the 1 minute load average and other hetu or Electron main processes
export type Machine = { freeGb: number, load: number, others: number }
export type Sample = { kind: Kind, ms: Record<Measure, number>, quitTotalMs: number, stoppingMs: number, before: Machine, after: Machine, othersRose: boolean }

// How a timed run is driven, for its record: the input it took, what the harness did beyond a person's run and how the
// windows were shown
export const DRIVEN = {
  input: ['playwright'],
  harness: [
    'wrapped show and showInactive in main to time the editor window\'s show',
    'a pointerdown listener in the explorer frame and a MutationObserver in the editor page to time the first note',
  ],
  windows: 'hidden: HETU_QUIET_WINDOWS=hidden, shown inactive at zero opacity',
} as const

// A notes folder of 61 notes, Welcome at the top and 20 in each of 3 folders, until the seed folder lands
export function notesFolder(): Record<string, string> {
  const notes: Record<string, string> = { 'Welcome.md': '# Welcome\n\nStart here.\n' }
  for (const folder of ['Projects', 'Journal', 'Reading']) {
    for (let index = 1; index <= 20; index++) notes[`${folder}/${folder} ${index}.md`] = `# ${folder} ${index}\n\n${'Some text. '.repeat(40)}\n`
  }
  return notes
}

// A data folder as start() leaves it before its launch: switches, the luoshu on notes and every plugin under unpacked
// written approved with its write grants confirmed
export async function prepare(data: string, notes: string, unpacked: string, ids: readonly string[], files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(notes, name)), { recursive: true })
    await writeFile(path.join(notes, name), text)
  }
  const store = new StateStore(data)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder: notes })
  for (const id of ids) {
    const root = path.join(data, 'plugins', id)
    await cp(path.join(unpacked, id), root, { recursive: true })
    const manifest = JSON.parse(await readFile(path.join(root, 'hetu-plugin.json'), 'utf8')) as { version: string, capabilities: { type: string }[] }
    const writes = manifest.capabilities.filter(grant => grant.type === 'luoshu.write')
    await writeApproved(store, id, root, { granted: manifest.capabilities as never, version: manifest.version, firstUse: [], confirmed: writes as never })
  }
}

const machineNow = (): Machine => ({ freeGb: freeGb(), load: os.loadavg()[0]!, others: othersRunning() })

// One timed start, first note and quit of the driven build on data. Opens the note whose explorer row reads row and
// waits for text in the editor. No trace, since its screenshots and snapshots load the renderer being timed. Holds the
// machine-wide start lock from the launch until the editor shows, so no other tier 0 start overlaps the start being
// timed. The test's cleanup closes or kills the app too, since a timed out test never reaches the finally
export async function timedRun(context: TestContext, data: string, kind: Kind, row: string, text: string): Promise<{ sample: Sample, quiet: Quieted }> {
  const before = machineNow()
  let release: (() => Promise<void>) | null = await takeLock(START_LOCK, { signal: context.signal, ms: 60_000 })
  const unlock = async () => {
    const held = release
    release = null
    await held?.()
  }
  context.onTestFinished(unlock)
  const begun = Date.now()
  let app: ElectronApplication
  try {
    app = await electron.launch({ executablePath: drivenApp(), args: [], env: { ...processEnv(), HETU_DATA_DIR: data, HETU_QUIET_WINDOWS: 'hidden' } })
  } catch (err) {
    await unlock()
    throw err
  }
  // Read once: Playwright's process() throws once the app's connection is gone
  const child = app.process()
  const exit = new Promise<number>(resolve => child.once('exit', () => resolve(Date.now())))
  context.onTestFinished(() => closeOrKill(app, child))
  try {
    const quieted = await quiet(app)
    // Main runs this before its first window exists, so the editor's first show is caught in any build
    await app.evaluate(({ app, BrowserWindow }) => {
      const created = new Map<number, number>()
      app.on('browser-window-created', (_event, window) => created.set(window.id, Date.now()))
      const at = globalThis as unknown as { tier0Shown?: { made: number, shown: number } }
      for (const name of ['show', 'showInactive'] as const) {
        const original = BrowserWindow.prototype[name]
        BrowserWindow.prototype[name] = function (this: InstanceType<typeof BrowserWindow>) {
          if (at.tier0Shown === undefined && this.webContents.getURL() === 'hetu://editor/') at.tier0Shown = { made: created.get(this.id)!, shown: Date.now() }
          return original.call(this)
        }
      }
    })
    const shownAt = async () => await app.evaluate(() => (globalThis as unknown as { tier0Shown?: { made: number, shown: number } }).tier0Shown) ?? null
    await until(async () => await shownAt() !== null, 'the editor window shown')
    await unlock()
    const { made, shown } = (await shownAt())!
    const firstNote = await openFirstNote(await pageAt(app, 'hetu://editor/'), row, text)
    const stamps = await logStamps(data, begun, ['boot.check', 'core.ready'])
    const asked = await app.evaluate(({ app }) => {
      const at = Date.now()
      setTimeout(() => app.quit(), 0)
      return at
    })
    let timer: NodeJS.Timeout | undefined
    const ended = await Promise.race([exit, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 20_000) })])
    clearTimeout(timer)
    if (ended === null) {
      child.kill('SIGKILL')
      throw new Error(`the quit took over 20 s and the app was killed. The log's last records: ${await lastRecords(data, 6)}`)
    }
    const stopping = await logStamps(data, asked, ['core.stopping'])
    const boot = stamps['boot.check']
    const ms = { ready: stamps['core.ready'] - boot, shown: shown - boot, editor: shown - made, firstNote, quit: ended - asked - DRAFT_GRACE_MS }
    const bad = Object.entries(ms).filter(([, value]) => !(Number.isFinite(value) && value > 0))
    if (bad.length > 0) throw new Error(`a ${kind} run timed ${bad.map(([name, value]) => `${name} at ${value} ms`).join(', ')}, not times above 0`)
    const after = machineNow()
    return { sample: { kind, ms, quitTotalMs: ended - asked, stoppingMs: stopping['core.stopping'] - asked, before, after, othersRose: after.others > before.others }, quiet: quieted }
  } finally {
    await unlock()
    await closeOrKill(app, child)
  }
}

// Playwright's close() asks main for app.quit() and waits for the process to exit with no limit of its own, so a quit
// that hangs would hold it forever. It gets 10 s, then the process is killed
export async function closeOrKill(app: ElectronApplication, child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = await Promise.race([app.close().then(() => true, () => true), sleep(10_000).then(() => false)])
  if (!closed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

// The explorer's row clicked through Playwright, timed from its pointerdown in the frame to the text in the editor.
// The text must not be in the editor before the click, or the click would time nothing
async function openFirstNote(editor: Page, row: string, text: string): Promise<number> {
  const explorer = () => editor.frames().find(frame => frame.url().includes('file-explorer.views'))
  await until(() => explorer() !== undefined, 'the explorer frame')
  const target = explorer()!.locator('[role=treeitem]', { hasText: row }).first()
  await until(async () => await target.count() === 1, `the ${row} row`)
  const already = await editor.evaluate(text => {
    const at = globalThis as unknown as { tier0Drawn?: number }
    const seen = () => document.querySelector('#editors > .editor:not([hidden]) .cm-content')?.textContent?.includes(text) === true
    if (seen()) return true
    new MutationObserver((_records, observer) => {
      if (!seen()) return
      at.tier0Drawn = Date.now()
      observer.disconnect()
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    return false
  }, text)
  if (already) throw new Error(`${row}'s text was in the editor before its row was clicked`)
  await explorer()!.evaluate(() => document.addEventListener('pointerdown', () => {
    (globalThis as unknown as { tier0Down?: number }).tier0Down ??= Date.now()
  }, { capture: true }))
  await target.click()
  const drawn = () => editor.evaluate(() => (globalThis as unknown as { tier0Drawn?: number }).tier0Drawn ?? null)
  await until(async () => await drawn() !== null, `${row}'s text in the editor`)
  const down = await explorer()!.evaluate(() => (globalThis as unknown as { tier0Down?: number }).tier0Down ?? null)
  if (down === null) throw new Error('the click never reached the explorer frame as a pointerdown')
  return (await drawn())! - down
}

async function readRecords(data: string): Promise<{ at: string, event: string }[]> {
  const folder = path.join(data, 'events')
  const records: { at: string, event: string }[] = []
  for (const file of (await readdir(folder).catch(() => [])).sort()) {
    for (const line of (await readFile(path.join(folder, file), 'utf8')).split('\n')) if (line !== '') records.push(JSON.parse(line) as { at: string, event: string })
  }
  return records
}

// The last count records of the log, each its stamp and event, for a quit that hung
export const lastRecords = async (data: string, count: number) => (await readRecords(data)).slice(-count).map(record => `${record.at} ${record.event}`).join(', ')

// The at stamp of each event's first record at or after since, waiting for the log to hold them all
export async function logStamps<E extends string>(data: string, since: number, events: readonly E[]): Promise<Record<E, number>> {
  const found: Partial<Record<E, number>> = {}
  await until(async () => {
    for (const record of await readRecords(data)) {
      const at = Date.parse(record.at)
      if (at >= since && events.includes(record.event as E) && found[record.event as E] === undefined) found[record.event as E] = at
    }
    return events.every(event => found[event] !== undefined)
  }, `${events.join(', ')} in the event log`)
  return found as Record<E, number>
}

// Other hetu or Electron main processes on the machine, which share its CPU with the run being timed
function othersRunning(): number {
  try {
    return execFileSync('ps', ['-Ao', 'comm'], { encoding: 'utf8' }).split('\n').filter(line => /\/MacOS\/(hetu|Electron)$/.test(line.trim())).length
  } catch {
    return -1
  }
}

export type Summary = Record<string, { values: number[], first: number, median: number, max: number, spread: number }>

// Each kind and measure's values in run order, the first apart since a cold machine can make it the slowest, the
// median, the slowest and the spread (slowest less fastest), named kind.measure
export function summarize(samples: readonly Sample[]): Summary {
  const summary: Summary = {}
  for (const sample of samples) {
    for (const measure of Object.keys(MEASURES) as Measure[]) (summary[`${sample.kind}.${measure}`] ??= { values: [], first: 0, median: 0, max: 0, spread: 0 }).values.push(sample.ms[measure])
  }
  for (const entry of Object.values(summary)) {
    const sorted = [...entry.values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    entry.first = entry.values[0]!
    entry.median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
    entry.max = sorted.at(-1)!
    entry.spread = entry.max - sorted[0]!
  }
  return summary
}

// The baseline: each measure's median from the first run, the factor every value of a run may reach before it fails,
// with a factor of its own for a measure too short for the common one, and the share of its median a run's spread may
// reach. Pending until its values are agreed, and a pending baseline checks nothing
export type Baseline = { status: 'pending' } | {
  status: 'set', factor: number, factors?: Record<string, number>, spreadShare: number, measures: Record<string, number>
}

export const baselineFile = () => process.env.HETU_TIER0_BASELINE ?? path.join(import.meta.dirname, 'baseline.json')
export const readBaseline = async (file = baselineFile()) => JSON.parse(await readFile(file, 'utf8')) as Baseline

const KINDS: readonly Kind[] = ['cold', 'warm']
const NAMES = new Set(KINDS.flatMap(kind => Object.keys(MEASURES).map(measure => `${kind}.${measure}`)))
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

// What fails. In the baseline: a factor or share that can't serve, a value that is no time above 0, a key no measure
// has. In the run: a value that is no time above 0, a measure the baseline has no value for, a slowest value past the
// baseline times its factor, so 2 slow starts of 5 can't hide behind the median, and a spread past its share of the
// median
export function check(baseline: Baseline, summary: Summary): string[] {
  if (baseline.status === 'pending') return []
  const problems: string[] = []
  if (!(isTime(baseline.factor) && baseline.factor > 1)) problems.push(`baseline factor: ${baseline.factor} is not a factor above 1`)
  for (const [name, factor] of Object.entries(baseline.factors ?? {})) if (!(isTime(factor) && factor > 1)) problems.push(`baseline factors.${name}: ${factor} is not a factor above 1`)
  if (!isTime(baseline.spreadShare)) problems.push(`baseline spreadShare: ${baseline.spreadShare} is not a share above 0`)
  if (problems.length > 0) return problems
  for (const [name, value] of Object.entries(baseline.measures)) {
    if (!NAMES.has(name)) problems.push(`baseline ${name}: no measure has that name`)
    else if (!isTime(value)) problems.push(`baseline ${name}: ${value} is not a time above 0`)
  }
  for (const [name, { values, first, median, max, spread }] of Object.entries(summary)) {
    const bad = values.flatMap((value, index) => isTime(value) ? [] : [`sample ${index + 1} is ${value} ms`])
    if (bad.length > 0) {
      problems.push(`${name}: ${bad.join(', ')}, not times above 0`)
      continue
    }
    const base = baseline.measures[name]
    if (base === undefined) problems.push(`${name}: ${median} ms with no baseline`)
    if (!isTime(base)) continue
    const factor = baseline.factors?.[name] ?? baseline.factor
    const limit = Math.round(base * factor)
    if (max > limit) problems.push(`${name}: slowest ${max} ms (median ${median} ms, first ${first} ms), past its baseline ${base} ms × ${factor} = ${limit} ms`)
    if (spread > baseline.spreadShare * median) problems.push(`${name}: spread ${spread} ms, past ${baseline.spreadShare} × its median ${median} ms`)
  }
  return problems
}

// Every median on one line, pending or not
export const mediansLine = (summary: Summary) => Object.entries(summary).map(([name, { median }]) => `${name} ${median}`).join(', ')
