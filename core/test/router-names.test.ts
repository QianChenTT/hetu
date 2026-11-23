import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as actions from '../api/actions.ts'
import * as ids from '../api/ids.ts'
import { apiConstants, namedIn, relaysOf, type Named } from './named-parts.ts'
import { shippedFiles } from './shipped-files.ts'

// The router reaches each part through the contract's namespace table, so its code names no action and no part outside
// the parts listed here, each with why. A name counts as named-parts.ts counts it: a string or a constant of core/api
// holding exactly one name. Namespaces, caller kinds such as 'plugin', event topics and comments don't count

const repo = path.join(import.meta.dirname, '..', '..')
const files = shippedFiles({ kinds: ['ts'] }).filter(file => file.startsWith('core/backend/router/'))

// One entry per part the router names, with why
export const named: Readonly<Record<string, string>> = {
  gate: 'the policy job every call asks (D-540)',
  'flood-control': 'the router records its faults',
  lock: 'its deny answers `locked` (D-577)',
}

// An action names the part serving its namespace, an id the part of that id
const partOf = (name: string) => {
  const dot = name.indexOf('.')
  return dot === -1 ? name : ids.serverOf(name.slice(0, dot))?.part ?? name.slice(0, dot)
}

// Every name counted, with its part: the keys of the action tables and the ids of the lists in ids.ts. coreNamespaces
// holds namespaces only and reservedIds every namespace among the ids, so neither is read
const idLists = Object.entries(ids).filter(([key, value]) => Array.isArray(value) && key !== 'coreNamespaces' && key !== 'reservedIds')
export const names: ReadonlyMap<string, string> = new Map([
  ...Object.keys(actions.coreActions), ...Object.keys(actions.eventActions), ...Object.keys(actions.providerActions),
  ...Object.keys(actions.roleActions),
  ...idLists.flatMap(([, list]) => list as readonly string[]),
].map(name => [name, partOf(name)]))

// The exported constants of every core/api module that hold exactly one name, with its part
export const constants: ReadonlyMap<string, string> = await apiConstants(names)

// What fails: a part named and not listed, a listed part the router no longer names and a why under 10 characters
export function routerNameProblems(found: readonly Named[], listed: Readonly<Record<string, string>>): string[] {
  const problems = found.filter(hit => !Object.hasOwn(listed, hit.part))
    .map(hit => `${hit.file}:${hit.line} ${hit.text} names ${hit.part}, a part not on the list`)
  for (const [part, why] of Object.entries(listed)) {
    if (!found.some(hit => hit.part === part)) problems.push(`${part} is on the list and the router no longer names it: remove the entry`)
    if (why.length < 10) problems.push(`${part} has a why under 10 characters`)
  }
  return problems
}

// Every shipped file of core/, so a constant one of them hands on to the router counts too
const relays = relaysOf(new Map(shippedFiles({ kinds: ['ts'] }).map(file => [file, readFileSync(path.join(repo, file), 'utf8')])), constants)
const found = files.flatMap(file => namedIn(file, readFileSync(path.join(repo, file), 'utf8'), names, constants, relays))

describe('the parts the router names', () => {
  it('reads every file of the router and the names from the contract', () => {
    expect(files).toContain('core/backend/router/router.ts')
    expect(files).toContain('core/backend/router/provide.ts')
    expect(files.every(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))).toBe(true)
    expect(names.get('luoshu.write')).toBe('luoshu')
    expect(names.get('core.consentAnswer')).toBe('plugins-manager')
    // A role's action names the table its holder is found in
    expect(names.get('door.handle')).toBe('plugins-manager')
    expect(names.get('flood-control')).toBe('flood-control')
    expect(names.has('plugin')).toBe(false)
    expect(constants.get('LOCK_GUARD')).toBe('lock')
  })

  it('names only the parts listed, each still named and with its why', () => {
    expect(routerNameProblems(found, named)).toEqual([])
  })
})

describe('the router names check itself', () => {
  const at = 'core/backend/router/planted.ts'
  const problems = (source: string, listed: Readonly<Record<string, string>> = {}, held = constants) => routerNameProblems(namedIn(at, source, names, held), listed)
  const gate = { gate: 'the policy job' }

  it.each([
    ["c.policyJob('luoshu')", `${at}:1 'luoshu' names luoshu, a part not on the list`],
    ["if (call.action === 'luoshu.write') {}", `${at}:1 'luoshu.write' names luoshu, a part not on the list`],
    // An events action splits the bus block by action (D-540, D-635)
    ["if (call.action === 'events.publish') {}", `${at}:1 'events.publish' names router, a part not on the list`],
    ['const action = `lock.set`', `${at}:1 'lock.set' names lock, a part not on the list`],
    ["const table = { 'history.read': 1 }", `${at}:1 'history.read' names history, a part not on the list`],
    ["switch (id) {\n  case 'heartbeat': break\n}", `${at}:2 'heartbeat' names heartbeat, a part not on the list`],
  ])('fails %j', (source, problem) => {
    expect(problems(source)).toEqual([problem])
  })

  it('fails an imported constant holding one name unless its part is listed', () => {
    const source = "import { LOCK_GUARD, guardableActions } from '../../api/ids.ts'\nif (id === LOCK_GUARD) {}\n"
    expect(problems(source)).toEqual([
      `${at}:1 LOCK_GUARD names lock, a part not on the list`,
      `${at}:2 LOCK_GUARD names lock, a part not on the list`,
    ])
    expect(problems(source, { lock: 'its deny answers locked' })).toEqual([])
    expect(problems("import { LOCK_GUARD as GUARD } from '../../api/ids.ts'\nf(GUARD)")).toEqual([
      `${at}:1 LOCK_GUARD names lock, a part not on the list`,
      `${at}:2 LOCK_GUARD names lock, a part not on the list`,
    ])
    expect(problems("import * as ids from '../../api/ids.ts'\nf(ids.LOCK_GUARD)")).toEqual([`${at}:2 LOCK_GUARD names lock, a part not on the list`])
    expect(problems("import { GATE } from '../../api/ids.ts'\nc.policyJob(GATE)", {}, new Map([['GATE', 'gate']]))).toEqual([
      `${at}:1 GATE names gate, a part not on the list`,
      `${at}:2 GATE names gate, a part not on the list`,
    ])
  })

  it('fails a constant handed on by another file, through each step of a chain', () => {
    const relay = 'core/backend/router/relay.ts'
    const relays = relaysOf(new Map([
      [relay, "export { LOCK_GUARD } from '../../api/ids.ts'"],
      ['core/backend/router/all.ts', "export * from '../../api/ids.ts'"],
      ['core/backend/router/onward.ts', "import { LOCK_GUARD } from '../../api/ids.ts'\nexport { LOCK_GUARD as GUARD }"],
      ['core/backend/router/chain.ts', "export { GUARD as G } from './onward.ts'"],
    ]), constants)
    const lines = (source: string) => namedIn(at, source, names, constants, relays).map(hit => `${hit.line} ${hit.text}`)
    expect(namedIn(relay, "export { LOCK_GUARD } from '../../api/ids.ts'", names, constants).map(hit => hit.part)).toEqual(['lock'])
    expect(lines("import { LOCK_GUARD } from './relay.ts'\nf(LOCK_GUARD)")).toEqual(['1 LOCK_GUARD', '2 LOCK_GUARD'])
    expect(lines("import { LOCK_GUARD } from './all.ts'\nf(LOCK_GUARD)")).toEqual(['1 LOCK_GUARD', '2 LOCK_GUARD'])
    expect(lines("import { G } from './chain.ts'\nf(G)")).toEqual(['1 LOCK_GUARD', '2 LOCK_GUARD'])
    expect(lines("import * as r from './relay.ts'\nf(r.LOCK_GUARD)")).toEqual(['2 LOCK_GUARD'])
    expect(lines("import { LOCK_GUARD } from './elsewhere.ts'\nf(LOCK_GUARD)")).toEqual([])
  })

  it.each([
    ["import * as ids from '../../api/ids.ts'\nconst { LOCK_GUARD: guard } = ids\nf(guard)", [2, 3]],
    ["import * as ids from '../../api/ids.ts'\nf(ids['LOCK_GUARD'])", [2]],
    ["import * as ids from '../../api/ids.ts'\nconst i = ids\nconst j = i\nf(j.LOCK_GUARD)", [4]],
  ])('fails a constant read off a namespace in %j', (source, lines) => {
    expect(problems(source)).toEqual(lines.map(line => `${at}:${line} LOCK_GUARD names lock, a part not on the list`))
  })

  it('reads the single-name constants of every module of core/api', async () => {
    expect((await apiConstants(new Map([['mcp-http-handler', 'door']]))).get('doorId')).toBe('door')
  })

  it.each([
    "import net from 'net'",
    "export * from 'lock'",
    "export { x } from 'gate'",
    "if (caller.kind === 'plugin') {}",
    "bus.drop('events.dropped')",
    "// asks the 'gate' first\nconst x = 1",
    "const pathless = (topic: string) => topic.startsWith('core.')",
    "if (code === 'locked') {}",
    "import { LOCK_GUARD } from './elsewhere.ts'\nf(LOCK_GUARD)",
    "const LOCK_GUARD = 'x'\nf(c.gate)",
  ])('counts nothing in %j', source => {
    expect(problems(source)).toEqual([])
  })

  it('passes a listed part, fails a stale entry and a short why', () => {
    expect(problems("c.policyJob('gate')", gate)).toEqual([])
    expect(problems('const x = 1', gate)).toEqual(['gate is on the list and the router no longer names it: remove the entry'])
    expect(problems("c.policyJob('gate')", { gate: 'short' })).toEqual(['gate has a why under 10 characters'])
  })
})
