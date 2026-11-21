import { readdirSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse, type Node, type Program } from 'acorn'
import { simple } from 'acorn-walk'

// Where a file names a part, for the checks that count them. A name counts as a string or as a constant of a core/api
// module that holds exactly one name: imported by its name, read off a namespace import or a const holding one,
// destructured from one or handed on by another file's export. The sources of imports and exports name modules and
// don't count. Beyond the check: an array of names indexed, a name built by + or ${}, a local shadowing a constant

const repo = path.join(import.meta.dirname, '..', '..')
const isApi = (module: string) => /^core\/api\/[^/]+\.ts$/.test(module)
// A relative source from the file's folder, any other as written
const resolve = (file: string, source: string) => (source.startsWith('.') ? path.posix.join(path.posix.dirname(file), source) : source)
// Strip mode blanks the types and keeps every line where it was, so the parser's lines are the file's
const parsed = (source: string) => parse(stripTypeScriptTypes(source, { mode: 'strip' }), { ecmaVersion: 'latest', sourceType: 'module', locations: true })

export type Named = { file: string, line: number, part: string, text: string }
// The part a name stands for, undefined when it stands for none
export type Known = Pick<ReadonlyMap<string, string>, 'get'>
// Each file that hands on constants of core/api, by the name it exports them under
export type Relays = ReadonlyMap<string, ReadonlyMap<string, string>>

// The exported constants of every core/api module that hold exactly one name, with its part
export async function apiConstants(known: Known): Promise<Map<string, string>> {
  const dir = path.join(repo, 'core', 'api')
  const held = new Map<string, string>()
  for (const name of readdirSync(dir).filter(name => name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(name)).sort()) {
    const module = await import(pathToFileURL(path.join(dir, name)).href) as Record<string, unknown>
    for (const [key, value] of Object.entries(module)) {
      const part = typeof value === 'string' ? known.get(value) : undefined
      if (part !== undefined) held.set(key, part)
    }
  }
  return held
}

type Scan = { found: Named[], exports: Map<string, string> }

function scan(file: string, program: Program, known: Known, held: ReadonlyMap<string, string>, relays: Relays): Scan {
  const found: Named[] = []
  const exports = new Map<string, string>()
  const add = (node: Node, text: string, part: string | undefined) => {
    if (part !== undefined) found.push({ file, line: node.loc!.start.line, part, text })
  }
  const constant = (name: string) => (held.has(name) ? name : undefined)
  // The constant a module hands out under a name: a core/api module its own, another file what it relays
  const from = (module: string) => (isApi(module) ? constant : (name: string) => relays.get(module)?.get(name))
  const nameOf = (node: Node) => (node.type === 'Identifier' ? (node as Node & { name: string }).name : String((node as Node & { value: unknown }).value))
  const sources = new Set<Node>()
  // Read first, so a use above its import counts too: each constant imported by its name and each namespace import
  const local = new Map<string, string>()
  const spaces = new Map<string, (name: string) => string | undefined>()
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      sources.add(statement.source)
      const module = from(resolve(file, String(statement.source.value)))
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') spaces.set(specifier.local.name, module)
        if (specifier.type !== 'ImportSpecifier') continue
        const name = module(nameOf(specifier.imported))
        if (name === undefined) continue
        local.set(specifier.local.name, name)
        add(specifier, name, held.get(name))
      }
    }
    if (statement.type === 'ExportAllDeclaration') {
      sources.add(statement.source)
      const module = resolve(file, String(statement.source.value))
      if (statement.exported !== null) continue
      const all = isApi(module) ? [...held.keys()].map(name => [name, name] as const) : relays.get(module) ?? []
      for (const [name, constant] of all) exports.set(name, constant)
    }
  }
  // Exports after imports, since one without a source hands on an import
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration') continue
    if (statement.source) sources.add(statement.source)
    const module = statement.source ? from(resolve(file, String(statement.source.value))) : (name: string) => local.get(name)
    for (const specifier of statement.specifiers) {
      const name = module(nameOf(specifier.local))
      if (name === undefined) continue
      exports.set(nameOf(specifier.exported), name)
      if (statement.source) add(specifier, name, held.get(name))
    }
  }
  // A const holding a namespace is one too, and so is a const holding that
  for (let grew = true; grew;) {
    grew = false
    simple(program, {
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier' || node.init?.type !== 'Identifier' || spaces.has(node.id.name)) return
        const space = spaces.get(node.init.name)
        if (space === undefined) return
        spaces.set(node.id.name, space)
        grew = true
      },
    })
  }
  const literal = (node: Node, value: unknown) => {
    if (typeof value === 'string' && !sources.has(node)) add(node, `'${value}'`, known.get(value))
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
      const space = node.object.type === 'Identifier' ? spaces.get(node.object.name) : undefined
      if (space === undefined) return
      const property = node.computed ? (node.property.type === 'Literal' ? node.property.value : undefined) : nameOf(node.property)
      const name = typeof property === 'string' ? space(property) : undefined
      if (name !== undefined) add(node, name, held.get(name))
    },
    // const { LOCK_GUARD } = ids, each key a constant of the namespace and its local name one from then on
    VariableDeclarator(node) {
      const space = node.id.type === 'ObjectPattern' && node.init?.type === 'Identifier' ? spaces.get(node.init.name) : undefined
      if (space === undefined || node.id.type !== 'ObjectPattern') return
      for (const property of node.id.properties) {
        if (property.type !== 'Property' || property.computed) continue
        const name = space(nameOf(property.key))
        if (name === undefined) continue
        if (property.value.type === 'Identifier') local.set(property.value.name, name)
        add(property, name, held.get(name))
      }
    },
  })
  return { found: found.sort((a, b) => a.line - b.line), exports }
}

// Each place a file names a part
export function namedIn(file: string, source: string, known: Known, held: ReadonlyMap<string, string>, relays: Relays = new Map()): Named[] {
  return scan(file, parsed(source), known, held, relays).found
}

// The files that hand on constants of core/api, each read again until a chain of them is followed to its end
export function relaysOf(sources: ReadonlyMap<string, string>, held: ReadonlyMap<string, string>): Relays {
  const programs = new Map([...sources].map(([file, source]) => [file, parsed(source)]))
  const relays = new Map<string, Map<string, string>>()
  for (let size = -1, next = 0; next !== size;) {
    size = next
    for (const [file, program] of programs) {
      const exports = scan(file, program, new Map(), held, relays).exports
      if (exports.size > 0) relays.set(file, exports)
    }
    next = [...relays.values()].reduce((sum, exports) => sum + exports.size, 0)
  }
  return relays
}
