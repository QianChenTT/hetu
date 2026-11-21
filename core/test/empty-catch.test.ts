import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { parse, type Node } from 'acorn'
import { simple } from 'acorn-walk'
import { describe, expect, it } from 'vitest'
import { shippedFiles } from './shipped-files.ts'

// A catch that swallows an error carries its why: what is lost on its line and why that is fine, in a comment inside
// its braces or on the line directly above. A catch that does something says what happens already and isn't counted
// (D-634). The check sees only that a why is there and is long enough, the review reads what it says

const repo = path.join(import.meta.dirname, '..', '..')
// Every shipped ts and js file of core and each core plugin's src, since a core plugin runs from app.asar as hetu's
// own code and a swallow there loses an error the same way
const files = shippedFiles({ kinds: ['ts', 'js'], plugins: 'src' })

// Empty is a catch block with no statement, binding or not, and a function passed to .catch with an empty body or
// one returning undefined or void 0. A .catch returning null or a value hands its caller an answer and isn't counted
export type Swallow = { file: string, line: number, text: string, form: 'catch' | '.catch', why: string | null }

type Comment = { text: string, start: number, end: number }

// The text of a comment without its markers
const plain = (text: string) => text.split('\n').map(line => line.replace(/^\s*\*?\s?/, '').trim()).join(' ').trim()

// Each catch that swallows in a file, with the why written for it
export function swallowsIn(file: string, source: string): Swallow[] {
  const comments: Comment[] = []
  // Strip mode blanks the types and keeps every character where it was, so offsets in the source are the tree's
  const program = parse(stripTypeScriptTypes(source, { mode: 'strip' }), {
    ecmaVersion: 'latest', sourceType: 'module', locations: true, onComment: (_block, text, start, end) => comments.push({ text: plain(text), start, end }),
  })
  const lines = source.split('\n')
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length
  // A comment inside the braces, or the comment lines that end on the line above, each alone on its line
  const whyFor = (body: Node) => {
    const inside = comments.filter(comment => comment.start > body.start && comment.end < body.end)
    if (inside.length > 0) return inside.map(comment => comment.text).join(' ')
    const above: string[] = []
    for (let line = lineOf(body.start) - 1; line > 0; line--) {
      const comment = comments.find(each => lineOf(each.end) === line && lines[line - 1].slice(0, each.start - source.lastIndexOf('\n', each.start - 1) - 1).trim() === '')
      if (comment === undefined) break
      above.unshift(comment.text)
      line = lineOf(comment.start)
    }
    return above.length > 0 ? above.join(' ') : null
  }
  const found: Swallow[] = []
  const add = (body: Node, form: Swallow['form']) => {
    const line = lineOf(body.start)
    found.push({ file, line, text: lines[line - 1].trim(), form, why: whyFor(body) })
  }
  simple(program, {
    CatchClause(node) {
      if (node.body.body.length === 0) add(node.body, 'catch')
    },
    CallExpression(node) {
      const callee = node.callee
      if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || callee.property.name !== 'catch') return
      const handler = node.arguments[0]
      if (handler?.type !== 'ArrowFunctionExpression' && handler?.type !== 'FunctionExpression') return
      const body = handler.body
      const empty = body.type === 'BlockStatement' ? body.body.length === 0
        : (body.type === 'Identifier' && body.name === 'undefined') || (body.type === 'UnaryExpression' && body.operator === 'void' && body.argument.type === 'Literal')
      if (empty) add(body, '.catch')
    },
  })
  return found.sort((a, b) => a.line - b.line)
}

// What fails: a swallow with no why and a why under 10 characters
export function swallowProblems(found: readonly Swallow[]): string[] {
  return found.flatMap(each => {
    const at = `${each.file}:${each.line} ${each.text}`
    if (each.why === null) return [`${at} swallows with no why inside its braces or on the line above`]
    if (each.why.length < 10) return [`${at} has a why under 10 characters`]
    return []
  })
}

const found = files.flatMap(file => swallowsIn(file, readFileSync(path.join(repo, file), 'utf8')))

describe('the catches that swallow', () => {
  it('reads every shipped ts and js file with the core plugins\' src', () => {
    expect(files).toContain('core/backend/modules/modules.ts')
    expect(files).toContain('core/frontend/workers/prelude.js')
    expect(files.some(file => /^core-plugins\/[^/]+\/src\//.test(file))).toBe(true)
    expect(files.filter(file => file.includes('/test/') || file.endsWith('.test.ts'))).toEqual([])
  })

  it('finds both forms in the code', () => {
    expect(found.some(each => each.form === 'catch')).toBe(true)
    expect(found.some(each => each.form === '.catch')).toBe(true)
  })

  it('has every swallow with its why', () => {
    expect(swallowProblems(found)).toEqual([])
  })
})

describe('the empty catch check itself', () => {
  const at = 'core/backend/planted.ts'
  const problems = (source: string) => swallowProblems(swallowsIn(at, source))
  const none = (line: number, text: string) => `${at}:${line} ${text} swallows with no why inside its braces or on the line above`
  const why = 'a listener that throws can\'t stop the change, the change already happened'

  it.each([
    ['an empty catch', 'try { x() } catch {}'],
    ['an empty catch with a binding', 'try { x() } catch (err) {}'],
    ['the promise form', 'void work().catch(() => {})'],
    ['the promise form returning undefined', 'void work().catch(() => undefined)'],
    ['the promise form returning void 0', 'void work().catch(() => void 0)'],
    ['the promise form with a function', 'void work().catch(function () {})'],
    ['the promise form with an async arrow', 'void work().catch(async () => {})'],
  ])('fails %s', (_name, source) => {
    expect(problems(source)).toEqual([none(1, source)])
  })

  it('finds a catch on its own line under a try', () => {
    expect(problems('try {\n  x()\n} catch {}\n')).toEqual([none(3, '} catch {}')])
  })

  it.each([
    ['inside the braces', `try { x() } catch { /* ${why} */ }`],
    ['as a line inside the braces', `try {\n  x()\n} catch {\n  // ${why}\n}\n`],
    ['inside the promise form\'s braces', `void work().catch(() => { /* ${why} */ })`],
    ['on the line directly above', `// ${why}\ntry { x() } catch {}`],
    ['on the line above the promise form', `// ${why}\nawait handle.close().catch(() => {})`],
    ['as two lines directly above', `// a listener that throws can't stop the change\n// the change already happened\ntry { x() } catch {}`],
    ['as a block comment directly above', `/* ${why} */\ntry { x() } catch {}`],
  ])('passes a why %s', (_name, source) => {
    expect(problems(source)).toEqual([])
  })

  it('takes the why it passes as the comment\'s text', () => {
    expect(swallowsIn(at, `const a = 1\n// ${why}\nvoid work().catch(() => {})\n`)).toEqual([
      { file: at, line: 3, text: 'void work().catch(() => {})', form: '.catch', why },
    ])
  })

  it.each([
    ['two lines above', `// ${why}\nconst a = 1\ntry { x() } catch {}`, 3, 'try { x() } catch {}'],
    ['above a blank line', `// ${why}\n\ntry { x() } catch {}`, 3, 'try { x() } catch {}'],
    ['at the end of the line above, after code', `const a = 1 // ${why}\ntry { x() } catch {}`, 2, 'try { x() } catch {}'],
    ['at the end of its own line', `try { x() } catch {} // ${why}`, 1, `try { x() } catch {} // ${why}`],
  ])('fails a why %s', (_name, source, line, text) => {
    expect(problems(source)).toEqual([none(line, text)])
  })

  it('fails a why under 10 characters', () => {
    expect(problems('try { x() } catch { /* ignore */ }')).toEqual([`${at}:1 try { x() } catch { /* ignore */ } has a why under 10 characters`])
    expect(problems('// fine\nvoid work().catch(() => {})')).toEqual([`${at}:2 void work().catch(() => {}) has a why under 10 characters`])
  })

  it.each([
    'function read() {\n  try { return x() } catch { return null }\n}',
    "try { x() } catch { c.fault('flood-control', step) }",
    'const found = await lstat(file).catch(() => null)',
    "void run().catch(() => this.note('fault', { plugin: id, step: 'copy' }))",
    "void run().catch((err: unknown) => console.error(`didn't load: ${String(err)}`))",
    'void run().then(() => {})',
    'void run().catch(noop)',
    'const handler = () => {}',
  ])('counts nothing in %j', source => {
    expect(swallowsIn(at, source)).toEqual([])
  })
})
