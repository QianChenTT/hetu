import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { corePluginIds, firstPartyIds, utilityIds } from '../api/ids.ts'
import { apiConstants, namedIn, relaysOf, type Named, type Relays } from './named-parts.ts'
import { shippedFiles } from './shipped-files.ts'

// A plugin gets no trust and reaches anything through the router, so the core names no part hetu doesn't run in main
// (D-569, D-633). An id counts as named-parts.ts counts a name: a string or a constant of core/api holding one id. A
// use of the same spelling with another meaning is listed by file and the text on its line, with why

// Shipped code of core/, ts and js, not its READMEs, and not ids.ts, which holds the lists
const repo = path.join(import.meta.dirname, '..', '..')
const files = shippedFiles({ kinds: ['ts', 'js'] }).filter(file => file !== 'core/api/ids.ts')

// The parts outside main: each core plugin, the utility process ones among them and each first-party plugin, read from
// ids.ts. leases is a core plugin that is gone, which an old switches file still names. Core modules run in main and
// the namespaces are the core's, so neither counts
const retired = ['leases']
export const outside: ReadonlyMap<string, string> = new Map([...corePluginIds, ...utilityIds, ...firstPartyIds, ...retired].map(id => [id, id]))
export const constants: ReadonlyMap<string, string> = await apiConstants(outside)

// A place is a file of core/, the text on the line its id stands in and how many ids it covers in that file, so one
// more on the line or on another line holding the text fails
export type Place = { place: string, text: string, hits: number, why: string }

export const listed: readonly Place[] = [
  { place: 'lib/canonical.ts', text: "hidden: reached.some(isGitName) ? 'git'", hits: 1, why: 'the kind of hidden name a .git folder on the path is, not the git plugin' },
  { place: 'lib/canonical.ts', text: "refuse('git')", hits: 1, why: 'the refusal of a path inside a .git folder, not the git plugin' },
  { place: 'backend/providers/history/history.ts', text: "findProgram('git'", hits: 2, why: 'the git program history runs, not the git plugin' },
  { place: 'backend/policy/grant-risk-classifier/rules.ts', text: "'git', 'node', 'nodejs'", hits: 1, why: 'the git program among the commands that run others, not the git plugin' },
  { place: 'frontend/editor/ui-port.ts', text: "SKELETON = 'layout'", hits: 1, why: 'the surface layouts draw on' },
  { place: 'sdk/ui.ts', text: "SKELETON = 'layout'", hits: 1, why: 'the surface layouts draw on, as the SDK names it' },
  { place: 'frontend/editor/bridge.ts', text: "? 'layout' :", hits: 1, why: 'the surface a layout.draw call draws on, the skeleton' },
  { place: 'backend/boot/state.ts', text: "id !== 'leases'", hits: 1, why: 'a reader dropping a retired id from an old switches file (D-631)' },
  {
    place: 'frontend/editor/page.ts', text: "status.page.includes('hidden-marks')", hits: 1,
    why: 'core knowing a plugin, which the marks stack (marks-switch, #198) removes as hidden marks becomes a first-party worker',
  },
  {
    place: 'frontend/editor/ui-port.ts', text: "OWN_LAYOUT = 'layout'", hits: 1,
    why: 'core picking the layout plugin when the human picked none, parked for Han: no fix leaves what a user sees the same',
  },
]

// What fails: an id named outside the places listed, a place covering more or fewer ids than it lists, a place that no
// longer names one and a why under 10 characters
export function partProblems(found: readonly Named[], lineOf: (hit: Named) => string, places: readonly Place[]): string[] {
  const at = (hit: Named, place: Place) => hit.file === `core/${place.place}` && lineOf(hit).includes(place.text)
  const problems = found.filter(hit => !places.some(place => at(hit, place)))
    .map(hit => `${hit.file}:${hit.line} ${hit.text} names ${hit.part}, a part hetu doesn't run in main`)
  for (const place of places) {
    const covered = found.filter(hit => at(hit, place))
    if (covered.length === 0) problems.push(`${place.place} holds no "${place.text}" naming a part: remove the entry`)
    else if (covered.length !== place.hits) {
      const hits = covered.map(hit => `line ${hit.line} ${hit.text}`).join(', ')
      problems.push(`${place.place} "${place.text}" covers ${covered.length} hit${covered.length === 1 ? '' : 's'} and lists ${place.hits}: ${hits}`)
    }
    if (place.why.length < 10) problems.push(`${place.place} "${place.text}" has a why under 10 characters`)
  }
  return problems
}

const sources = new Map(files.map(file => [file, readFileSync(path.join(repo, file), 'utf8')]))
const relays = relaysOf(sources, constants)
const found = [...sources].flatMap(([file, source]) => namedIn(file, source, outside, constants, relays))
const lineOf = (hit: Named) => sources.get(hit.file)!.split('\n')[hit.line - 1]

describe('the parts outside main the core names', () => {
  it('reads the shipped code of core/ but ids.ts, and the ids from ids.ts', () => {
    expect(files).toContain('core/api/actions.ts')
    expect(files).toContain('core/frontend/editor/ui-port.ts')
    expect(files).not.toContain('core/api/ids.ts')
    expect(files.every(file => /\.(ts|js)$/.test(file) && file.startsWith('core/'))).toBe(true)
    for (const id of ['mcp', 'git', 'layout', 'net', 'mcp-http-handler', 'hidden-marks', 'leases']) expect(outside.has(id), id).toBe(true)
    for (const id of ['gate', 'luoshu', 'lock', 'core', 'plugin']) expect(outside.has(id), id).toBe(false)
  })

  it('names none outside the places listed, each still there and with its why', () => {
    expect(partProblems(found, lineOf, listed)).toEqual([])
  })
})

describe('the parts outside main check itself', () => {
  const at = 'core/backend/planted.ts'
  const problems = (source: string, places: readonly Place[] = [], held = constants, file = at, relays: Relays = new Map()) => {
    const lines = source.split('\n')
    return partProblems(namedIn(file, source, outside, held, relays), hit => lines[hit.line - 1], places)
  }
  const git: Place = { place: 'backend/planted.ts', text: "findProgram('git')", hits: 1, why: 'the git program, not the plugin' }

  it.each([
    ["if (id === 'file-explorer') {}", `${at}:1 'file-explorer' names file-explorer, a part hetu doesn't run in main`],
    ["if (call.from === `mcp-http-handler`) {}", `${at}:1 'mcp-http-handler' names mcp-http-handler, a part hetu doesn't run in main`],
    ["const order = { 'hidden-marks': 1 }", `${at}:1 'hidden-marks' names hidden-marks, a part hetu doesn't run in main`],
    ["off.filter(id => id !== 'leases')", `${at}:1 'leases' names leases, a part hetu doesn't run in main`],
  ])('fails %j', (source, problem) => {
    expect(problems(source)).toEqual([problem])
  })

  const search = new Map([['SEARCH', 'search']])
  it('fails an imported constant holding one id', () => {
    expect(problems("import { SEARCH } from '../api/ids.ts'\nf(SEARCH)", [], search)).toEqual([
      `${at}:1 SEARCH names search, a part hetu doesn't run in main`,
      `${at}:2 SEARCH names search, a part hetu doesn't run in main`,
    ])
  })

  it('fails a constant holding one id handed on by another file or destructured from a namespace', () => {
    const relays = relaysOf(new Map([['core/backend/relay.ts', "export { SEARCH } from '../api/ids.ts'"]]), search)
    expect(problems("import { SEARCH } from './relay.ts'\nf(SEARCH)", [], search, at, relays)).toEqual([
      `${at}:1 SEARCH names search, a part hetu doesn't run in main`,
      `${at}:2 SEARCH names search, a part hetu doesn't run in main`,
    ])
    expect(problems("import * as ids from '../api/ids.ts'\nconst { SEARCH: s } = ids\nf(s)", [], search)).toEqual([
      `${at}:2 SEARCH names search, a part hetu doesn't run in main`,
      `${at}:3 SEARCH names search, a part hetu doesn't run in main`,
    ])
  })

  it('passes a listed use and fails the same spelling in a file not listed', () => {
    expect(problems("const git = await findProgram('git')", [git])).toEqual([])
    expect(problems("const git = await findProgram('git')", [git], constants, 'core/backend/other.ts')).toContain(
      "core/backend/other.ts:1 'git' names git, a part hetu doesn't run in main",
    )
    expect(problems("const git = await findProgram('git')\nif (id === 'git') {}", [git])).toEqual([
      `${at}:2 'git' names git, a part hetu doesn't run in main`,
    ])
  })

  // The three ways PR D's review hid an id behind an entry: one more on its line, another id on it and a new line
  // holding its text
  const hidden: Place = { place: 'backend/planted.ts', text: "hidden: reached.some(isGitName) ? 'git'", hits: 1, why: 'the kind of hidden name a .git folder is' }
  const refused: Place = { place: 'backend/planted.ts', text: "refuse('git')", hits: 1, why: 'the refusal of a path inside a .git folder' }
  it.each([
    [
      "const found = { real, hidden: reached.some(isGitName) ? 'git' : (id === 'git' ? 'git' : 'dot') }", hidden,
      `backend/planted.ts "hidden: reached.some(isGitName) ? 'git'" covers 3 hits and lists 1: line 1 'git', line 1 'git', line 1 'git'`,
    ],
    [
      "const found = { real, hidden: reached.some(isGitName) ? 'git' : (id === 'search' ? 'x' : 'dot') }", hidden,
      `backend/planted.ts "hidden: reached.some(isGitName) ? 'git'" covers 2 hits and lists 1: line 1 'git', line 1 'search'`,
    ],
    [
      "if (names.some(isGitName)) f(refuse('git'))\nconst z = refuse('git')", refused,
      `backend/planted.ts "refuse('git')" covers 2 hits and lists 1: line 1 'git', line 2 'git'`,
    ],
  ])('fails one more id behind an entry in %j', (source, place, problem) => {
    expect(problems(source, [place])).toEqual([problem])
  })

  it('passes an entry covering the hits it lists and fails one fewer', () => {
    expect(problems("const found = { real, hidden: reached.some(isGitName) ? 'git' : 'dot' }", [hidden])).toEqual([])
    expect(problems("if (names.some(isGitName)) f(refuse('git'))", [refused])).toEqual([])
    const two: Place = { ...git, text: "findProgram('git'", hits: 2 }
    expect(problems("findProgram('git')\nfindProgram('git', { path })", [two])).toEqual([])
    expect(problems("findProgram('git')", [two])).toEqual([`backend/planted.ts "findProgram('git'" covers 1 hit and lists 2: line 1 'git'`])
  })

  it('fails a stale entry and a short why', () => {
    expect(problems('const x = 1', [git])).toEqual([`backend/planted.ts holds no "findProgram('git')" naming a part: remove the entry`])
    expect(problems("findProgram('git')", [{ ...git, why: 'program' }])).toEqual([`backend/planted.ts "findProgram('git')" has a why under 10 characters`])
  })

  it.each([
    "if (caller.kind === 'plugin') {}",
    "const dir = path.join(root, '.git')",
    "// the layout plugin draws here\nconst x = 1",
    "import net from 'net'",
    "if (topic === 'layout.state') {}",
  ])('counts nothing in %j', source => {
    expect(problems(source)).toEqual([])
  })
})
