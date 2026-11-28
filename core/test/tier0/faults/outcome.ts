// What a replay saw: the tests vitest's JSON report says failed, caught or missed per fault and the recall over the
// faults that were planted
import path from 'node:path'

// The parts of vitest's JSON report read here
export type Report = {
  testResults: {
    name: string
    status: string
    message?: string
    assertionResults: { fullName: string, status: string, failureMessages?: string[] }[]
  }[]
}

export type Failed = { file: string, test: string, message: string }
export type Outcome = {
  fault: string
  how: string
  // refused: the fault didn't plant cleanly or its copy didn't build, so nothing ran
  state: 'caught' | 'missed' | 'refused'
  // The tests that failed on the fault and passed on main, the ones counted
  caughtBy: Failed[]
  // Failed on the fault as on main, so not counted
  alsoOnMain: Failed[]
  passed: number
  // Skipped tests, as the memory gate skips one, which then catches nothing
  skipped: number
  reason?: string
}

const MESSAGE_CHARS = 240

// A failure's first line, with vitest's colour codes and the run's own paths left out
function firstLine(message: string | undefined, root: string): string {
  const line = (message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find(each => each.trim() !== '') ?? ''
  return line.split(`${root}/`).join('').split(root).join('').trim().slice(0, MESSAGE_CHARS)
}

// Every test that failed, and a file that failed with none, as when it didn't load, by its path under root
export type Run = { failed: Failed[], passed: number, skipped: number }

export function failuresOf(report: Report, root: string): Run {
  const failed: Failed[] = []
  let passed = 0
  let skipped = 0
  for (const file of report.testResults) {
    const name = path.relative(root, file.name).split(path.sep).join('/')
    const failing = file.assertionResults.filter(test => test.status === 'failed')
    passed += file.assertionResults.filter(test => test.status === 'passed').length
    skipped += file.assertionResults.filter(test => test.status === 'skipped' || test.status === 'pending').length
    for (const test of failing) failed.push({ file: name, test: test.fullName, message: firstLine(test.failureMessages?.[0], root) })
    if (failing.length === 0 && file.status === 'failed') failed.push({ file: name, test: '(the file)', message: firstLine(file.message, root) })
  }
  return { failed, passed, skipped }
}

const key = (failed: Failed) => `${failed.file} > ${failed.test}`

// Caught when a test failed that passed on main. Without a main run every failure counts
export function outcomeOf(fault: string, how: string, run: Run, main: Failed[] | null): Outcome {
  const onMain = new Set((main ?? []).map(key))
  const caughtBy = run.failed.filter(failed => !onMain.has(key(failed)))
  const alsoOnMain = run.failed.filter(failed => onMain.has(key(failed)))
  return { fault, how, state: caughtBy.length > 0 ? 'caught' : 'missed', caughtBy, alsoOnMain, passed: run.passed, skipped: run.skipped }
}

export const refused = (fault: string, how: string, reason: string): Outcome => ({ fault, how, state: 'refused', caughtBy: [], alsoOnMain: [], passed: 0, skipped: 0, reason })

export function recallOf(outcomes: readonly Outcome[]): { caught: number, planted: number } {
  const planted = outcomes.filter(outcome => outcome.state !== 'refused')
  return { caught: planted.filter(outcome => outcome.state === 'caught').length, planted: planted.length }
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

// The summary as a Markdown table, a row per fault with the first test that caught it and how many more did
export function summaryOf(outcomes: readonly Outcome[], main: Run | null): string {
  const { caught, planted } = recallOf(outcomes)
  const lines = [
    main === null ? 'main: not run, so every failure counts' : `main: ${main.passed} passed, ${main.failed.length} failed, ${main.skipped} skipped${main.failed.map(failed => `\n- fails on main: ${failed.file} > ${failed.test}: ${failed.message}`).join('')}`,
    '',
    `recall: ${caught} of ${planted} planted${outcomes.length > planted ? `, ${outcomes.length - planted} refused` : ''}`,
    '',
    '| fault | planted | result | caught by | message |',
    '|---|---|---|---|---|',
  ]
  for (const outcome of outcomes) {
    const first = outcome.caughtBy[0]
    const by = first === undefined ? '' : `${first.file} > ${first.test}${outcome.caughtBy.length > 1 ? ` (and ${outcome.caughtBy.length - 1} more)` : ''}`
    const skipped = outcome.skipped > 0 ? ` (${outcome.skipped} skipped)` : ''
    const message = outcome.state === 'refused' ? outcome.reason ?? '' : `${first?.message ?? ''}${skipped}`
    lines.push(`| ${outcome.fault} | ${cell(outcome.how)} | ${outcome.state} | ${cell(by)} | ${cell(message)} |`)
  }
  return `${lines.join('\n')}\n`
}
