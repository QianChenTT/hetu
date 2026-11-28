// The replay set's entries and how a replay reads vitest's report into caught, missed and recall
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginsDir, repo } from '../instance.ts'
import { faults, faultsNamed, patchFile } from './faults.ts'
import { failuresOf, outcomeOf, recallOf, refused, summaryOf, type Report } from './outcome.ts'

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

  it('counts as caught only a test that passed on main, and as missed a fault whose failures all fail on main too', () => {
    const caught = outcomeOf('F1', 'hetu patch f1.patch', run, [run.failed[1]!])
    expect(caught).toMatchObject({ state: 'caught', caughtBy: [run.failed[0]], alsoOnMain: [run.failed[1]] })
    expect(outcomeOf('F7', 'plugins patch f7.patch', run, run.failed).state).toBe('missed')
    expect(outcomeOf('F7', 'plugins patch f7.patch', { failed: [], passed: 3, skipped: 0 }, null).state).toBe('missed')
    expect(outcomeOf('F1', 'hetu patch f1.patch', run, null).caughtBy).toEqual(run.failed)
  })

  it('leaves a refused fault out of the recall and says so in the summary, with the test that caught each and how many more', () => {
    const outcomes = [
      outcomeOf('F1', 'hetu patch f1.patch', run, []),
      outcomeOf('F7', 'plugins patch f7.patch', { failed: [], passed: 3, skipped: 2 }, []),
      refused('W2', 'hetu revert a335efa', 'hetu revert a335efa doesn\'t apply cleanly: core/frontend/trusted/view.ts'),
    ]
    expect(recallOf(outcomes)).toEqual({ caught: 1, planted: 2 })
    const summary = summaryOf(outcomes, { failed: [], passed: 27, skipped: 0 })
    expect(summary).toContain('main: 27 passed, 0 failed, 0 skipped')
    expect(summary).toContain('recall: 1 of 2 planted, 1 refused')
    expect(summary).toContain('| F1 | hetu patch f1.patch | caught | journeys/notes.real.test.ts > a note > saves (and 1 more) | AssertionError: expected "a.md (unsaved)" to be "a.md" (1 skipped) |')
    expect(summary).toContain('| F7 | plugins patch f7.patch | missed |  |  (2 skipped) |')
    expect(summary).toContain('| W2 | hetu revert a335efa | refused |  | hetu revert a335efa doesn\'t apply cleanly: core/frontend/trusted/view.ts |')
  })

  it('names each test failing on main in the summary and that every failure counts without a main run', () => {
    expect(summaryOf([], run)).toContain('- fails on main: journeys/notes.real.test.ts > a note > saves: AssertionError')
    expect(summaryOf([], null)).toContain('main: not run, so every failure counts')
  })
})
