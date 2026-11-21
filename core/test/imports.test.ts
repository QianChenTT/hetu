import { readdirSync, readFileSync, statSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { parse } from 'acorn'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// imports point one way between hetu's own parts, by the arrows below, with no cycle. A part with a
// door is reached from outside only through its header.ts, which holds nothing but types, interfaces and constant
// values. main.ts and wire.ts join the parts and are the one place that imports their implementations

const core = path.join(import.meta.dirname, '..')
const repo = path.join(core, '..')

// Every module specifier a file names, as api-imports.test.ts reads them, each with whether it is an import of types
// only, plus a marker for anything that loads code another way. Comments are read too, which can only flag more
export function specifiers(source: string): { specifier: string, types: boolean }[] {
  const found: { specifier: string, types: boolean }[] = []
  for (const match of source.matchAll(/\b(import|export)\b(\s+type\b)?[^'"`;]*?\bfrom\s*(['"])([^'"]*)\3/g)) {
    found.push({ specifier: match[4], types: match[2] !== undefined })
  }
  // The same with a list in braces, which may hold comments with any character, over several lines
  for (const match of source.matchAll(/\b(import|export)(\s+type)?\s+(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*(['"])([^'"]*)\3/g)) {
    found.push({ specifier: match[4], types: match[2] !== undefined })
  }
  for (const match of source.matchAll(/\bimport\s*(['"])([^'"]*)\1/g)) found.push({ specifier: match[2], types: false })
  if (/\bimport\s*\(/.test(source)) found.push({ specifier: '<dynamic import>', types: false })
  if (/\brequire\s*\(/.test(source)) found.push({ specifier: '<require>', types: false })
  // Both patterns read most imports, so each specifier is kept once for each way it is imported
  return [...new Map(found.map(each => [`${each.types} ${each.specifier}`, each])).values()]
}

// The parts, each a folder or a file under core/ (or the repo for plugins), the longest match first. Tooling is
// everything that builds, tests or checks hetu and never ships in it
export const parts: readonly { part: string, under: string }[] = [
  { part: 'contract', under: 'core/api/' },
  { part: 'lib', under: 'core/lib/' },
  { part: 'tooling', under: 'core/sdk/build/' },
  { part: 'tooling', under: 'core/sdk/testing/' },
  { part: 'sdk', under: 'core/sdk/' },
  { part: 'tooling', under: 'core/build/' },
  { part: 'tooling', under: 'core/test/' },
  { part: 'page:editor', under: 'core/frontend/editor/' },
  { part: 'page:trusted', under: 'core/frontend/trusted/' },
  { part: 'page:workers', under: 'core/frontend/workers/' },
  { part: 'join', under: 'core/backend/main.ts' },
  { part: 'join', under: 'core/backend/wire.ts' },
  { part: 'backend-lib', under: 'core/backend/lib/' },
  { part: 'runtime', under: 'core/backend/runtime/' },
  { part: 'plugins-manager', under: 'core/backend/plugins-manager/' },
  { part: 'router', under: 'core/backend/router/' },
  { part: 'boot', under: 'core/backend/boot/' },
  { part: 'modules', under: 'core/backend/modules/' },
  { part: 'gate', under: 'core/backend/policy/gate/' },
  { part: 'grant-risk-classifier', under: 'core/backend/policy/grant-risk-classifier/' },
  { part: 'storage', under: 'core/backend/providers/storage/' },
  { part: 'luoshu', under: 'core/backend/providers/luoshu/' },
  { part: 'history', under: 'core/backend/providers/history/' },
  { part: 'exec', under: 'core/backend/providers/exec/' },
  { part: 'flood-control', under: 'core/backend/flood-control/' },
  { part: 'heartbeat', under: 'core/backend/heartbeat/' },
  { part: 'lock', under: 'core/backend/lock/' },
  { part: 'recording', under: 'core/backend/recording/' },
  { part: 'security-view', under: 'core/backend/security-view/' },
  { part: 'tooling', under: 'scripts/' },
]

// A plugin's own code is its src folder. Its build script and tests are tooling
const pluginSource = /^core-plugins\/[^/]+\/src\//

// What each part may import besides itself. The contract imports nothing but zod. lib, the SDK and the pages
// only the contract, the backend's lib the contract and lib. The router the contract, the libs and the doors of flood
// control and recording, boot only the contract and the libs.
// The plugins manager the router, boot, the runtime, the core modules, the heartbeat, recording and the security view,
// each through its door. The runtime the
// router and boot through their doors (the runtime's types sit in its own door, so the plugins manager imports the runtime and not the other way). The
// core modules: the holder reads the modules through their doors and each module the contract alone or with lib
// (the build bounds their Node built-ins). The joins and tooling may import anything. Plugins import the
// contract and the SDK, by their package names
export const arrows: Readonly<Record<string, readonly string[]>> = {
  contract: [],
  lib: ['contract'],
  sdk: ['contract'],
  'page:editor': ['contract'],
  'page:trusted': ['contract'],
  'page:workers': ['contract'],
  'backend-lib': ['contract', 'lib'],
  router: ['contract', 'lib', 'backend-lib', 'flood-control', 'recording'],
  boot: ['contract', 'lib', 'backend-lib'],
  'plugins-manager': ['contract', 'lib', 'backend-lib', 'router', 'boot', 'runtime', 'modules', 'heartbeat', 'recording', 'security-view'],
  runtime: ['contract', 'lib', 'backend-lib', 'router', 'boot'],
  modules: ['contract', 'lib', 'backend-lib', 'luoshu', 'history', 'exec', 'flood-control', 'heartbeat', 'lock', 'security-view'],
  gate: ['contract'],
  'grant-risk-classifier': ['contract'],
  storage: ['contract', 'lib'],
  luoshu: ['contract', 'lib'],
  history: ['contract', 'lib'],
  exec: ['contract', 'lib'],
  'flood-control': ['contract'],
  heartbeat: ['contract'],
  lock: ['contract', 'lib'],
  recording: ['contract', 'lib'],
  'security-view': ['contract'],
  plugin: ['contract', 'sdk'],
  join: ['*'],
  tooling: ['*'],
}

// The parts reached from outside only through their header.ts. The gate, the classifier and storage are in no part's
// row but the joins', which build them, so nothing else may import them and they need no door
export const doors = new Set(['router', 'plugins-manager', 'boot', 'runtime', 'modules', 'luoshu', 'history', 'exec', 'flood-control', 'heartbeat', 'lock', 'recording', 'security-view'])

// Files outside the arrows, each with its reason. The utility process's own bootstrap runs in its own process and not
// in main: it is bundled apart into utility.js and runs a utility half through the SDK's runner, so it and the check
// it alone uses import the SDK
export const exceptions: Readonly<Record<string, { may: readonly string[], dynamic?: true, why: string }>> = {
  'core/backend/runtime/utility-child.ts': {
    may: ['sdk'], dynamic: true,
    why: 'the utility process\'s bootstrap, bundled apart into utility.js, imports a utility half\'s verified bytes and runs it with the SDK\'s runner',
  },
  'core/backend/runtime/hosts.ts': { may: ['sdk'], why: 'the check utility-child.ts alone uses on a utility half\'s default export, typed by the SDK\'s runner' },
}

const posix = (file: string) => file.split(path.sep).join('/')

export function partOf(file: string): string | null {
  if (file.startsWith('core-plugins/')) return pluginSource.test(file) ? 'plugin' : 'tooling'
  return parts.find(({ under }) => file === under || file.startsWith(under))?.part ?? null
}

function shipped(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|js)$/.test(name) && !name.endsWith('.d.ts')) files.push(posix(path.relative(repo, full)))
    }
  }
  for (const dir of ['core/api', 'core/lib', 'core/sdk', 'core/frontend', 'core/backend', 'core-plugins']) walk(path.join(repo, dir))
  return files.filter(file => partOf(file) !== 'tooling').sort()
}

// What one file may not import: each problem as text. A relative specifier is resolved against the file. A plugin
// imports hetu only by package name
export function problemsOf(file: string, source: string): string[] {
  const from = partOf(file)
  if (from === null) return [`${file} belongs to no part`]
  const allowed = arrows[from]
  const problems: string[] = []
  for (const { specifier, types } of specifiers(source)) {
    if (specifier === '<dynamic import>' || specifier === '<require>') {
      if (from !== 'tooling' && from !== 'join' && exceptions[file]?.dynamic !== true) problems.push(`${file}: ${specifier}`)
      continue
    }
    // hetu's own packages are its parts under another name: hetu-core/<path> is core/<path> and @hetu/sdk the SDK, its
    // build checks tooling. Any other package is outside this check
    const own = specifier.startsWith('hetu-core/') ? `core/${specifier.slice('hetu-core/'.length)}`
      : /^@hetu\/sdk\/(?:check-manifest|esbuild)$/.test(specifier) ? 'core/sdk/build/'
        : /^@hetu\/sdk(?:\/|$)/.test(specifier) ? 'core/sdk/index.ts'
          : null
    if (!specifier.startsWith('.') && own === null) continue
    const target = own ?? posix(path.relative(repo, path.resolve(repo, path.dirname(file), specifier)))
    const to = partOf(target)
    if (to === null) {
      problems.push(`${file} imports ${target}, in no part`)
      continue
    }
    if (to === from) continue
    if (to === 'tooling') {
      problems.push(`${file} imports tooling ${target}`)
      continue
    }
    const excepted = exceptions[file]?.may.includes(to) ?? false
    if (!allowed.includes('*') && !allowed.includes(to) && !excepted) {
      problems.push(`${file} (${from}) imports ${target} (${to})`)
      continue
    }
    if (doors.has(to) && from !== 'join' && from !== 'tooling' && !target.endsWith('/header.ts')) {
      problems.push(`${file} imports ${target}${types ? ' (types)' : ''}, past ${to}'s header.ts`)
    }
  }
  return problems
}

// A constant value: a literal, an array or a plain object of constant values, or one frozen. No call but
// Object.freeze, no method, no getter, nothing computed
type Node = { type: string, [key: string]: unknown }
function constant(node: Node | null): boolean {
  if (node === null) return false
  switch (node.type) {
    case 'Literal':
      return true
    case 'TemplateLiteral':
      return (node.expressions as Node[]).length === 0
    case 'UnaryExpression':
      return node.operator === '-' && constant(node.argument as Node)
    case 'ArrayExpression':
      return (node.elements as (Node | null)[]).every(constant)
    case 'ObjectExpression':
      return (node.properties as Node[]).every(property => property.type === 'Property' && property.kind === 'init' && property.method === false
        && property.computed === false && constant(property.value as Node))
    case 'CallExpression': {
      const callee = node.callee as Node
      const freezes = callee.type === 'MemberExpression' && (callee.object as Node).type === 'Identifier' && (callee.object as Node).name === 'Object'
        && (callee.property as Node).type === 'Identifier' && (callee.property as Node).name === 'freeze' && callee.computed === false
      const args = node.arguments as Node[]
      return freezes && args.length === 1 && constant(args[0])
    }
    default:
      return false
  }
}

// A header holds definitions only: types, interfaces and constant values and imports of types alone. Read
// with its types stripped by Node, which leaves only the code that would run, each in its place, then parsed: every
// statement left must be a const of a constant value
export function headerProblems(file: string, source: string): string[] {
  const problems: string[] = []
  const code = stripTypeScriptTypes(source, { mode: 'strip' })
  const tree = parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) as unknown as { body: Node[] }
  for (const statement of tree.body) {
    const line = (statement.loc as { start: { line: number } }).start.line
    if (statement.type === 'EmptyStatement') continue
    if (statement.type === 'ImportDeclaration') {
      problems.push(`${file}:${line} imports ${(statement.source as Node).value} for more than its types`)
      continue
    }
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration as Node | null : statement
    const constants = declaration?.type === 'VariableDeclaration' && declaration.kind === 'const'
      && (declaration.declarations as Node[]).every(each => constant(each.init as Node | null))
    if (!constants) problems.push(`${file}:${line} holds code that runs (${declaration?.type ?? statement.type})`)
  }
  return problems
}

const files = shipped()

describe('imports point one way', () => {
  it('has files to check in every part', () => {
    const seen = new Set(files.map(partOf))
    for (const part of Object.keys(arrows).filter(part => part !== 'tooling')) expect(seen, part).toContain(part)
  })

  it('places every shipped file in a part', () => {
    expect(files.filter(file => partOf(file) === null)).toEqual([])
  })

  it('holds every shipped file to its part\'s arrows and every door to its header', () => {
    const problems = files.flatMap(file => problemsOf(file, readFileSync(path.join(repo, file), 'utf8')))
    expect(problems).toEqual([])
  })

  it('lists only exceptions that still exist and still need it', () => {
    for (const [file, { may }] of Object.entries(exceptions)) {
      const source = readFileSync(path.join(repo, file), 'utf8')
      const reaches = specifiers(source).filter(({ specifier }) => specifier.startsWith('.'))
        .map(({ specifier }) => partOf(posix(path.relative(repo, path.resolve(repo, path.dirname(file), specifier)))))
      for (const part of may) expect(reaches, `${file} still imports ${part}`).toContain(part)
    }
  })

  it('has no cycle among the parts\' arrows', () => {
    const visiting = new Set<string>()
    const done = new Set<string>()
    const cycle: string[] = []
    const visit = (part: string): boolean => {
      if (done.has(part)) return false
      if (visiting.has(part)) return true
      visiting.add(part)
      for (const next of arrows[part] ?? []) {
        if (next !== '*' && visit(next)) {
          cycle.push(part)
          return true
        }
      }
      visiting.delete(part)
      done.add(part)
      return false
    }
    for (const part of Object.keys(arrows)) visit(part)
    expect(cycle).toEqual([])
  })

  it('has no cycle among hetu\'s own files', () => {
    const graph = new Map<string, string[]>()
    for (const file of files) {
      const source = readFileSync(path.join(repo, file), 'utf8')
      graph.set(file, specifiers(source).filter(({ specifier }) => specifier.startsWith('.'))
        .map(({ specifier }) => posix(path.relative(repo, path.resolve(repo, path.dirname(file), specifier)))))
    }
    const state = new Map<string, 'open' | 'closed'>()
    const found: string[][] = []
    const walk = (file: string, trail: string[]) => {
      if (state.get(file) === 'closed') return
      if (state.get(file) === 'open') {
        found.push([...trail.slice(trail.indexOf(file)), file])
        return
      }
      state.set(file, 'open')
      for (const next of graph.get(file) ?? []) if (graph.has(next)) walk(next, [...trail, file])
      state.set(file, 'closed')
    }
    for (const file of graph.keys()) walk(file, [])
    expect(found).toEqual([])
  })
})

describe('one door per part, header.ts', () => {
  it.each([...doors])('%s has a header.ts holding definitions only', part => {
    const under = parts.find(entry => entry.part === part)!.under
    const header = path.join(repo, under, 'header.ts')
    expect(headerProblems(`${under}header.ts`, readFileSync(header, 'utf8'))).toEqual([])
  })

  it('leaves no file named seams.ts', () => {
    expect(files.filter(file => file.endsWith('/seams.ts'))).toEqual([])
  })

  it('names no folder utils, helpers, common or misc', () => {
    expect(files.filter(file => /\/(utils|helpers|common|misc)\//.test(file))).toEqual([])
  })
})

describe('the check itself', () => {
  it.each([
    ['core/backend/router/bus.ts', "import { boot } from '../boot/boot.ts'", 'core/backend/router/bus.ts (router) imports core/backend/boot/boot.ts (boot)'],
    ['core/backend/plugins-manager/graph.ts', "import type { Booted } from '../boot/boot.ts'", 'core/backend/plugins-manager/graph.ts imports core/backend/boot/boot.ts (types), past boot\'s header.ts'],
    ['core/backend/runtime/windows.ts', "import { coreKeyOf } from '../../frontend/editor/keys.ts'", 'core/backend/runtime/windows.ts (runtime) imports core/frontend/editor/keys.ts (page:editor)'],
    ['core/frontend/trusted/view.ts', "import type { Port } from '../../backend/router/header.ts'", 'core/frontend/trusted/view.ts (page:trusted) imports core/backend/router/header.ts (router)'],
    ['core/api/ids.ts', "export * from '../lib/disk.ts'", 'core/api/ids.ts (contract) imports core/lib/disk.ts (lib)'],
    ['core/backend/policy/gate/gate.ts', "import { clean } from '../../../lib/clean-env.ts'", 'core/backend/policy/gate/gate.ts (gate) imports core/lib/clean-env.ts (lib)'],
    ['core/backend/providers/luoshu/luoshu.ts', "import type { Exec } from '../exec/header.ts'", 'core/backend/providers/luoshu/luoshu.ts (luoshu) imports core/backend/providers/exec/header.ts (exec)'],
    ['core/backend/router/router.ts', "import { x } from '../../test/hold.ts'", 'core/backend/router/router.ts imports tooling core/test/hold.ts'],
    ['core/lib/disk.ts', "const fs = await import('node:fs')", 'core/lib/disk.ts: <dynamic import>'],
    ['core-plugins/search/src/index.ts', "import { x } from 'hetu-core/lib/disk.ts'", 'core-plugins/search/src/index.ts (plugin) imports core/lib/disk.ts (lib)'],
  ])('refuses %s importing past the arrows: %j', (file, source, problem) => {
    expect(problemsOf(file, source)).toEqual([problem])
  })

  it.each([
    ['core/backend/plugins-manager/graph.ts', "import type { Booted } from '../boot/header.ts'"],
    ['core/backend/wire.ts', "import { Router } from './router/router.ts'"],
    ['core/backend/router/bus.ts', "import { pathProblem } from '../../api/scope.ts'"],
    ['core/backend/runtime/utility-child.ts', "import { runInUtility } from '../../sdk/utility.ts'"],
  ])('lets %s import %j', (file, source) => {
    expect(problemsOf(file, source)).toEqual([])
  })

  it.each([
    ['export function f() {}', 'holds code that runs (FunctionDeclaration)'],
    ['export const f = () => 1', 'holds code that runs (VariableDeclaration)'],
    ['export class C {}', 'holds code that runs (ClassDeclaration)'],
    ['export let n = 1', 'holds code that runs (VariableDeclaration)'],
    ['export const o = { f() { return 1 } }', 'holds code that runs (VariableDeclaration)'],
    ['export const o = { get f() { return 1 } }', 'holds code that runs (VariableDeclaration)'],
    ['export const o = Date.now()', 'holds code that runs (VariableDeclaration)'],
    ['export const o = new Map()', 'holds code that runs (VariableDeclaration)'],
    ["export const u = 'http://a', f = () => 1", 'holds code that runs (VariableDeclaration)'],
    ["console.log('x')", 'holds code that runs (ExpressionStatement)'],
    ['if (globalThis.x) {}', 'holds code that runs (IfStatement)'],
    ['export default 1', 'holds code that runs (ExportDefaultDeclaration)'],
    ["export { x } from './x.ts'", 'holds code that runs (ExportNamedDeclaration)'],
    ["import { x } from './x.ts'", 'imports ./x.ts for more than its types'],
  ])('refuses a header that %j', (source, problem) => {
    expect(headerProblems('h/header.ts', source)).toEqual([`h/header.ts:1 ${problem}`])
  })

  it('takes a header of types, interfaces, constant values and imports of types', () => {
    const source = "import type { A } from './a.ts'\nexport type B = { a: A, f: (x: number) => string }\nexport interface C { b: B }\nexport const D = 3\n"
      + "export const E = Object.freeze({ a: Object.freeze(['x'] as const), b: -1, c: `t` })\nexport type { F } from './f.ts'\n"
    expect(headerProblems('h/header.ts', source)).toEqual([])
  })

  it('reads an import whose list spans lines with comments holding quotes and semicolons', () => {
    const source = "import {\n  a, // the router's; own\n  type b,\n} from '../boot/boot.ts'\n"
    expect(problemsOf('core/backend/plugins-manager/graph.ts', source)).toEqual([
      'core/backend/plugins-manager/graph.ts imports core/backend/boot/boot.ts, past boot\'s header.ts',
    ])
  })

  it('reads hetu-core and @hetu/sdk as the parts they name', () => {
    expect(problemsOf('core/frontend/trusted/view.ts', "import { x } from 'hetu-core/lib/disk.ts'")).toEqual([
      'core/frontend/trusted/view.ts (page:trusted) imports core/lib/disk.ts (lib)',
    ])
    expect(problemsOf('core-plugins/search/src/index.ts', "import { definePlugin } from '@hetu/sdk'")).toEqual([])
    expect(problemsOf('core-plugins/search/src/index.ts', "import { buildPlugin } from '@hetu/sdk/esbuild'")).toEqual([
      'core-plugins/search/src/index.ts imports tooling core/sdk/build/',
    ])
  })

  it('lets no part but the joins import the gate, the classifier or storage', () => {
    expect(problemsOf('core/backend/modules/modules.ts', "import { createGate } from '../policy/gate/gate.ts'")).toEqual([
      'core/backend/modules/modules.ts (modules) imports core/backend/policy/gate/gate.ts (gate)',
    ])
  })
})
