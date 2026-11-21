import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { parse, type Node } from 'acorn'
import { ancestor, simple } from 'acorn-walk'
import { describe, expect, it } from 'vitest'
import { shippedFiles } from './shipped-files.ts'

// An open call's fields are readonly and tsc fails any write but a cast to Writable<...>, which drops only readonly.
// An owner's setter writes its own field through that cast. Every other cast is a clash: it carries its why on its
// line and is on the list below, so a growing list says the rule needs updating (D-628, D-632)

const repo = path.join(import.meta.dirname, '..', '..')
// Every shipped file of core, since a Writable of its own elsewhere is a clash all the same
const files = shippedFiles({ kinds: ['ts'] })
const router = 'core/backend/router/'

// Which step file owns each field of an open call after creation, the router README's table. A field set only in
// admitted is no one's to write. children is open-calls.ts's and only ever changed in place, so it has no setter
export const owners: Readonly<Record<string, string>> = {
  timer: 'open-calls.ts', children: 'open-calls.ts', done: 'open-calls.ts', revoked: 'open-calls.ts', live: 'open-calls.ts',
  gate: 'provide.ts', scope: 'provide.ts', refusedScope: 'provide.ts', judged: 'provide.ts', performing: 'provide.ts',
  callee: 'route.ts', coalesce: 'route.ts',
}

// Each clash as file and its line's text, why included. Empty today
export const clashes: readonly string[] = []

// The files that may call a setter of another step file, by setter. Any other setter stays unexported (D-632)
export const callers: Readonly<Record<string, readonly string[]>> = {
  setScope: ['core/backend/router/route.ts'],
}

export type Cast = { file: string, line: number, text: string, setter: boolean, why: string | null }

// Each Writable cast in a file. A setter's own write is the cast in set<Field> of the field's owner writing that field
export function castsIn(file: string, source: string): Cast[] {
  const comments: [number, number][] = []
  const program = parse(stripTypeScriptTypes(source, { mode: 'strip' }), {
    ecmaVersion: 'latest', sourceType: 'module', locations: true, onComment: (_block, _text, start, end) => comments.push([start, end]),
  })
  // Strip mode blanks the types and keeps every character where it was, so offsets in the source are the tree's
  const at = [...source.matchAll(/\bWritable</g)].map(match => match.index)
    .filter(index => !comments.some(([start, end]) => index >= start && index < end) && !/\btype\s+$/.test(source.slice(0, index)))
  const setters = new Set<number>()
  ancestor(program, {
    AssignmentExpression(node, _state, above) {
      const left = node.left
      if (left.type !== 'MemberExpression' || left.computed || left.property.type !== 'Identifier') return
      const field = left.property.name
      const index = at.find(index => index >= left.start && index < left.property.start)
      if (index === undefined || !source.startsWith('Writable<Pending>', index)) return
      const named = [...above].reverse().find(each => each.type === 'FunctionDeclaration' || each.type === 'VariableDeclarator') as Node & { id?: { name?: string } } | undefined
      const name = named?.id?.name
      if (owners[field] === path.posix.basename(file) && name === `set${field[0].toUpperCase()}${field.slice(1)}`) setters.add(index)
    },
  })
  const lines = source.split('\n')
  return at.map(index => {
    const line = source.slice(0, index).split('\n').length
    const text = lines[line - 1].trim()
    const why = /\/\/ clash:(.*)$/.exec(text)?.[1].trim() ?? null
    return { file, line, text, setter: setters.has(index), why }
  })
}

// What fails: a clash with no why or one under 10 characters, a clash off the list and a listed one gone from the code
export function clashProblems(casts: readonly Cast[], listed: readonly string[]): string[] {
  const found = casts.filter(cast => !cast.setter)
  const problems: string[] = []
  for (const cast of found) {
    const at = `${cast.file}:${cast.line} ${cast.text}`
    if (cast.why === null) problems.push(`${at} casts to Writable with no // clash: <why>`)
    else if (cast.why.length < 10) problems.push(`${at} has a why under 10 characters`)
    if (!listed.includes(`${cast.file} ${cast.text}`)) problems.push(`${at} is a clash off the list: add it, a growing list says the rule needs updating`)
  }
  for (const entry of listed) {
    if (!found.some(cast => `${cast.file} ${cast.text}` === entry)) problems.push(`${entry} is on the list and no longer in the code: remove the entry`)
  }
  return problems
}

// What fails: a file naming another file's exported setter off that setter's list, an exported setter with no list
// and a listed caller that no longer names it
export function setterProblems(sources: ReadonlyMap<string, string>, listed: Readonly<Record<string, readonly string[]>>): string[] {
  const trees = new Map([...sources].map(([file, source]) => [file, parse(stripTypeScriptTypes(source, { mode: 'strip' }), { ecmaVersion: 'latest', sourceType: 'module', locations: true })]))
  const exported = new Map<string, string>()
  for (const [file, tree] of trees) {
    for (const statement of tree.body) {
      const declared = statement.type === 'ExportNamedDeclaration' ? statement.declaration : null
      if (declared?.type === 'FunctionDeclaration' && /^set[A-Z]/.test(declared.id.name)) exported.set(declared.id.name, file)
    }
  }
  const problems: string[] = []
  const named = new Map<string, Set<string>>()
  for (const [file, tree] of trees) {
    simple(tree, {
      Identifier(node) {
        const owner = exported.get(node.name)
        if (owner === undefined || owner === file) return
        named.set(node.name, (named.get(node.name) ?? new Set()).add(file))
        if (!(listed[node.name] ?? []).includes(file)) problems.push(`${file}:${node.loc!.start.line} calls ${node.name}, a setter of ${owner} off its list`)
      },
    })
  }
  for (const [setter, owner] of exported) {
    if (!Object.hasOwn(listed, setter)) problems.push(`${owner} exports ${setter} with no list of callers: keep it unexported or list them`)
  }
  for (const [setter, files] of Object.entries(listed)) {
    for (const file of files) if (!named.get(setter)?.has(file)) problems.push(`${file} is on ${setter}'s list and no longer calls it: remove it`)
  }
  return [...new Set(problems)]
}

const casts = files.flatMap(file => castsIn(file, readFileSync(path.join(repo, file), 'utf8')))
const routerSources = new Map(files.filter(file => file.startsWith(router)).map(file => [file, readFileSync(path.join(repo, file), 'utf8')]))

describe('the casts that drop readonly', () => {
  it('reads every shipped file and finds each owner\'s setters in its owner', () => {
    expect(files).toContain(`${router}context.ts`)
    expect(files.some(file => file.startsWith('core/api/'))).toBe(true)
    const setters = casts.filter(cast => cast.setter).map(cast => `${cast.file.slice(router.length)} ${cast.text}`).sort()
    const expected = Object.entries(owners).filter(([field]) => field !== 'children')
      .map(([field, owner]) => `${owner} (pending as Writable<Pending>).${field} = ${field}`).sort()
    expect(setters).toEqual(expected)
  })

  it('has every clash with its why and on the list', () => {
    expect(clashProblems(casts, clashes)).toEqual([])
  })

  it('lets a setter be called only by its owner and the files on its list', () => {
    expect(setterProblems(routerSources, callers)).toEqual([])
  })
})

describe('the clash casts check itself', () => {
  const at = 'core/backend/router/route.ts'
  const problems = (source: string, listed: readonly string[] = [], file = at) => clashProblems(castsIn(file, source), listed)
  const write = '(pending as Writable<Pending>).scope = undefined'
  const offList = (line: number, text: string) => `${at}:${line} ${text} is a clash off the list: add it, a growing list says the rule needs updating`

  it('fails a cast with no why, and lists it', () => {
    expect(problems(write)).toEqual([`${at}:1 ${write} casts to Writable with no // clash: <why>`, offList(1, write)])
  })

  it('fails a why under 10 characters', () => {
    const text = `${write} // clash: short`
    expect(problems(text, [`${at} ${text}`])).toEqual([`${at}:1 ${text} has a why under 10 characters`])
  })

  it('passes a cast with its why once it is listed, and lists it', () => {
    const text = `${write} // clash: only the bus knows which topics went live`
    expect(castsIn(at, `const x = 1\n${text}\n`)).toEqual([{ file: at, line: 2, text, setter: false, why: 'only the bus knows which topics went live' }])
    expect(problems(text)).toEqual([offList(1, text)])
    expect(problems(text, [`${at} ${text}`])).toEqual([])
  })

  it('fails a listed clash gone from the code', () => {
    expect(problems('const x = 1', [`${at} ${write} // clash: only the bus knows`])).toEqual([
      `${at} ${write} // clash: only the bus knows is on the list and no longer in the code: remove the entry`,
    ])
  })

  const setter = 'export function setScope(pending: Pending, scope: Scope | undefined): void {\n  (pending as Writable<Pending>).scope = scope\n}\n'

  it('takes the owner\'s setter writing its own field as no clash', () => {
    expect(problems(setter, [], 'core/backend/router/provide.ts')).toEqual([])
    expect(problems(setter.replace('export function', 'function'), [], 'core/backend/router/provide.ts')).toEqual([])
    expect(problems('const setDone = (pending: Pending) => {\n  (pending as Writable<Pending>).done = true\n}\n', [], 'core/backend/router/open-calls.ts')).toEqual([])
  })

  it.each([
    ['the same setter outside the owner', setter, at],
    ['a setter writing a field its name does not', setter.replace('.scope = scope', '.judged = null'), 'core/backend/router/provide.ts'],
    ['an owner writing its field outside a setter', 'function run(pending: Pending) {\n  (pending as Writable<Pending>).scope = undefined\n}\n', 'core/backend/router/provide.ts'],
    ['a field written by a computed key', 'function setScope(pending: Pending) {\n  (pending as Writable<Pending>)[\'scope\'] = undefined\n}\n', 'core/backend/router/provide.ts'],
    ['a type that names it', 'type Open = Writable<Pending>\n', at],
    ['a cast to another type', 'function setScope(way: Way) {\n  (way as Writable<Way>).scope = undefined\n}\n', 'core/backend/router/provide.ts'],
  ])('counts %s as a clash', (_name, source, file) => {
    expect(castsIn(file, source).map(cast => cast.setter)).toEqual([false])
  })

  it.each([
    '// a write outside the owner is a cast to Writable<Pending> with its why\nconst x = 1',
    'export type Writable<T> = { -readonly [K in keyof T]: T[K] }',
    'pending.children.add(child)',
  ])('counts nothing in %j', source => {
    expect(castsIn(at, source)).toEqual([])
  })
})

describe('the setter callers check itself', () => {
  const provide = 'core/backend/router/provide.ts'
  const route = 'core/backend/router/route.ts'
  const bus = 'core/backend/router/bus.ts'
  const owner = 'export function setScope(pending: Pending, scope: Scope | undefined): void {}\nfunction setGate() {}\n'
  const calls = "import { setScope } from './provide.ts'\nsetScope(pending, undefined)\n"
  const listed = { setScope: [route] }

  it('passes a listed caller and a setter left unexported', () => {
    expect(setterProblems(new Map([[provide, owner], [route, calls]]), listed)).toEqual([])
  })

  it('fails a caller off the list, an exported setter with no list and a listed caller gone', () => {
    expect(setterProblems(new Map([[provide, owner], [route, calls], [bus, calls]]), listed)).toEqual([`${bus}:2 calls setScope, a setter of ${provide} off its list`])
    expect(setterProblems(new Map([[provide, owner], [route, calls]]), {})).toEqual([
      `${route}:2 calls setScope, a setter of ${provide} off its list`,
      `${provide} exports setScope with no list of callers: keep it unexported or list them`,
    ])
    expect(setterProblems(new Map([[provide, owner], [route, 'const x = 1']]), listed)).toEqual([`${route} is on setScope's list and no longer calls it: remove it`])
  })
})
