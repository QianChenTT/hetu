// The replay set's entries and how a replay reads vitest's report into caught, missed and recall
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginsDir, repo } from '../instance.ts'
import { faults, faultsNamed, knownReds, patchFile } from './faults.ts'
import { builtOf, failuresOf, mainVerdict, outcomeOf, recallOf, refused, rerunArgs, summaryOf, type Failed, type Report, type Run } from './outcome.ts'

const root = '/copy/core/test/tier0'
const report = (files: Report['testResults']): Report => ({ testResults: files })
const file = (name: string, tests: [string, string, string?][], status = 'passed', message?: string) => ({
  name: path.join(root, name),
  status,
  message,
  assertionResults: tests.map(([fullName, state, failure]) => ({ fullName, status: state, failureMessages: failure === undefined ? [] : [failure] })),
})

describe('the replay set', () => {
  it('holds X13, W2, X1 and the sealed F1 to F10 once each, with a plant each', () => {
    expect(faults.map(fault => fault.name)).toEqual(['X13', 'W2', 'X1', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'])
    for (const fault of faults) expect(fault.plants.length, fault.name).toBeGreaterThan(0)
  })

  it('names one fault in any case or all, and refuses a name it doesn\'t hold', () => {
    expect(faultsNamed('x1').map(fault => fault.name)).toEqual(['X1'])
    expect(faultsNamed('all')).toHaveLength(faults.length)
    expect(() => faultsNamed('F11')).toThrow(/no fault named F11: one of X13, W2/)
  })

  it('names only tier 0 files that exist here, a later step\'s file only on a fault that says it needs that step', () => {
    for (const fault of faults) {
      for (const named of [...fault.expected, ...(fault.tests ?? [])]) {
        if (existsSync(path.join(repo, 'core', 'test', 'tier0', named))) continue
        expect(fault.needs, `${fault.name} names ${named}`).toBeDefined()
      }
    }
  })

  it('plants each hetu patch cleanly on this tree and each revert names a commit hetu holds', () => {
    for (const fault of faults) {
      for (const plant of fault.plants.filter(each => each.repo === 'hetu')) {
        if ('revert' in plant) execFileSync('git', ['-C', repo, 'cat-file', '-e', `${plant.revert}^{commit}`])
        else expect(spawnSync('git', ['-C', repo, 'apply', '--check'], { input: readFileSync(patchFile(plant.patch)) }).stderr.toString(), fault.name).toBe('')
      }
    }
  })

  it.skipIf(!existsSync(path.join(pluginsDir(), '.git')))('plants each plugin patch cleanly on the plugins checkout and each revert names a commit it holds', () => {
    for (const fault of faults) {
      for (const plant of fault.plants.filter(each => each.repo === 'plugins')) {
        if ('revert' in plant) execFileSync('git', ['-C', pluginsDir(), 'cat-file', '-e', `${plant.revert}^{commit}`])
        else expect(spawnSync('git', ['-C', pluginsDir(), 'apply', '--check'], { input: readFileSync(patchFile(plant.patch)) }).stderr.toString(), fault.name).toBe('')
      }
    }
  })
})

describe('a replay\'s outcome', () => {
  const run = failuresOf(report([
    file('journeys/notes.real.test.ts', [['a note > saves', 'failed', '\u001b[31mAssertionError: expected "a.md (unsaved)" to be "a.md"\u001b[39m\n at /copy/core/test/tier0/x.ts:1'], ['a note > opens', 'passed']], 'failed'),
    file('state.real.test.ts', [['agree > after a rename', 'skipped']]),
    file('input.real.test.ts', [], 'failed', 'Error: Cannot find module /copy/core/test/tier0/input.ts\nstack'),
  ]), root)
  const failed = (file: string, test: string, message = `${test} failed`): Failed => ({ file, test, message })
  const ran = (failures: Failed[], passed = 5, skipped = 0): Run => ({ failed: failures, passed, skipped })
  const saves = failed('journeys/notes.real.test.ts', 'a note > saves')
  const renames = failed('state.real.test.ts', 'agree > after a rename')
  const tab = failed('journeys/first-run.real.test.ts', 'first run > T-50')
  const quits = failed('timing.real.test.ts', 'timing > quits', 'slow quit')

  it('reads each failed test with its first line, a file that failed with no test as the file, and counts passed and skipped', () => {
    expect(run).toEqual({
      failed: [
        { file: 'journeys/notes.real.test.ts', test: 'a note > saves', message: 'AssertionError: expected "a.md (unsaved)" to be "a.md"' },
        { file: 'input.real.test.ts', test: '(the file)', message: 'Error: Cannot find module input.ts' },
      ],
      passed: 1,
      skipped: 1,
    })
  })

  it('names a test as vitest\'s -t matches it, its describe blocks and title joined by >', () => {
    const read = failuresOf(report([{ name: path.join(root, 'journeys/first-run.real.test.ts'), status: 'failed', assertionResults: [
      { fullName: 'first run removes a plugin (T-50)', title: 'removes a plugin (T-50)', ancestorTitles: ['first run'], status: 'failed', failureMessages: ['Error: x'] },
    ] }]), root)
    expect(read.failed).toEqual([{ file: 'journeys/first-run.real.test.ts', test: 'first run > removes a plugin (T-50)', message: 'Error: x' }])
  })

  it('takes main as green only when both runs pass every test but a known red, which it names with its reason', () => {
    expect(mainVerdict([ran([]), ran([])], [])).toEqual({ green: true, why: [], known: [] })
    const known = [{ file: quits.file, test: quits.test, reason: 'T-93, a quit seen slow once' }]
    expect(mainVerdict([ran([quits]), ran([])], known)).toEqual({ green: true, why: [], known: [{ ...quits, reason: 'T-93, a quit seen slow once' }] })
    expect(mainVerdict([ran([]), ran([saves])], known)).toEqual({ green: false, why: ['run 2 fails journeys/notes.real.test.ts > a note > saves: a note > saves failed'], known: [] })
    expect(mainVerdict([ran(run.failed.slice(1)), ran([])], known).why).toEqual(['run 1 fails input.real.test.ts > (the file): Error: Cannot find module input.ts'])
    expect(mainVerdict([ran([], 0, 4), ran([])], []).why).toEqual(['run 1 ran no test'])
    expect(knownReds.every(red => red.reason !== '')).toBe(true)
  })

  it('counts a catch only for a test that failed on the fault twice, naming the one that failed once as failing once only', () => {
    const outcome = outcomeOf({ name: 'F1', how: 'hetu patch f1.patch', expected: ['journeys/notes.real.test.ts'] }, ran([saves, tab]), ran([saves]), [])
    expect(outcome).toMatchObject({ state: 'caught', caughtBy: [saves], once: [tab], alsoOnMain: [], unexpected: [] })
    expect(outcomeOf({ name: 'F1', how: 'p', expected: [] }, ran([tab]), ran([]), []).state).toBe('missed')
    expect(outcomeOf({ name: 'F1', how: 'p', expected: [] }, ran([]), null, []).state).toBe('missed')
    expect(() => outcomeOf({ name: 'F1', how: 'p', expected: [] }, ran([tab]), null, [])).toThrow(/F1 failed tests nobody ran again/)
  })

  it('leaves a known red failing on the fault uncounted, and marks a catch by a file the fault doesn\'t name as unexpected', () => {
    const outcome = outcomeOf({ name: 'F10', how: 'p', expected: ['journeys/notes.real.test.ts'] }, ran([quits, tab, saves]), ran([tab, saves]), [quits])
    expect(outcome).toMatchObject({ state: 'caught', caughtBy: [tab, saves], alsoOnMain: [quits], unexpected: ['journeys/first-run.real.test.ts'] })
  })

  it('refuses a fault whose run ran no test or whose file didn\'t load, so neither is a miss or a catch', () => {
    expect(outcomeOf({ name: 'F2', how: 'p', expected: [] }, ran([], 0, 20), null, [])).toMatchObject({ state: 'refused', reason: 'ran no test (20 skipped)' })
    expect(outcomeOf({ name: 'F2', how: 'p', expected: [] }, run, null, [])).toMatchObject({ state: 'refused', reason: 'input.real.test.ts didn\'t load: Error: Cannot find module input.ts' })
    expect(outcomeOf({ name: 'F2', how: 'p', expected: [] }, ran([saves]), ran([], 0), [])).toMatchObject({ state: 'refused', reason: 'its re-run ran no test' })
  })

  it('runs again each failing test of its file alone, its name escaped', () => {
    expect(rerunArgs([saves, tab, failed(saves.file, 'a note (T-3) > opens?')])).toEqual([
      'journeys/notes.real.test.ts', 'journeys/first-run.real.test.ts',
      '-t', 'a note > saves|first run > T-50|a note \\(T-3\\) > opens\\?',
    ])
  })

  it('counts refused faults among those named and calls tier 0 built only with X1, W2 and X13 caught', () => {
    const caught = (name: string) => outcomeOf({ name, how: 'p', expected: [] }, ran([saves]), ran([saves]), [])
    const outcomes = [caught('X1'), caught('X13'), refused('W2', 'hetu revert a335efa', 'doesn\'t apply cleanly')]
    expect(recallOf(outcomes)).toEqual({ caught: 2, named: 3, refused: 1 })
    expect(builtOf(outcomes)).toBe('no: W2 refused')
    expect(builtOf([caught('X1'), caught('X13'), caught('W2')])).toBe('yes')
    expect(builtOf([caught('F1')])).toBe('not judged: X1, W2 and X13 weren\'t all replayed')
  })

  it('writes the recall over every fault named, each catching file once with its tests and first message, and the known reds', () => {
    const outcomes = [
      outcomeOf({ name: 'F1', how: 'hetu patch f1.patch', expected: ['journeys/notes.real.test.ts'] }, ran([saves, failed(saves.file, 'a note > closes'), tab, renames]), ran([saves, failed(saves.file, 'a note > closes'), tab]), []),
      outcomeOf({ name: 'F7', how: 'plugins patch f7.patch', expected: [] }, ran([], 3, 2), null, []),
      refused('W2', 'hetu revert a335efa', 'hetu revert a335efa doesn\'t apply cleanly: core/frontend/trusted/view.ts'),
    ]
    const summary = summaryOf(outcomes, { runs: [ran([], 27), ran([], 27)], known: [{ ...quits, reason: 'T-93' }] })
    expect(summary).toContain('main: green in 2 runs, 27 passed, 0 skipped in the first')
    expect(summary).toContain('- known red: timing.real.test.ts > timing > quits: T-93')
    expect(summary).toContain('recall: 1 caught of 3 named, 1 refused')
    expect(summary).toContain('tier 0 counts as built: not judged')
    expect(summary).toContain('| F1 | hetu patch f1.patch | caught | journeys/notes.real.test.ts: a note > saves, a note > closes / journeys/first-run.real.test.ts (unexpected): first run > T-50 | a note > saves failed / first run > T-50 failed | state.real.test.ts > agree > after a rename |')
    expect(summary).toContain('| F7 | plugins patch f7.patch | missed |  | (2 skipped) |  |')
    expect(summary).toContain('| W2 | hetu revert a335efa | refused |  | hetu revert a335efa doesn\'t apply cleanly: core/frontend/trusted/view.ts |  |')
  })

  it('gives no recall without main, only each fault\'s failures as they came', () => {
    const outcomes = [outcomeOf({ name: 'F1', how: 'p', expected: [] }, ran([saves]), null, null)]
    expect(outcomes[0]).toMatchObject({ state: 'unjudged', failed: [saves] })
    const summary = summaryOf(outcomes, null)
    expect(summary).toContain('main: not run, so nothing is counted and there is no recall')
    expect(summary).not.toContain('recall:')
    expect(summary).toContain('| F1 | p | unjudged | journeys/notes.real.test.ts: a note > saves | a note > saves failed |  |')
  })
})
