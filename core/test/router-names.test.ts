import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { parse, type Node } from 'acorn'
import { simple } from 'acorn-walk'
import { describe, expect, it } from 'vitest'
import * as actions from '../api/actions.ts'
import * as ids from '../api/ids.ts'
import { shippedFiles } from './shipped-files.ts'

// The router reaches each part through the contract's namespace table, so its code names no action and no part outside
// the parts listed here, each with why. A name counts as a string or as a constant of ids.ts or actions.ts it imports
// that holds exactly one name. Namespaces, caller kinds such as 'plugin', event topics and comments don't count

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
  ...idLists.flatMap(([, list]) => list as readonly string[]),
].map(name => [name, partOf(name)]))

// The exported constants of ids.ts and actions.ts that hold exactly one name, with its part
export const constants: ReadonlyMap<string, string> = new Map(Object.entries({ ...ids, ...actions })
  .flatMap(([key, value]) => typeof value === 'string' && names.has(value) ? [[key, names.get(value)!] as const] : []))

export type Named = { file: string, line: number, part: string, text: string }

// Each place a file names a part
export function namedIn(file: string, source: string, known = names, held = constants): Named[] {
  // Strip mode blanks the types and keeps every line where it was, so the parser's lines are the file's
  const program = parse(stripTypeScriptTypes(source, { mode: 'strip' }), { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  const found: Named[] = []
  const add = (node: Node, text: string, part: string | undefined) => {
    if (part !== undefined) found.push({ file, line: node.loc!.start.line, part, text })
  }
  const literal = (node: Node, value: unknown) => {
    if (typeof value === 'string') add(node, `'${value}'`, known.get(value))
  }
  // Read first, so a use above its import counts too: each constant imported by its name and each namespace import
  const local = new Map<string, string>()
  const spaces = new Set<string>()
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || !/(^|\/)api\/(ids|actions)\.ts$/.test(String(statement.source.value))) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') spaces.add(specifier.local.name)
      if (specifier.type !== 'ImportSpecifier') continue
      const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value)
      if (!held.has(name)) continue
      local.set(specifier.local.name, name)
      add(specifier, name, held.get(name))
    }
  }
  // A key in quotes is no expression, so the walk passes it by
  const key = (node: { computed: boolean, key: Node }) => {
    if (!node.computed && node.key.type === 'Literal') literal(node.key, (node.key as Node & { value: unknown }).value)
  }
  simple(program, {
    Literal(node) { literal(node, node.value) },
    TemplateLiteral(node) { if (node.expressions.length === 0) literal(node, node.quasis[0].value.cooked) },
    Property: key,
    PropertyDefinition: key,
    MethodDefinition: key,
    Identifier(node) {
      const name = local.get(node.name)
      if (name !== undefined) add(node, name, held.get(name))
    },
    MemberExpression(node) {
      if (node.object.type !== 'Identifier' || !spaces.has(node.object.name) || node.property.type !== 'Identifier') return
      add(node, node.property.name, held.get(node.property.name))
    },
  })
  return found.sort((a, b) => a.line - b.line)
}

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

const found = files.flatMap(file => namedIn(file, readFileSync(path.join(repo, file), 'utf8')))

describe('the parts the router names', () => {
  it('reads every file of the router and the names from the contract', () => {
    expect(files).toContain('core/backend/router/router.ts')
    expect(files).toContain('core/backend/router/provide.ts')
    expect(files.every(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))).toBe(true)
    expect(names.get('luoshu.write')).toBe('luoshu')
    expect(names.get('core.consentAnswer')).toBe('plugins-manager')
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

  it.each([
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
