// The replay set: past faults planted again on a throwaway copy, so tier 0's recall on them can be counted. A fault is
// planted by reverting its fix commits, by a patch kept here or both, in hetu or in a copy of the plugins checkout.
// expected names the tier 0 files thought to catch it, read against what the replay saw, never used to pick tests
import path from 'node:path'

export type Repo = 'hetu' | 'plugins'
// A revert takes each commit's change back in the order listed, newest first, limited to paths when given
export type Plant =
  | { repo: Repo, revert: string, paths?: string[] }
  | { repo: Repo, patch: string }

export type Fault = {
  name: string
  // The triage or bug id it came from
  id: string
  plants: Plant[]
  what: string
  expected: string[]
  // The tier 0 files run on it, every real test when not given. A fault only a later step's files can catch names
  // the step, run with --ref on a branch that has it
  tests?: string[]
  needs?: string
}

export const patchFile = (patch: string) => path.join(import.meta.dirname, patch)

export const faults: readonly Fault[] = [
  {
    name: 'X13',
    id: 'X13, #273',
    plants: [{ repo: 'hetu', revert: '0baae9d' }, { repo: 'hetu', revert: '5d01b52' }],
    what: 'an open note moved or removed by hetu is no longer marked gone, its unsaved text is saved to the path it left',
    expected: ['journeys/notes-gone.real.test.ts', 'state.real.test.ts'],
  },
  {
    name: 'W2',
    id: 'W2, #257',
    plants: [{ repo: 'hetu', revert: 'a335efa' }],
    what: 'the folder pick is asked from the trusted page again, so the picker closing restarts the input delay and the pick is refused',
    expected: ['journeys/first-run.real.test.ts'],
  },
  {
    name: 'X1',
    id: 'X1, hetu-plugins d6e6dcc',
    plants: [{ repo: 'plugins', revert: 'd6e6dcc', paths: ['links'] }, { repo: 'plugins', patch: 'x1-explorer.patch' }],
    what: 'a Files row and a Links row open their note through the worker\'s editor.open, in the background and never as the human\'s',
    expected: ['input.real.test.ts', 'state.real.test.ts', 'journeys/notes.real.test.ts'],
  },
  {
    name: 'F1',
    id: 'sealed 1',
    plants: [{ repo: 'hetu', patch: 'f1.patch' }],
    what: 'the title keeps (unsaved) after a save',
    expected: ['input.real.test.ts', 'state.real.test.ts', 'journeys/notes.real.test.ts'],
  },
  {
    name: 'F2',
    id: 'sealed 2',
    plants: [{ repo: 'hetu', patch: 'f2.patch' }],
    what: 'the Views menu star stays empty after it is clicked',
    expected: ['state.real.test.ts'],
  },
  {
    name: 'F3',
    id: 'sealed 3',
    plants: [{ repo: 'hetu', patch: 'f3.patch' }],
    what: 'Installed is shown before the install\'s Confirm',
    expected: ['journeys/first-run.real.test.ts'],
  },
  {
    name: 'F4',
    id: 'sealed 4',
    plants: [{ repo: 'hetu', patch: 'f4.patch' }],
    what: 'Escape no longer closes the Views menu',
    expected: ['journeys/notes.real.test.ts'],
  },
  {
    name: 'F5',
    id: 'sealed 5',
    plants: [{ repo: 'hetu', patch: 'f5.patch' }],
    what: 'focus lands on the Real text button when the raw view closes',
    expected: ['journeys/notes.real.test.ts'],
  },
  {
    name: 'F6',
    id: 'sealed 6',
    plants: [{ repo: 'hetu', patch: 'f6.patch' }],
    what: 'the editor window shows 1.5 s after it is ready',
    expected: ['timing.real.test.ts'],
    tests: ['timing.real.test.ts'],
    needs: 'step 7, the timing baseline',
  },
  {
    name: 'F7',
    id: 'sealed 7',
    plants: [{ repo: 'plugins', patch: 'f7.patch' }],
    what: 'the Footnotes view is blank for a note with no footnotes',
    expected: ['state.real.test.ts'],
  },
  {
    name: 'F8',
    id: 'sealed 8',
    plants: [{ repo: 'plugins', patch: 'f8.patch' }],
    what: 'Files keeps the old name after a rename',
    expected: ['state.real.test.ts', 'journeys/notes-gone.real.test.ts'],
  },
  {
    name: 'F9',
    id: 'sealed 9',
    plants: [{ repo: 'plugins', patch: 'f9.patch' }],
    what: 'Links keeps a note renamed or deleted in Files',
    expected: ['state.real.test.ts'],
  },
  {
    name: 'F10',
    id: 'sealed 10',
    plants: [{ repo: 'plugins', patch: 'f10.patch' }],
    what: 'search never finds a note whose path has a space or a CJK character',
    expected: ['journeys/notes.real.test.ts'],
  },
]

export function faultsNamed(name: string): Fault[] {
  if (name === 'all') return [...faults]
  const found = faults.find(fault => fault.name.toLowerCase() === name.toLowerCase())
  if (found === undefined) throw new Error(`no fault named ${name}: one of ${faults.map(fault => fault.name).join(', ')} or all`)
  return [found]
}
