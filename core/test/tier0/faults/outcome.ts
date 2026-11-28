// What a replay saw: the tests vitest's JSON report says failed, main green or not, and per fault the tests that failed
// on it in two runs, caught, missed or refused, with the recall over every fault named
import path from 'node:path'

// The parts of vitest's JSON report read here
export type Report = {
  testResults: {
    name: string
    status: string
    message?: string
    assertionResults: { fullName: string, title?: string, ancestorTitles?: string[], status: string, failureMessages?: string[] }[]
  }[]
}

export type Failed = { file: string, test: string, message: string }
// A test that fails on main for a reason written down, which a fault's failure of it never counts as a catch
export type KnownRed = { file: string, test: string, reason: string }
export type Outcome = {
  fault: string
  how: string
  // refused: the fault didn't plant cleanly, its copy didn't build, a file didn't load or no test ran. unjudged: no
  // main ran, so its failures are listed and nothing counted
  state: 'caught' | 'missed' | 'refused' | 'unjudged'
  // The tests that failed on the fault in its run and again when run alone on the same copy, the ones counted
  caughtBy: Failed[]
  // Failed in the fault's run and passed when run again, so not counted
  once: Failed[]
  // Known reds failing on the fault too, so not counted
  alsoOnMain: Failed[]
  // Files among caughtBy the fault doesn't name as expected
  unexpected: string[]
  // Every failure of the fault's first run, as it came
  failed: Failed[]
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

const nameOf = (test: Report['testResults'][number]['assertionResults'][number]) => (test.title === undefined ? test.fullName : [...test.ancestorTitles ?? [], test.title].join(' > '))

export function failuresOf(report: Report, root: string): Run {
  const failed: Failed[] = []
  let passed = 0
  let skipped = 0
  for (const file of report.testResults) {
    const name = path.relative(root, file.name).split(path.sep).join('/')
    const failing = file.assertionResults.filter(test => test.status === 'failed')
    passed += file.assertionResults.filter(test => test.status === 'passed').length
    skipped += file.assertionResults.filter(test => test.status === 'skipped' || test.status === 'pending').length
    // Named as vitest's -t matches a test, its describe blocks and title joined by >, which the report's fullName joins
    // by spaces, so a re-run can pick it out
    for (const test of failing) failed.push({ file: name, test: nameOf(test), message: firstLine(test.failureMessages?.[0], root) })
    if (failing.length === 0 && file.status === 'failed') failed.push({ file: name, test: '(the file)', message: firstLine(file.message, root) })
  }
  return { failed, passed, skipped }
}

const LOAD = '(the file)'
const key = (failed: { file: string, test: string }) => `${failed.file} > ${failed.test}`
const executed = (run: Run) => run.passed + run.failed.filter(failed => failed.test !== LOAD).length

// Main counts as green only when every run of it ran tests and failed none but a known red. A file that didn't load
// is never a known red
export function mainVerdict(runs: readonly Run[], known: readonly KnownRed[]): { green: boolean, why: string[], known: (Failed & { reason: string })[] } {
  const reasons = new Map(known.map(red => [key(red), red.reason]))
  const why: string[] = []
  const matched = new Map<string, Failed & { reason: string }>()
  runs.forEach((run, at) => {
    if (executed(run) === 0) why.push(`run ${at + 1} ran no test`)
    for (const failed of run.failed) {
      const reason = failed.test === LOAD ? undefined : reasons.get(key(failed))
      if (reason === undefined) why.push(`run ${at + 1} fails ${key(failed)}: ${failed.message}`)
      else if (!matched.has(key(failed))) matched.set(key(failed), { ...failed, reason })
    }
  })
  return { green: why.length === 0, why, known: why.length === 0 ? [...matched.values()] : [] }
}

// Why a run can't be judged: a file that didn't load, or no test ran
function unjudgeable(run: Run): string | null {
  const load = run.failed.find(failed => failed.test === LOAD)
  if (load !== undefined) return `${load.file} didn't load: ${load.message}`
  return executed(run) === 0 ? `ran no test${run.skipped > 0 ? ` (${run.skipped} skipped)` : ''}` : null
}

const filesOf = (failed: readonly Failed[]) => [...new Set(failed.map(each => each.file))]

// The tests a fault's run failed but for the known reds, the ones its re-run runs alone
export const toRerun = (run: Run, known: readonly Failed[]) => run.failed.filter(failed => !known.some(red => key(red) === key(failed)))

// The arguments that run again only the given tests: their files, then their full names as one escaped pattern
export function rerunArgs(failed: readonly Failed[]): string[] {
  const escaped = failed.map(each => each.test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return [...filesOf(failed), '-t', [...new Set(escaped)].join('|')]
}

type Named = { name: string, how: string, expected: readonly string[] }

// A fault's outcome from its run and, when that failed any test but a known red, the run of those tests again on the
// same copy. Only a test failing both times is a catch. known null is a replay with no main, which judges nothing
export function outcomeOf(fault: Named, first: Run, again: Run | null, known: readonly Failed[] | null): Outcome {
  const base = { fault: fault.name, how: fault.how, failed: first.failed, passed: first.passed, skipped: first.skipped }
  const none = { caughtBy: [], once: [], alsoOnMain: [], unexpected: [] }
  const refusal = unjudgeable(first)
  if (refusal !== null) return { ...base, ...none, state: 'refused', reason: refusal }
  if (known === null) return { ...base, ...none, state: 'unjudged' }
  const candidates = toRerun(first, known)
  const alsoOnMain = first.failed.filter(failed => !candidates.includes(failed))
  if (candidates.length > 0 && again === null) throw new Error(`${fault.name} failed tests nobody ran again`)
  if (again !== null && candidates.length > 0) {
    const againRefusal = unjudgeable(again)
    if (againRefusal !== null) return { ...base, ...none, alsoOnMain, state: 'refused', reason: `its re-run ${againRefusal}` }
  }
  const failedAgain = new Set((again?.failed ?? []).map(key))
  const caughtBy = candidates.filter(failed => failedAgain.has(key(failed)))
  const once = candidates.filter(failed => !failedAgain.has(key(failed)))
  const unexpected = filesOf(caughtBy).filter(file => !fault.expected.includes(file))
  return { ...base, state: caughtBy.length > 0 ? 'caught' : 'missed', caughtBy, once, alsoOnMain, unexpected }
}

export const refused = (fault: string, how: string, reason: string): Outcome => ({ fault, how, state: 'refused', caughtBy: [], once: [], alsoOnMain: [], unexpected: [], failed: [], passed: 0, skipped: 0, reason })

// Over every fault named, a refused one counted among them and never as caught
export function recallOf(outcomes: readonly Outcome[]): { caught: number, named: number, refused: number } {
  return {
    caught: outcomes.filter(outcome => outcome.state === 'caught').length,
    named: outcomes.length,
    refused: outcomes.filter(outcome => outcome.state === 'refused').length,
  }
}

// D-765: tier 0 counts as built once X1, W2 and X13 are each caught
const BUILT_BY = ['X1', 'W2', 'X13']
export function builtOf(outcomes: readonly Outcome[]): string {
  const found = BUILT_BY.map(name => outcomes.find(outcome => outcome.fault === name))
  if (found.some(outcome => outcome === undefined)) return 'not judged: X1, W2 and X13 weren\'t all replayed'
  const short = found.filter(outcome => outcome!.state !== 'caught')
  return short.length === 0 ? 'yes' : `no: ${short.map(outcome => `${outcome!.fault} ${outcome!.state}`).join(', ')}`
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
// Each file once with its tests, marked when the fault doesn't name it, and the first message of each file
const byFile = (failed: readonly Failed[], unexpected: readonly string[] = []) => filesOf(failed)
  .map(file => `${file}${unexpected.includes(file) ? ' (unexpected)' : ''}: ${failed.filter(each => each.file === file).map(each => each.test).join(', ')}`).join(' / ')
const messagesOf = (failed: readonly Failed[]) => filesOf(failed).map(file => failed.find(each => each.file === file)!.message).join(' / ')

export type MainReport = { runs: Run[], known: (Failed & { reason: string })[] }

// The summary: main, the recall and whether tier 0 counts as built, then a row per fault. Without main, no recall,
// only each fault's failures
export function summaryOf(outcomes: readonly Outcome[], main: MainReport | null): string {
  const lines: string[] = []
  if (main === null) lines.push('main: not run, so nothing is counted and there is no recall')
  else {
    const { caught, named, refused: refusedCount } = recallOf(outcomes)
    const first = main.runs[0]
    lines.push(`main: green in ${main.runs.length} runs, ${first?.passed ?? 0} passed, ${first?.skipped ?? 0} skipped in the first`)
    for (const red of main.known) lines.push(`- known red: ${key(red)}: ${red.reason}`)
    lines.push('', `recall: ${caught} caught of ${named} named, ${refusedCount} refused`, '', `tier 0 counts as built: ${builtOf(outcomes)}`)
  }
  lines.push('', '| fault | planted | result | caught by | message | failed once only |', '|---|---|---|---|---|---|')
  for (const outcome of outcomes) {
    const shown = outcome.state === 'unjudged' ? outcome.failed : outcome.caughtBy
    const skipped = outcome.skipped > 0 ? `(${outcome.skipped} skipped)` : ''
    const message = outcome.state === 'refused' ? outcome.reason ?? '' : [messagesOf(shown), skipped].filter(part => part !== '').join(' ')
    const once = outcome.once.map(key).join(', ')
    lines.push(`| ${outcome.fault} | ${cell(outcome.how)} | ${outcome.state} | ${cell(byFile(shown, outcome.unexpected))} | ${cell(message)} | ${cell(once)} |`)
  }
  return `${lines.join('\n')}\n`
}
