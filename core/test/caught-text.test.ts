import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CallExpression, CatchClause, Identifier, Node } from 'acorn'
import { ancestor } from 'acorn-walk'
import { describe, expect, it } from 'vitest'
import { placeProblems, type Hit, type Place } from './listed-places.ts'
import { parsed } from './named-parts.ts'
import { shippedFiles } from './shipped-files.ts'

// A caught error's text can carry a path, a plugin's words or a stack, so the core reads it only in the places listed
// here, each saying where the text goes (D-636). A caught value is a catch's binding or the first parameter of a
// function written in a .catch call, followed inside that block or function only. Its text is read as .message,
// .stack, String() of it or ${} of it. A value handed on to another function is not followed, so String(err) on a
// parameter counts nowhere, and neither does a read of text copied out first (const why = err.message read later)

// Shipped code of core/, ts and js
const repo = path.join(import.meta.dirname, '..', '..')
const files = shippedFiles({ kinds: ['ts', 'js'] })

export const listed: readonly Place[] = [
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

// Each place a file reads a caught value's text
export function caughtTextIn(file: string, source: string): Hit[] {
  const hits: Hit[] = []
  const add = (node: Node, name: string, text: string, ancestors: readonly Node[]) => {
    if (isCaught(name, ancestors)) hits.push({ file, line: node.loc!.start.line, text })
  }
  ancestor(parsed(source), {
    MemberExpression(node, _, ancestors) {
      if (node.object.type !== 'Identifier') return
      const property = node.computed ? (node.property.type === 'Literal' ? node.property.value : undefined) : (node.property as Identifier).name
      if (typeof property === 'string' && texts.has(property)) add(node, node.object.name, `${node.object.name}.${property}`, ancestors)
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

// What fails: a caught value's text read outside the places listed and what listed-places.ts fails in a place
export function caughtTextProblems(found: readonly Hit[], lineOf: (hit: Hit) => string, places: readonly Place[]): string[] {
  const { unlisted, problems } = placeProblems(found, lineOf, places, "reading a caught value's text")
  return [...unlisted.map(hit => `${hit.file}:${hit.line} ${hit.text} reads a caught value's text`), ...problems]
}

const sources = new Map(files.map(file => [file, readFileSync(path.join(repo, file), 'utf8')]))
const found = [...sources].flatMap(([file, source]) => caughtTextIn(file, source))
const lineOf = (hit: Hit) => sources.get(hit.file)!.split('\n')[hit.line - 1]

describe("the places the core reads a caught value's text", () => {
  it('reads the shipped code of core/', () => {
    expect(files).toContain('core/backend/runtime/windows.ts')
    expect(files.every(file => /\.(ts|js)$/.test(file) && file.startsWith('core/') && !file.startsWith('core/sdk/build/'))).toBe(true)
  })

  it('reads it nowhere outside the places listed, each still there and with its why', () => {
    expect(caughtTextProblems(found, lineOf, listed)).toEqual([])
  })
})

describe('the caught text check itself', () => {
  const at = 'core/backend/planted.ts'
  const problems = (source: string, places: readonly Place[] = []) => {
    const lines = source.split('\n')
    return caughtTextProblems(caughtTextIn(at, source), hit => lines[hit.line - 1], places)
  }
  const fails = (line: number, text: string) => `${at}:${line} ${text} reads a caught value's text`

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
  ])('fails %j', (source, expected) => {
    expect(problems(source)).toEqual(expected)
  })

  it.each([
    'function tell(err: unknown) { log(String(err)) }',
    "const err = new Error('x')\nlog(err.message, `${err}`)",
    'p.then((err) => log(err.message))',
    'try { f() } catch (err) { report(err) }\nlog(err.message)',
    'try { f() } catch (err) { log(err.code, err.name) }',
    'try { f() } catch (err) { list.map((err) => log(err.message)) }',
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
    expect(problems('const x = 1', [page])).toEqual(["backend/planted.ts holds no \"console.error(`the page didn't load\" reading a caught value's text: remove the entry"])
    expect(problems(source, [{ ...page, why: 'console' }])).toEqual(["backend/planted.ts \"console.error(`the page didn't load\" has a why under 10 characters"])
  })
})
