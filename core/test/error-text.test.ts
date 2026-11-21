import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CallExpression, CatchClause, Identifier, Node } from 'acorn'
import { ancestor } from 'acorn-walk'
import { describe, expect, it } from 'vitest'
import { placeProblems, type Hit, type Place } from './listed-places.ts'
import { parsed } from './named-parts.ts'
import { shippedFiles } from './shipped-files.ts'

// An error's text can carry a path, a plugin's words or a stack, so the core reads it only in the places listed here,
// each saying where the text goes (D-636, D-638). A .message or .stack property read counts on any value. String() of
// a value and ${} of it count on a caught value only, a catch's binding or the first parameter of a function written
// in a .catch call, followed inside that block or function only. Beyond the check: String(err) on a parameter, a
// .message taken by destructuring and a read of text copied out first (const why = err.message read later)

// Shipped code of core/, ts and js
const repo = path.join(import.meta.dirname, '..', '..')
const files = shippedFiles({ kinds: ['ts', 'js'] })

export const listed: readonly Place[] = [
  { place: 'backend/main.ts', text: 'const reason = (err: unknown) =>', hits: 1, why: 'the start failure, in the console and an error box' },
  { place: 'backend/router/context.ts', text: 'const text = err instanceof Error ? err.message', hits: 1, why: "the throwing plugin's own debug, not the caller's" },
  { place: 'backend/runtime/quit.ts', text: 'const reason = (err: unknown) =>', hits: 1, why: 'the quit log' },
  { place: 'backend/runtime/windows.ts', text: "console.error(`the editor page didn't load", hits: 1, why: 'the main process console, when the editor page does not load' },
  { place: 'backend/runtime/windows.ts', text: "console.error(`the trusted page didn't load", hits: 1, why: 'the main process console, when the trusted page does not load' },
  { place: 'backend/runtime/workers.ts', text: "console.error(`the worker host page didn't load", hits: 1, why: 'the main process console, when a worker host page does not load' },
]

type Fn = Node & { params: Node[] }
const isFunction = (node: Node): node is Fn => ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)
const isName = (node: Node | null | undefined, name: string) => node?.type === 'Identifier' && (node as Identifier).name === name
const isCatchCall = (node: Node | undefined): node is CallExpression => {
  if (node?.type !== 'CallExpression') return false
  const callee = (node as CallExpression).callee
  return callee.type === 'MemberExpression' && !callee.computed && isName(callee.property, 'catch')
}

// Whether a name read inside the nodes in ancestors is a caught value: the nearest node binding it is a catch or a
// function written as the first argument of a .catch call, taking it as its first parameter
function isCaught(name: string, ancestors: readonly Node[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i]
    if (node.type === 'CatchClause' && isName((node as CatchClause).param, name)) return true
    if (isFunction(node) && node.params.some(param => isName(param, name))) {
      const call = ancestors[i - 1]
      return isCatchCall(call) && call.arguments[0] === node && isName(node.params[0], name)
    }
  }
  return false
}

const texts = new Set(['message', 'stack'])

// Each place a file reads an error's text
export function errorTextIn(file: string, source: string): Hit[] {
  const hits: Hit[] = []
  const hit = (node: Node, text: string) => hits.push({ file, line: node.loc!.start.line, text })
  const add = (node: Node, name: string, text: string, ancestors: readonly Node[]) => {
    if (isCaught(name, ancestors)) hit(node, text)
  }
  ancestor(parsed(source), {
    MemberExpression(node) {
      const property = node.computed ? (node.property.type === 'Literal' ? node.property.value : undefined) : (node.property as Identifier).name
      if (typeof property !== 'string' || !texts.has(property)) return
      hit(node, node.object.type === 'Identifier' ? `${node.object.name}.${property}` : `.${property}`)
    },
    CallExpression(node, _, ancestors) {
      const [value] = node.arguments
      if (isName(node.callee, 'String') && value?.type === 'Identifier') add(node, value.name, `String(${value.name})`, ancestors)
    },
    TemplateLiteral(node, _, ancestors) {
      for (const value of node.expressions) {
        if (value.type === 'Identifier') add(value, value.name, `\${${value.name}}`, ancestors)
      }
    },
  })
  return hits.sort((a, b) => a.line - b.line)
}

// What fails: an error's text read outside the places listed and what listed-places.ts fails in a place
export function errorTextProblems(found: readonly Hit[], lineOf: (hit: Hit) => string, places: readonly Place[]): string[] {
  const { unlisted, problems } = placeProblems(found, lineOf, places, "reading an error's text")
  return [...unlisted.map(hit => `${hit.file}:${hit.line} ${hit.text} reads an error's text`), ...problems]
}

const sources = new Map(files.map(file => [file, readFileSync(path.join(repo, file), 'utf8')]))
const found = [...sources].flatMap(([file, source]) => errorTextIn(file, source))
const lineOf = (hit: Hit) => sources.get(hit.file)!.split('\n')[hit.line - 1]

describe("the places the core reads an error's text", () => {
  it('reads the shipped code of core/', () => {
    expect(files).toContain('core/backend/runtime/windows.ts')
    expect(files.every(file => /\.(ts|js)$/.test(file) && file.startsWith('core/') && !file.startsWith('core/sdk/build/'))).toBe(true)
  })

  it('reads it nowhere outside the places listed, each still there and with its why', () => {
    expect(errorTextProblems(found, lineOf, listed)).toEqual([])
  })
})

describe('the error text check itself', () => {
  const at = 'core/backend/planted.ts'
  const problemsAt = (file: string, source: string, places: readonly Place[] = []) => {
    const lines = source.split('\n')
    return errorTextProblems(errorTextIn(file, source), hit => lines[hit.line - 1], places)
  }
  const problems = (source: string, places: readonly Place[] = []) => problemsAt(at, source, places)
  const fails = (line: number, text: string, file = at) => `${file}:${line} ${text} reads an error's text`

  it.each([
    ['try { f() } catch (err) { log(err.message) }', [fails(1, 'err.message')]],
    ['try { f() } catch (e) {\n  log(e.stack)\n}', [fails(2, 'e.stack')]],
    ['try { f() } catch (e) { log(String(e)) }', [fails(1, 'String(e)')]],
    ['try { f() } catch (e) { log(`failed: ${e}`) }', [fails(1, '${e}')]],
    ['async function run() {\n  try { await f() } catch (err) { return { ok: true, result: { failed: err.message } } }\n}', [fails(2, 'err.message')]],
    ["try { f() } catch (err) { log((err as Error).message, err?.stack, err['message']) }", [fails(1, 'err.message'), fails(1, 'err.stack'), fails(1, 'err.message')]],
    ['p.catch((e) => log(e.message))', [fails(1, 'e.message')]],
    ['p.catch(e => log(`${e}`))', [fails(1, '${e}')]],
    ['p.catch(function (e) { log(String(e)) })', [fails(1, 'String(e)')]],
    ['try { f() } catch (a) {\n  try { g() } catch (b) { log(a.message, b.message) }\n}', [fails(2, 'a.message'), fails(2, 'b.message')]],
    // .message and .stack on any value, a caught one or not
    ['function tell(err: unknown) {\n  log((err as Error).message)\n}', [fails(2, 'err.message')]],
    ["log(new Error('x').stack, this.last?.stack)", [fails(1, '.stack'), fails(1, '.stack')]],
    ["const err = new Error('x')\nlog(err.message, `${err}`)", [fails(2, 'err.message')]],
    ['p.then((err) => log(err.message))', [fails(1, 'err.message')]],
    ['try { f() } catch (err) { report(err) }\nlog(err.message)', [fails(2, 'err.message')]],
    ['try { f() } catch (err) { list.map((err) => log(err.message)) }', [fails(1, 'err.message')]],
  ])('fails %j', (source, expected) => {
    expect(problems(source)).toEqual(expected)
  })

  it('fails a new helper reading .message in a file no place lists', () => {
    const file = 'core/backend/runtime/why.ts'
    expect(problemsAt(file, 'const reason = (e) => e.message', listed)).toContain(fails(1, 'e.message', file))
  })

  it.each([
    "log('view.message', \"err.stack\")",
    "const reply = { message: 'x', stack: [] }",
    'const reply = { message, stack }',
    'function tell(err: unknown) { log(String(err), `${err}`) }',
    'p.then((err) => log(String(err)))',
    'try { f() } catch (err) { report(err) }\nlog(String(err))',
    'try { f() } catch (err) { list.map((err) => log(`${err}`)) }',
    'try { f() } catch (err) { log(err.code, err.name) }',
    'try { f() } catch { log(String(x)) }',
  ])('counts nothing in %j', source => {
    expect(problems(source)).toEqual([])
  })

  const page: Place = { place: 'backend/planted.ts', text: "console.error(`the page didn't load", hits: 1, why: 'the page that did not load, in the console only' }
  const source = "win.loadURL(u).catch((err: unknown) => console.error(`the page didn't load: ${String(err)}`))"

  it('passes a listed place and fails one more read beside it', () => {
    expect(problems(source, [page])).toEqual([])
    expect(problems(source.replace('String(err)', 'String(err)} ${err.stack'), [page])).toEqual([
      "backend/planted.ts \"console.error(`the page didn't load\" covers 2 hits and lists 1: line 1 String(err), line 1 err.stack",
    ])
  })

  it('fails a stale entry and a short why', () => {
    expect(problems('const x = 1', [page])).toEqual(["backend/planted.ts holds no \"console.error(`the page didn't load\" reading an error's text: remove the entry"])
    expect(problems(source, [{ ...page, why: 'console' }])).toEqual(["backend/planted.ts \"console.error(`the page didn't load\" has a why under 10 characters"])
  })
})
