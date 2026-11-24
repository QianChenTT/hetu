import { describe, expect, it } from 'vitest'
import type { Capability } from '../../../api/capabilities.ts'
import type { ClassCause, ClassOwed, ClassRow, ClassTable, StoredClass } from '../../../api/classes.ts'
import { createGrantRiskClassifier } from '../../../backend/policy/grant-risk-classifier/grant-risk-classifier.ts'
import { screen } from '../../../backend/policy/grant-risk-classifier/rules.ts'

const { classes } = createGrantRiskClassifier()
const read: Capability = { type: 'luoshu.read', paths: ['notes/**'] }
const fetchOne: Capability = { type: 'net.fetch', hosts: ['example.com'] }
const commit: Capability = { type: 'history', access: 'commit', paths: ['notes/**'] }
const storage: Capability = { type: 'storage' }
const hears = (...topics: string[]): Capability => ({ type: 'events.subscribe', topics })
const calls = (...targets: string[]): Capability => ({ type: 'plugin.call', targets })

const stored = (n: number | null, over: Partial<StoredClass> = {}): StoredClass => ({ class: n, firstUse: [], unclassed: false, owed: null, ...over })
// Plugins with entries, each with what it holds and its stored class
const rows = (plugins: Record<string, [Capability[], number | null]>): ClassRow[] =>
  Object.entries(plugins).map(([id, [granted, n]]) => ({ id, granted, stored: stored(n) }))
const change = (cause: ClassCause, id: string, granted: Capability[] | null, plugins: ClassRow[], confirm = true): ClassTable =>
  ({ cause, change: { id, granted }, confirm, plugins })
const verdictOf = (table: ClassTable, id: string) => classes(table).plugins.find(verdict => verdict.id === id)

// What id's approval answers, every other plugin approved before it at class 0 with what it holds
function approval(plugins: Record<string, Capability[]>, id: string) {
  const others = rows(Object.fromEntries(Object.entries(plugins).filter(([other]) => other !== id).map(([other, granted]) => [other, [granted, 0]])))
  const answer = classes(change('approve', id, plugins[id], others))
  const own = answer.plugins.find(verdict => verdict.id === id)!
  return { class: own.class, firstUse: own.firstUse, notes: answer.lines }
}

describe('an approval\'s answer', () => {
  it('gives the class, the items that ask at first use and the screen', () => {
    const answer = approval({ reader: [read, fetchOne] }, 'reader')
    expect(answer).toMatchObject({ class: 4, firstUse: [fetchOne] })
    expect(answer.notes).toContain('Class 4, Powerful: it can read notes and reach the network, so it could send notes out')
  })

  it('counts what a plugin reaches through plugin.call, followed in turn', () => {
    const plugins = { sender: [fetchOne], middle: [calls('sender')], notes: [read, calls('middle')] }
    expect(approval(plugins, 'notes')).toMatchObject({ class: 4, firstUse: [calls('middle')] })
  })

  it('names the plugins that read and can reach a network plugin', () => {
    expect(approval({ notes: [read, calls('sync')], sync: [fetchOne] }, 'sync').notes)
      .toContain('Plugins that read and are connected to it through plugin.call: notes')
  })
})

// A lock keeps every other writer off a note, the human included until he takes it over and tells its holder nothing
describe('lock.set', () => {
  it('is class 2 confined to a folder or a note and asks nothing at first use', () => {
    const locks: Capability = { type: 'lock.set', paths: ['projects/**', 'plan.md'] }
    expect(approval({ leases: [locks] }, 'leases')).toMatchObject({ class: 2, firstUse: [] })
  })

  it.each([['**'], ['*.md'], ['projects/**', '**/plan.md']])('is class 4 on %j and asks at first use', (...paths) => {
    const locks: Capability = { type: 'lock.set', paths }
    expect(approval({ leases: [locks] }, 'leases')).toMatchObject({ class: 4, firstUse: [locks] })
  })

  it('reads nothing, so beside network it stays a writer\'s class', () => {
    const locks: Capability = { type: 'lock.set', paths: ['projects/**'] }
    expect(approval({ leases: [locks, fetchOne] }, 'leases')).toMatchObject({ class: 3, firstUse: [] })
  })
})

// The role the door calls: what the plugin answers goes to programs outside hetu, so the item is a network's class. It
// is not network in the pair rule and never asks at first use, since the door's call raises no ask
describe('door.handle', () => {
  const role: Capability = { type: 'door.handle' }

  it('is class 3 and asks nothing at first use', () => {
    expect(approval({ mcp: [role] }, 'mcp')).toMatchObject({ class: 3, firstUse: [] })
  })

  it('beside reads and writes stays the highest of their classes and of its own, no pair', () => {
    const write: Capability = { type: 'luoshu.write', paths: ['notes/**'] }
    expect(approval({ mcp: [role, read, write, commit] }, 'mcp')).toMatchObject({ class: 3, firstUse: [] })
    expect(approval({ mcp: [role, read, { type: 'luoshu.write', paths: ['**'] }] }, 'mcp')).toMatchObject({ class: 4 })
  })

  it('names no plugin that reads and calls it, which holds its class and no pair', () => {
    const answer = approval({ notes: [read, calls('mcp')], mcp: [role] }, 'mcp')
    expect(answer.notes[0]).toBe('Class 3, Network')
    expect(answer.notes.filter(line => line.startsWith('Plugins that read'))).toEqual([])
    expect(answer.notes).toContain('Raises notes from class 0, Contained to class 3, Network')
  })
})

describe('the plugins connected through plugin.call', () => {
  it('count both ways, so a reader and a network plugin sharing a callee are class 4, the callee too', () => {
    const plugins = rows({ reader: [[read, calls('bridge')], 1], bridge: [[storage], 0] })
    const sender = classes(change('approve', 'sender', [fetchOne, calls('bridge')], plugins))
    expect(sender.plugins[0]).toMatchObject({ id: 'sender', class: 4 })
    expect(sender.lines).toContain('Plugins that read and are connected to it through plugin.call: reader')
    const all = [...plugins, { id: 'sender', granted: [fetchOne, calls('bridge')], stored: stored(4) }]
    expect(verdictOf(change('widen', 'bridge', [storage, { type: 'ui.view' }], all), 'bridge')!.class).toBe(4)
  })
})

// Publishing needs no grant, so a plugin can signal every plugin that hears its topics by what and when it publishes.
// Data moves one way along a subscription: from the plugin that owns the topic to the plugin that hears it
describe('a subscription to another plugin\'s topics', () => {
  const writeAll: Capability = { type: 'luoshu.write', paths: ['**'] }

  it('pairs a reader that speaks with a network plugin that hears it, both class 4, the subscription asking at first use', () => {
    const plugins = { reader: [read], sender: [fetchOne, hears('reader.done'), hears('luoshu.changed')] }
    const sender = approval(plugins, 'sender')
    expect(sender).toMatchObject({ class: 4, firstUse: [fetchOne, hears('reader.done')] })
    expect(sender.notes).toContain('Plugins that read and can reach it through events: reader')
    const reader = approval(plugins, 'reader')
    expect(reader).toMatchObject({ class: 4, firstUse: [] })
    expect(reader.notes).toContain('Plugins with network it can reach through events: sender')
  })

  it('leaves a network plugin that speaks and a reader that hears it at their own classes, since nothing moves back', () => {
    const plugins = { sender: [fetchOne], reader: [read, hears('sender.sent')] }
    const reader = approval(plugins, 'reader')
    expect(reader).toMatchObject({ class: 1, firstUse: [] })
    expect(reader.notes.filter(line => line.includes('through events'))).toEqual([])
    expect(approval(plugins, 'sender').class).toBe(3)
  })

  it('gives the listener none of the speaker\'s grants, so a plugin with views hearing a class 4 plugin stays class 0', () => {
    expect(approval({ writer: [writeAll], viewer: [{ type: 'ui.view' }, hears('writer.saved')] }, 'viewer')).toMatchObject({ class: 0, firstUse: [] })
  })

  it('leaves two plugins hearing one speaker that holds nothing, a reader and a network plugin hearing the luoshu, unpaired', () => {
    const plugins = { reader: [read, hears('luoshu.changed')], sender: [fetchOne, hears('luoshu.changed')] }
    expect(approval(plugins, 'reader').class).toBe(1)
    expect(approval(plugins, 'sender').class).toBe(3)
  })

  it('is followed in turn, so a reader, a plugin hearing it that speaks on and a network plugin hearing that are class 4', () => {
    const plugins = { reader: [read], middle: [hears('reader.done')], sender: [fetchOne, hears('middle.done')] }
    expect(approval(plugins, 'reader')).toMatchObject({ class: 4, firstUse: [] })
    expect(approval(plugins, 'middle')).toMatchObject({ class: 4, firstUse: [hears('reader.done')] })
    const sender = approval(plugins, 'sender')
    expect(sender).toMatchObject({ class: 4, firstUse: [fetchOne, hears('middle.done')] })
    expect(sender.notes).toContain('Plugins that read and can reach it through events: reader')
  })

  it('is followed with plugin.call, so a network plugin hearing a reader\'s caller is class 4, the caller and the reader too', () => {
    const plugins = { reader: [read], middle: [calls('reader')], sender: [fetchOne, hears('middle.done')] }
    expect(approval(plugins, 'sender')).toMatchObject({ class: 4, firstUse: [fetchOne, hears('middle.done')] })
    expect(approval(plugins, 'middle')).toMatchObject({ class: 4, firstUse: [calls('reader')] })
    expect(approval(plugins, 'reader')).toMatchObject({ class: 4, firstUse: [] })
  })

  it('links nothing for a plugin hearing only its own topics', () => {
    expect(approval({ reader: [read], sender: [fetchOne, hears('sender.sent')] }, 'sender')).toMatchObject({ class: 3, firstUse: [] })
  })
})

describe('the plugins an answer covers', () => {
  const chain = rows({ a: [[read, calls('b')], 1], b: [[calls('c')], 1], c: [[storage], 1], lone: [[read, calls('far')], 2] })

  it('are the changed plugin and every other entry whose links the change moves, followed along the chain', () => {
    expect(classes(change('widen', 'c', [storage, fetchOne], chain)).plugins.map(verdict => [verdict.id, verdict.class]))
      .toEqual([['c', 4], ['a', 4], ['b', 4]])
  })

  it('leave out an entry whose links did not change, even one whose stored class is out of date', () => {
    expect(classes(change('widen', 'c', [storage, fetchOne], chain)).plugins.map(verdict => verdict.id)).not.toContain('lone')
  })

  it('leave out a plugin the change takes away and answer for the rest it moves', () => {
    const answer = classes(change('remove', 'c', null, rows({ a: [[read, calls('c')], 4], c: [[fetchOne], 4] })))
    expect(answer.plugins).toEqual([{ id: 'a', class: 1, firstUse: [], owed: null }])
    expect(answer.lines).toEqual([])
  })

  it('are every entry in a pass and never a core plugin, which has no entry and still counts in the links', () => {
    const table: ClassTable = {
      cause: 'start', change: null, confirm: false,
      plugins: [...chain, { id: 'net', granted: [fetchOne, calls('a')], stored: null }],
    }
    expect(classes(table).plugins.map(verdict => [verdict.id, verdict.class])).toEqual([['a', 4], ['b', 4], ['c', 4], ['lone', 1]])
  })
})

describe('the lines on the change\'s Confirm', () => {
  const linked = rows({ a: [[read, calls('b')], 1], b: [[storage], 0] })

  it('name each move up after the changed plugin\'s screen, a move down with none', () => {
    const lines = classes(change('widen', 'b', [storage, fetchOne], linked)).lines
    expect(lines[0]).toBe('Class 4, Powerful: it can read notes and reach the network, so it could send notes out')
    expect(lines).toContain('Raises a from class 1, Reader to class 4, Powerful')
    const narrowed = classes(change('narrow', 'b', [storage], rows({ a: [[read, calls('b')], 4], b: [[storage, fetchOne], 4] })))
    expect(narrowed.plugins.map(verdict => [verdict.id, verdict.class])).toEqual([['b', 1], ['a', 1]])
    expect(narrowed.lines.filter(line => line.startsWith('Raises'))).toEqual([])
  })

  it('name no move with no Confirm on screen and no move on a first approval, which has no class before it', () => {
    expect(classes(change('widen', 'b', [storage, fetchOne], linked, false)).lines.filter(line => line.startsWith('Raises'))).toEqual([])
    expect(classes(change('approve', 'n', [read, fetchOne], [])).lines.filter(line => line.startsWith('Raises'))).toEqual([])
  })
})

// A move up applied with no Confirm on screen owes a notice where the class changes what hetu does: leaving 0 or entering 4
describe('the notice a move owes', () => {
  const owedOf = (table: ClassTable, id: string) => verdictOf(table, id)!.owed

  it('is owed for a move out of 0 or into 4 with no Confirm on screen, from the class the entry held and naming the change', () => {
    const plugins = rows({ a: [[{ type: 'ui.view' }, calls('b')], 0], b: [[storage], 0] })
    expect(owedOf(change('widen', 'b', [storage, commit], plugins, false), 'a')).toEqual({ from: 0, cause: 'widen', by: 'b' })
    expect(owedOf(change('widen', 'b', [storage, commit], plugins, true), 'a')).toBeNull()
  })

  it('is not owed for a move inside 1 to 3', () => {
    expect(owedOf(change('widen', 'a', [read, commit], rows({ a: [[read], 1] }), false), 'a')).toBeNull()
  })

  it('counts a plugin approved now as from 0 and a class not known as 4 otherwise', () => {
    expect(owedOf(change('approve', 'n', [read], [], false), 'n')).toEqual({ from: null, cause: 'approve', by: 'n' })
    const unknown = [{ id: 'a', granted: [read], stored: stored(null) }]
    expect(owedOf(change('widen', 'a', [read, fetchOne], unknown, false), 'a')).toBeNull()
  })

  it('measures an entry written while off with no class from the class its mark last showed', () => {
    const marked = (from: number): ClassRow[] => [{ id: 'a', granted: [commit], stored: stored(null, { unclassed: true, owed: { from, cause: 'start', by: null } }) }]
    const exec: Capability = { type: 'exec', commands: [['git', 'status']], env: [] }
    expect(owedOf(change('widen', 'a', [commit, exec], marked(2), false), 'a')).toEqual({ from: 2, cause: 'widen', by: 'a' })
    expect(owedOf(change('widen', 'a', [commit, fetchOne], marked(2), false), 'a')).toBeNull()
    expect(owedOf(change('widen', 'a', [commit], marked(2), false), 'a')).toBeNull()
  })

  it('keeps a notice owed while a move from the class last shown still alerts and drops it once none does', () => {
    const was: ClassOwed = { from: 0, cause: 'widen', by: 'b' }
    const plugins = [{ id: 'a', granted: [{ type: 'ui.view' }, calls('b')] as Capability[], stored: stored(3, { owed: was }) }, ...rows({ b: [[fetchOne], 3] })]
    expect(owedOf(change('widen', 'b', [fetchOne, commit], plugins, false), 'a')).toEqual(was)
    expect(owedOf(change('narrow', 'b', [], plugins, false), 'a')).toBeNull()
  })
})

// Only a class 0 plugin whose new version asks for nothing it doesn't hold loads unasked. One holding a type that asks
// on every update never does, as ui.layout asks since a layout draws the whole window
describe('whether an update loads unasked', () => {
  const view: Capability = { type: 'ui.view' }
  const layout: Capability = { type: 'ui.layout' }
  const update = (granted: Capability[], n: number | null, requested: Capability[], others: ClassRow[] = []): ClassTable =>
    ({ cause: 'update', change: { id: 'calc', granted }, confirm: false, requested, plugins: [{ id: 'calc', granted, stored: stored(n) }, ...others] })

  it('is yes for a class 0 plugin whose new version asks for nothing new', () => {
    expect(classes(update([view], 0, [view])).unasked).toBe(true)
    expect(classes(update([view], 0, [])).unasked).toBe(true)
  })

  it.each([
    ['a class above 0', [read], 1, [read]],
    ['a class not known', [], null, []],
    ['a new version asking for a grant it does not hold', [], 0, [storage]],
    ['a plugin holding ui.layout', [layout], 0, [layout]],
    ['a plugin holding door.handle', [{ type: 'door.handle' }], 3, [{ type: 'door.handle' }]],
  ] as [string, Capability[], number | null, Capability[]][])('is no for %s', (_name, granted, n, requested) => {
    expect(classes(update(granted, n, requested)).unasked).toBe(false)
  })

  it('is no for a class 0 entry that what it now reaches lifts', () => {
    expect(classes(update([calls('sync')], 0, [calls('sync')], rows({ sync: [[fetchOne], 3] }))).unasked).toBe(false)
  })

  it('is no for every change that is no update', () => {
    expect(classes(change('approve', 'calc', [], [])).unasked).toBe(false)
    expect(classes(change('update', 'calc', [], rows({ calc: [[], 0] }))).unasked).toBe(false)
  })
})

describe('the screen with what a manifest chose in quotes', () => {
  it('quotes each target, topic and variable it names, on the class line and the line of what is connected', () => {
    const lines = screen({
      granted: [{ type: 'exec', commands: [['git', 'status']], env: ['HOME'] }],
      reachable: [{ type: 'plugin.call', targets: ['notes'] }, { type: 'events.subscribe', topics: ['notes.saved'] }],
      callers: [],
    })
    expect(lines).toContain('Class 4, Powerful: it can run the command ["git","status"] outside the sandbox with your rights on this computer, with "HOME" from your environment')
    expect(lines).toContain('Through the plugins it calls it can call the plugin "notes" and it can hear the events "notes.saved"')
  })
})
