import { readdirSync, readFileSync, statSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { parse, type AnyNode, type Function as Fn } from 'acorn'
import { ancestor } from 'acorn-walk'
import { describe, expect, it } from 'vitest'
import { shippedFiles } from './shipped-files.ts'
import { sizeExceptions } from './size-exceptions.ts'

// a size ratchet. No shipped file may cross 800 lines and a file on size-exceptions.ts may not cross its own
// cap. A file of logic over 400 lines and a function over 80 get a warning, printed and never failing, for the review
// question "one reason to change?"

export const FILE_LIMIT = 800
export const FILE_WARNING = 400
export const FUNCTION_WARNING = 80

const core = path.join(import.meta.dirname, '..')
const repo = path.join(core, '..')
const posix = (file: string) => file.split(path.sep).join('/')

// Shipped code: what hetu runs, not its tests, build tooling or the SDK's testing and build helpers
function shipped(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'test' || name === 'testing') continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|js|css|html)$/.test(name) && !/\.(test|d)\.ts$/.test(name)) files.push(posix(path.relative(repo, full)))
    }
  }
  for (const dir of ['core/api', 'core/lib', 'core/sdk', 'core/frontend', 'core/backend']) walk(path.join(repo, dir))
  return files.filter(file => !file.startsWith('core/sdk/build/')).sort()
}

// Lines as wc -l counts them, a last line with no newline included
export function lineCount(source: string): number {
  if (source === '') return 0
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0)
}

// A function's name where it has one: its own, the variable, property or field it is assigned to, a method's key,
// each method or field under its class's name
function nameOf(node: Fn, ancestors: AnyNode[], source: string): string {
  const parent = ancestors[ancestors.length - 2]
  const key = (k: AnyNode): string => k.type === 'Identifier' ? k.name : k.type === 'PrivateIdentifier' ? `#${k.name}` : source.slice(k.start, k.end)
  const owner = () => {
    const held = ancestors.slice(0, -2).reverse().find(n => n.type === 'ClassDeclaration' || n.type === 'ClassExpression')
    return held !== undefined && 'id' in held && held.id ? `${held.id.name}.` : ''
  }
  if (parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') return `${owner()}${key(parent.key)}`
  if (parent?.type === 'Property') return key(parent.key)
  if (parent?.type === 'VariableDeclarator') return key(parent.id)
  if (parent?.type === 'AssignmentExpression') return source.slice(parent.left.start, parent.left.end)
  if (node.id) return node.id.name
  return '(anonymous)'
}

function parsed(source: string, typescript: boolean) {
  // Strip mode blanks the types and keeps every line where it was, so the parser's lines are the file's
  const code = typescript ? stripTypeScriptTypes(source, { mode: 'strip' }) : source
  return parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
}

// Every function in a file: declarations, function expressions, arrow functions and class methods, callbacks
// included, each with the line it starts on and its length in lines
export function functionsOf(source: string, typescript = true): { name: string, line: number, lines: number }[] {
  const found: { at: number, name: string, line: number, lines: number }[] = []
  ancestor(parsed(source, typescript), {
    Function(node, _state, ancestors) {
      const { start, end } = node.loc!
      found.push({ at: node.start, name: nameOf(node, ancestors, source), line: start.line, lines: end.line - start.line + 1 })
    },
  }, undefined, {})
  // The walk reaches an inner function before the one holding it, so they are put back in the order of the source
  return found.sort((a, b) => a.at - b.at).map(({ name, line, lines }) => ({ name, line, lines }))
}

// A file of definitions only holds types, interfaces, constants and schemas: no function and no class
export function definitionsOnly(source: string, typescript = true): boolean {
  let logic = false
  ancestor(parsed(source, typescript), {
    Function() { logic = true },
    Class() { logic = true },
  }, undefined, {})
  return !logic
}

// What fails: a file over 800 lines that isn't listed, a listed file over its cap and a listed file that is gone or
// back under 800, so the list stays honest
export function sizeProblems(lines: ReadonlyMap<string, number>, exceptions: typeof sizeExceptions): string[] {
  const problems: string[] = []
  for (const [file, count] of lines) {
    const listed = exceptions[file]
    if (listed === undefined && count > FILE_LIMIT) problems.push(`${file} has ${count} lines, over ${FILE_LIMIT}`)
    if (listed !== undefined && count > listed.cap) problems.push(`${file} has ${count} lines, over its cap of ${listed.cap}`)
    // The ratchet: a listed file that shrank lowers its cap in the same change, so it can't grow back
    if (listed !== undefined && count < listed.cap && count > FILE_LIMIT) problems.push(`${file} has ${count} lines, under its cap of ${listed.cap}: lower the cap to ${count}`)
  }
  for (const [file, { cap }] of Object.entries(exceptions)) {
    const count = lines.get(file)
    if (count === undefined) problems.push(`${file} is listed with a cap of ${cap} and no longer exists`)
    else if (count <= FILE_LIMIT) problems.push(`${file} has ${count} lines, no more than ${FILE_LIMIT} and is still listed`)
  }
  return problems
}

// What only warns: a file of logic over 400 lines and a function over 80. CSS and HTML have no functions
export function sizeWarnings(file: string, source: string): string[] {
  if (!/\.(ts|js)$/.test(file)) return []
  const typescript = file.endsWith('.ts')
  const warnings: string[] = []
  const count = lineCount(source)
  if (count > FILE_WARNING && !definitionsOnly(source, typescript)) warnings.push(`${file}: ${count} lines of logic`)
  for (const { name, line, lines } of functionsOf(source, typescript)) {
    if (lines > FUNCTION_WARNING) warnings.push(`${file}:${line}: ${name} has ${lines} lines`)
  }
  return warnings
}

const files = shipped()
const sources = new Map(files.map(file => [file, readFileSync(path.join(repo, file), 'utf8')]))

describe('the size ratchet', () => {
  it('has files to check in every shipped folder', () => {
    for (const dir of ['core/api/', 'core/lib/', 'core/sdk/', 'core/frontend/', 'core/backend/', 'core/backend/door/']) {
      expect(files.some(file => file.startsWith(dir)), dir).toBe(true)
    }
    expect(files.filter(file => /\/(test|testing)\/|^core\/sdk\/build\/|\.test\.ts$/.test(file))).toEqual([])
  })

  it('holds every shipped file to 800 lines, or a listed file to its own cap', () => {
    const lines = new Map([...sources].map(([file, source]) => [file, lineCount(source)]))
    expect(sizeProblems(lines, sizeExceptions)).toEqual([])
  })

  it('gives every exception a cap and a reason', () => {
    for (const [file, { cap, why }] of Object.entries(sizeExceptions)) {
      expect(cap, file).toBeGreaterThan(FILE_LIMIT)
      expect(why.length, file).toBeGreaterThan(0)
    }
  })

  // Warnings only: they go to the run's output for a person to read and fail nothing
  it('warns on the files of logic over 400 lines and the functions over 80', () => {
    const warnings = [...sources].flatMap(([file, source]) => sizeWarnings(file, source))
    if (warnings.length > 0) {
      console.warn(`Size warnings, files of logic over ${FILE_WARNING} lines and functions over ${FUNCTION_WARNING}:\n${warnings.map(line => `  ${line}`).join('\n')}`)
    }
  })
  // The proof the later move of this walk to shipped-files.ts leans on
  it('walks the files shippedFiles lists', () => {
    expect(files).toEqual(shippedFiles({ kinds: ['ts', 'js', 'css', 'html'] }))
  })
})

describe('the size check itself', () => {
  const body = (count: number) => Array.from({ length: count }, (_, i) => `  const v${i} = ${i}\n`).join('')

  it('counts lines as wc -l does', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('a\nb\n')).toBe(2)
    expect(lineCount('a\nb')).toBe(2)
  })

  it('fails a planted file over 800 lines that isn\'t listed', () => {
    expect(sizeProblems(new Map([['core/lib/planted.ts', 801]]), {})).toEqual(['core/lib/planted.ts has 801 lines, over 800'])
    expect(sizeProblems(new Map([['core/lib/planted.ts', 800]]), {})).toEqual([])
  })

  it('fails a listed file that grows past its cap and one that shrank until its cap is lowered to match', () => {
    const listed = { 'core/backend/big.ts': { cap: 900, why: 'a sample' } }
    expect(sizeProblems(new Map([['core/backend/big.ts', 901]]), listed)).toEqual(['core/backend/big.ts has 901 lines, over its cap of 900'])
    expect(sizeProblems(new Map([['core/backend/big.ts', 900]]), listed)).toEqual([])
    expect(sizeProblems(new Map([['core/backend/big.ts', 850]]), listed)).toEqual(['core/backend/big.ts has 850 lines, under its cap of 900: lower the cap to 850'])
  })

  it('fails a listed file that is gone or back under 800', () => {
    const listed = { 'core/backend/big.ts': { cap: 900, why: 'a sample' } }
    expect(sizeProblems(new Map(), listed)).toEqual(['core/backend/big.ts is listed with a cap of 900 and no longer exists'])
    expect(sizeProblems(new Map([['core/backend/big.ts', 700]]), listed)).toEqual(['core/backend/big.ts has 700 lines, no more than 800 and is still listed'])
  })

  it('reports a 90-line function by its name', () => {
    const source = `export function long(): number {\n${body(88)}  return 0\n}\n`
    expect(functionsOf(source)).toEqual([{ name: 'long', line: 1, lines: 91 }])
    expect(sizeWarnings('core/lib/long.ts', source)).toEqual(['core/lib/long.ts:1: long has 91 lines'])
  })

  it('names arrow functions, function expressions, methods and fields where it can, with types stripped in place', () => {
    const source = [
      'type T = { a: number }',
      'const arrow = (x: T): number => x.a',
      'const expression = function (): void {}',
      'export class Box<V> {',
      '  private held: V[] = []',
      '  put(value: V): void { this.held.push(value) }',
      '  #take = (): V | undefined => this.held.pop()',
      '}',
      'const table = { pick(n: number) { return n }, run: () => [1].map(n => n) }',
      'exports.done = () => 0',
    ].join('\n')
    expect(functionsOf(source).map(({ name, line }) => `${line} ${name}`)).toEqual([
      '2 arrow', '3 expression', '6 Box.put', '7 Box.#take', '9 pick', '9 run', '9 (anonymous)', '10 exports.done',
    ])
  })

  it('warns on a file of logic over 400 lines and not on a file of definitions only', () => {
    const definitions = `import { z } from 'zod'\nexport interface I { a: number }\nexport const schema = z.object({ a: z.number() })\n${body(420).replaceAll('  const', 'export const')}`
    expect(definitionsOnly(definitions)).toBe(true)
    expect(sizeWarnings('core/api/defs.ts', definitions)).toEqual([])
    const logic = `${definitions}export const twice = (n: number) => n * 2\n`
    expect(definitionsOnly(logic)).toBe(false)
    expect(sizeWarnings('core/api/logic.ts', logic)).toEqual(['core/api/logic.ts: 424 lines of logic'])
  })

  it('gives CSS and HTML the 800 line limit and no warning', () => {
    expect(sizeWarnings('core/frontend/editor/shell.css', 'a {}\n'.repeat(500))).toEqual([])
  })
})
