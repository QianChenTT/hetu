// Tier 0's timing: how long hetu takes to start, to draw the first note and to quit on the driven build, read from the
// app's own clocks (the event log's at stamps, main's and the pages' Date.now) and checked against a baseline
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import type { TestContext } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { quiet } from '../drive.ts'
import { writeApproved } from '../plugins-manager-fakes.ts'
import { drivenApp, until } from './instance.ts'
import { freeGb } from './memory.ts'

// Each measure, where it starts and ends and what it takes in. Every start measure begins at main's first log record,
// so Electron's own process start and Playwright's attach before main's code runs are left out. A log stamp is when
// its batch reached the disk, so a slow disk or a long queue moves it later than the event. editor reads main's own
// clock at both ends for that reason
export const MEASURES = {
  ready: 'first boot.check stamp to the core.ready stamp: boot checks, the core modules and every plugin started',
  shown: 'first boot.check stamp to main calling show or showInactive on the editor window, read in main',
  editor: 'the editor window made, which main does once the core started, to that show call: its page loaded and drawn',
  firstNote: 'pointerdown on the explorer\'s row (the frame\'s clock) to the note\'s text in the shown editor (the page\'s clock)',
  quit: 'app.quit() in main (main\'s clock) to the process exit seen by the test: core.stopping, the draft grace, windows closed',
} as const
export type Measure = keyof typeof MEASURES
// cold: the first start on a data folder, with no Chromium caches and no earlier log. warm: a restart of the same folder
export type Kind = 'cold' | 'warm'
export type Sample = { kind: Kind, ms: Record<Measure, number>, stoppingMs: number, freeGb: number, load: number, others: number }

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

// One timed start, first note and quit of the driven build on data. Opens the note whose explorer row reads row and
// waits for text in the editor. No trace, since its screenshots and snapshots load the renderer being timed. The test's
// cleanup closes the app too, since a timed out test never reaches the finally
export async function timedRun(context: TestContext, data: string, kind: Kind, row: string, text: string): Promise<Sample> {
  const machine = { freeGb: freeGb(), load: os.loadavg()[0]!, others: othersRunning() }
  const begun = Date.now()
  const app = await electron.launch({ executablePath: drivenApp(), args: [], env: { ...processEnv(), HETU_DATA_DIR: data, HETU_QUIET_WINDOWS: 'hidden' } })
  let exited = false
  const exit = new Promise<number>(resolve => app.process().once('exit', () => {
    exited = true
    resolve(Date.now())
  }))
  context.onTestFinished(async () => {
    if (!exited) await app.close().catch(() => {})
  })
  try {
    await quiet(app)
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
    const { made, shown } = (await shownAt())!
    const editor = await editorPage(app)
    const firstNote = await openFirstNote(editor, row, text)
    const stamps = await logStamps(data, begun, ['boot.check', 'core.ready'])
    const asked = await app.evaluate(({ app }) => {
      const at = Date.now()
      setTimeout(() => app.quit(), 0)
      return at
    })
    const ended = await Promise.race([exit, new Promise<null>(resolve => setTimeout(() => resolve(null), 20_000))])
    if (ended === null) throw new Error('the quit took over 20 s')
    const stopping = await logStamps(data, asked, ['core.stopping'])
    const boot = stamps['boot.check']
    return {
      kind, ...machine, stoppingMs: stopping['core.stopping'] - asked,
      ms: { ready: stamps['core.ready'] - boot, shown: shown - boot, editor: shown - made, firstNote, quit: ended - asked },
    }
  } finally {
    if (!exited) await app.close().catch(() => {})
  }
}

async function editorPage(app: ElectronApplication): Promise<Page> {
  let found: Page | undefined
  await until(() => (found = app.windows().find(page => page.url() === 'hetu://editor/')) !== undefined, 'the editor page')
  return found!
}

// The explorer's row clicked through Playwright, timed from its pointerdown in the frame to the text in the editor
async function openFirstNote(editor: Page, row: string, text: string): Promise<number> {
  const explorer = () => editor.frames().find(frame => frame.url().includes('file-explorer.views'))
  await until(() => explorer() !== undefined, 'the explorer frame')
  const target = explorer()!.locator('[role=treeitem]', { hasText: row }).first()
  await until(async () => await target.count() === 1, `the ${row} row`)
  await editor.evaluate(text => {
    const at = globalThis as unknown as { tier0Drawn?: number }
    const seen = () => document.querySelector('#editors > .editor:not([hidden]) .cm-content')?.textContent?.includes(text) === true
    new MutationObserver((_records, observer) => {
      if (!seen()) return
      at.tier0Drawn = Date.now()
      observer.disconnect()
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  }, text)
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

// The at stamp of each event's first record at or after since, waiting for the log to hold them all
export async function logStamps<E extends string>(data: string, since: number, events: readonly E[]): Promise<Record<E, number>> {
  const found: Partial<Record<E, number>> = {}
  await until(async () => {
    const folder = path.join(data, 'events')
    for (const file of (await readdir(folder).catch(() => [])).sort()) {
      for (const line of (await readFile(path.join(folder, file), 'utf8')).split('\n')) {
        if (line === '') continue
        const record = JSON.parse(line) as { at: string, event: string }
        const at = Date.parse(record.at)
        if (at >= since && events.includes(record.event as E) && found[record.event as E] === undefined) found[record.event as E] = at
      }
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

export type Summary = Record<string, { values: number[], median: number, spread: number }>

// Each kind and measure's 5 values, their median and spread (highest less lowest), named kind.measure
export function summarize(samples: readonly Sample[]): Summary {
  const summary: Summary = {}
  for (const sample of samples) {
    for (const measure of Object.keys(MEASURES) as Measure[]) (summary[`${sample.kind}.${measure}`] ??= { values: [], median: 0, spread: 0 }).values.push(sample.ms[measure])
  }
  for (const entry of Object.values(summary)) {
    const sorted = [...entry.values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    entry.median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
    entry.spread = sorted.at(-1)! - sorted[0]!
  }
  return summary
}

// The baseline: each measure's median from the first run, and the factor a run's median may reach before it fails,
// with a factor of its own for a measure too short for the common one. Pending until its values are agreed, and a
// pending baseline checks nothing
export type Baseline = { status: 'pending' } | { status: 'set', factor: number, factors?: Record<string, number>, measures: Record<string, number> }

export const baselineFile = () => process.env.HETU_TIER0_BASELINE ?? path.join(import.meta.dirname, 'baseline.json')
export const readBaseline = async (file = baselineFile()) => JSON.parse(await readFile(file, 'utf8')) as Baseline

// What fails: a measure whose median is past its baseline times the factor, or a measure the baseline has no value for
export function check(baseline: Baseline, summary: Summary): string[] {
  if (baseline.status === 'pending') return []
  return Object.entries(summary).flatMap(([name, { median }]) => {
    const base = baseline.measures[name]
    if (base === undefined) return [`${name}: ${median} ms with no baseline`]
    const factor = baseline.factors?.[name] ?? baseline.factor
    const limit = Math.round(base * factor)
    return median > limit ? [`${name}: ${median} ms, past its baseline ${base} ms × ${factor} = ${limit} ms`] : []
  })
}

const processEnv = () => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
