import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { coreActions, eventActions, providerActions } from '../api/actions.ts'
import { capabilityTypes } from '../api/capabilities.ts'
import { doorId } from '../api/ids.ts'
import { uiNeeds } from '../api/ui.ts'
import { placeProblems, type Place } from './listed-places.ts'
import { apiConstants, namedIn, relaysOf, type Known, type Named, type Relays } from './named-parts.ts'
import { shippedFiles } from './shipped-files.ts'

// A plugin gets no trust and reaches anything through the router, so the core names no part hetu doesn't run in main
// (D-569, D-633). An id counts as named-parts.ts counts a name: a string or a constant of core/api holding one id. A
// use of the same spelling with another meaning is listed as listed-places.ts lists a place, with why

// Shipped code of core/, ts and js, not its READMEs, and not ids.ts, which holds the lists
const repo = path.join(import.meta.dirname, '..', '..')
const files = shippedFiles({ kinds: ['ts', 'js'] }).filter(file => file !== 'core/api/ids.ts')

// The parts outside main are plugins: the ids of plugins the core once named. leases is a core plugin that is gone,
// which an old switches file still names. The first-party ids went with the first-party plugins: hetu ships none and a
// user installs each in the plugin folder, so the core names them no more than any other plugin. Core modules run in
// main and the namespaces are the core's, net among them, so neither counts. The door is core code in a utility process
// the core starts and switches by its id, so its id names the core's own part
const retired = ['leases', 'mcp', 'git', 'artifacts', 'notify', 'layout', 'hidden-marks']
export const outside: ReadonlyMap<string, string> = new Map(retired.map(id => [id, id]))

// The names core's own contract tables hold, read from core/api: the capability types, the drawer's verbs and the
// actions. Core defines these, so net.fetch or view.draw is not core knowing a plugin (D-639, D-643)
export const contract: ReadonlySet<string> = new Set([
  ...capabilityTypes, ...Object.keys(uiNeeds),
  ...Object.keys(coreActions), ...Object.keys(eventActions), ...Object.keys(providerActions),
])

// An id names its part, and so does an action or verb name starting with the id and a dot that no table holds, such as
// notify.show, an action of the notify plugin
export function partsOf(ids: ReadonlyMap<string, string>, held: ReadonlySet<string>): Known {
  return { get: name => ids.get(name) ?? (held.has(name) ? undefined : ids.get(/^([^.]+)\../.exec(name)?.[1] ?? '')) }
}
export const named: Known = partsOf(outside, contract)
export const constants: ReadonlyMap<string, string> = await apiConstants(named)

export const listed: readonly Place[] = [
  { place: 'lib/canonical.ts', text: "hidden: reached.some(isGitName) ? 'git'", hits: 1, why: 'the kind of hidden name a .git folder on the path is, not the git plugin' },
  { place: 'lib/canonical.ts', text: "refuse('git')", hits: 1, why: 'the refusal of a path inside a .git folder, not the git plugin' },
  { place: 'backend/providers/history/history.ts', text: "findProgram('git'", hits: 2, why: 'the git program history runs, not the git plugin' },
  { place: 'backend/policy/grant-risk-classifier/rules.ts', text: "'git', 'node', 'nodejs'", hits: 1, why: 'the git program among the commands that run others, not the git plugin' },
  { place: 'frontend/editor/ui-port.ts', text: "SKELETON = 'layout'", hits: 1, why: 'the surface the layout of the drawer draws on' },
  { place: 'backend/boot/state.ts', text: "droppedOff = ['watchdog', 'leases', 'net', 'hidden-marks']", hits: 2, why: 'a reader dropping retired ids from an old switches file (D-631)' },
  { place: 'backend/door/checks.ts', text: "route: 'mcp'", hits: 1, why: 'the route of the door\'s one endpoint, POST /mcp, named for the protocol and not the mcp plugin' },
]

// What fails: an id named outside the places listed and what listed-places.ts fails in a place
export function partProblems(found: readonly Named[], lineOf: (hit: Named) => string, places: readonly Place[]): string[] {
  const { unlisted, problems } = placeProblems(found, lineOf, places, 'naming a part')
  return [...unlisted.map(hit => `${hit.file}:${hit.line} ${hit.text} names ${hit.part}, a part hetu doesn't run in main`), ...problems]
}

const sources = new Map(files.map(file => [file, readFileSync(path.join(repo, file), 'utf8')]))
const relays = relaysOf(sources, constants)
const found = [...sources].flatMap(([file, source]) => namedIn(file, source, named, constants, relays))
const lineOf = (hit: Named) => sources.get(hit.file)!.split('\n')[hit.line - 1]

describe('the parts outside main the core names', () => {
  it('reads the shipped code of core/ but ids.ts, and the ids from ids.ts', () => {
    expect(files).toContain('core/api/actions.ts')
    expect(files).toContain('core/frontend/editor/ui-port.ts')
    expect(files).not.toContain('core/api/ids.ts')
    expect(files.every(file => /\.(ts|js)$/.test(file) && file.startsWith('core/'))).toBe(true)
    for (const id of ['mcp', 'git', 'layout', 'hidden-marks', 'leases']) expect(outside.has(id), id).toBe(true)
    for (const id of ['gate', 'luoshu', 'lock', 'core', 'plugin', 'net', doorId]) expect(outside.has(id), id).toBe(false)
  })

  it('names none outside the places listed, each still there and with its why', () => {
    expect(partProblems(found, lineOf, listed)).toEqual([])
  })
})

describe('the parts outside main check itself', () => {
  const at = 'core/backend/planted.ts'
  const problems = (source: string, places: readonly Place[] = [], held = constants, file = at, relays: Relays = new Map()) => {
    const lines = source.split('\n')
    return partProblems(namedIn(file, source, named, held, relays), hit => lines[hit.line - 1], places)
  }
  const git: Place = { place: 'backend/planted.ts', text: "findProgram('git')", hits: 1, why: 'the git program, not the plugin' }

  it.each([
    ["if (id === 'notify') {}", `${at}:1 'notify' names notify, a part hetu doesn't run in main`],
    ["const order = { 'hidden-marks': 1 }", `${at}:1 'hidden-marks' names hidden-marks, a part hetu doesn't run in main`],
    ["off.filter(id => id !== 'leases')", `${at}:1 'leases' names leases, a part hetu doesn't run in main`],
    ["if (caller.id === 'mcp') {}", `${at}:1 'mcp' names mcp, a part hetu doesn't run in main`],
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
      "const found = { real, hidden: reached.some(isGitName) ? 'git' : (id === 'notify' ? 'x' : 'dot') }", hidden,
      `backend/planted.ts "hidden: reached.some(isGitName) ? 'git'" covers 2 hits and lists 1: line 1 'git', line 1 'notify'`,
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

  // A plugin's own action or verb names its plugin, a name of core's contract does not (D-639)
  it.each([
    ["if (action === 'notify.show') {}", `${at}:1 'notify.show' names notify, a part hetu doesn't run in main`],
    ["if (call.verb === 'layout.secret') {}", `${at}:1 'layout.secret' names layout, a part hetu doesn't run in main`],
    ["send(owner, { topic: 'layout.secret', instance })", `${at}:1 'layout.secret' names layout, a part hetu doesn't run in main`],
    // The verb and the topics of the layout plugin left the tables with it
    ["if (call.verb === 'layout.draw') {}", `${at}:1 'layout.draw' names layout, a part hetu doesn't run in main`],
    ["send(owner, { topic: 'layout.state', state })", `${at}:1 'layout.state' names layout, a part hetu doesn't run in main`],
  ])('fails %j, a name no table of core holds', (source, problem) => {
    expect(problems(source)).toEqual([problem])
  })

  it.each([
    ["if (granted.type === 'net.fetch') {}", 'net.fetch'],
    ["if (call.verb === 'view.draw') {}", 'view.draw'],
  ])('passes %j, a name the tables of core/api hold', (source, name) => {
    expect(contract.has(name)).toBe(true)
    expect(problems(source)).toEqual([])
  })

  it('reads the tables from core/api and counts a constant holding a name no table holds', () => {
    for (const name of ['net.fetch', 'view.draw', 'editor.open', 'events.subscribe', 'luoshu.read', 'core.status']) expect(contract.has(name), name).toBe(true)
    for (const name of ['ui.layout', 'layout.draw', 'layout.state', 'layout.close']) expect(contract.has(name), name).toBe(false)
    expect(named.get('notify.show')).toBe('notify')
    expect(named.get('net.fetch')).toBe(undefined)
    expect(named.get('layout')).toBe('layout')
    expect(named.get('.git')).toBe(undefined)
    expect(problems("import { QUERY } from '../api/search.ts'\nf(QUERY)", [], new Map([['QUERY', 'search']]))).toEqual([
      `${at}:1 QUERY names search, a part hetu doesn't run in main`,
      `${at}:2 QUERY names search, a part hetu doesn't run in main`,
    ])
  })

  it.each([
    "if (caller.kind === 'plugin') {}",
    "const dir = path.join(root, '.git')",
    "// the layout plugin draws here\nconst x = 1",
    "import net from 'net'",
  ])('counts nothing in %j', source => {
    expect(problems(source)).toEqual([])
  })
})
