import { describe, expect, it } from 'vitest'
import { change, changeKinds, classRaised, mustType, type ClassRaised } from '../api/changes.ts'
import { describeChange } from '../api/describe.ts'

const HASH = 'a'.repeat(64)
const one = (input: unknown) => change.parse(input)

const everyKind = [
  { kind: 'plugin.approve', plugin: 'search' },
  { kind: 'plugin.update', plugin: 'search' },
  { kind: 'plugin.on', plugin: 'search' },
  { kind: 'plugin.off', plugin: 'gate' },
  { kind: 'plugin.remove', plugin: 'search' },
  { kind: 'plugin.restore', plugin: 'git' },
  { kind: 'plugin.clearStorage', plugin: 'mcp' },
  { kind: 'plugin.reset', plugin: 'gate' },
  { kind: 'grant.widen', plugin: 'search', capability: { type: 'luoshu.read', paths: ['**'] } },
  { kind: 'grant.narrow', plugin: 'search', capability: { type: 'luoshu.read', paths: ['notes/**'] } },
  { kind: 'item.on', plugin: 'search', capability: { type: 'ui.view' } },
  { kind: 'item.off', plugin: 'git', capability: { type: 'exec', commands: [['git', 'status']], env: [] } },
  { kind: 'luoshu.set', folder: '/Users/han/notes' },
  { kind: 'devMode', plugin: 'search', on: true },
  { kind: 'exec.anyCommand', plugin: 'git', on: true },
  { kind: 'skipVerification', on: false },
  { kind: 'confirmOff', on: true },
  { kind: 'recordNothing', on: true },
  { kind: 'allowUnsigned', hash: HASH, on: true },
  { kind: 'limit.set', constant: 'callsInFlight', value: 128, plugin: 'search' },
]

describe("the core's words for a change", () => {
  it('covers every kind', () => {
    expect(new Set(everyKind.map(input => input.kind))).toEqual(new Set(changeKinds))
  })

  it.each(everyKind)('says $kind in one line naming its target', input => {
    const { text } = describeChange(one(input))
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/\n/)
    if ('plugin' in input && typeof input.plugin === 'string') expect(text).toContain(input.plugin)
  })

  it('quotes what a plugin wrote as data, so a scope reads as text and not as a sentence', () => {
    const { text } = describeChange(one({ kind: 'grant.widen', plugin: 'search', capability: { type: 'luoshu.read', paths: ['save note'] } }))
    expect(text).toBe('Give search luoshu.read on "save note"')
  })

  it('names the paths a list grant reaches', () => {
    const { text } = describeChange(one({ kind: 'grant.widen', plugin: 'tree', capability: { type: 'luoshu.list', paths: ['notes/**'] } }))
    expect(text).toBe('Give tree luoshu.list on "notes/**"')
  })

  it('quotes the notes folder', () => {
    expect(describeChange(one({ kind: 'luoshu.set', folder: '/Users/han/notes' })).text).toBe('Use "/Users/han/notes" as the notes folder')
  })

  it('names a limit for one plugin or for every plugin', () => {
    expect(describeChange(one({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null })).text).toBe('Set readyMs to 20000 for every plugin')
    expect(describeChange(one({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: 'search' })).text).toBe('Set readyMs to 20000 for search')
  })

  // Decision 12: allow all means all, so the per-item switches lapse. Exec keeps its own list, which leaves out an item
  // switched off, so a command the human switched off stays refused
  it('says switching the gate off lets every call with power pass and lapses the per-item switches, but not for a command', () => {
    const { notes } = describeChange(one({ kind: 'plugin.off', plugin: 'gate' }))
    expect(notes.some(note => note.includes('per-item switches') && note.includes('a command whose item is off'))).toBe(true)
  })

  it('recommends keeping a security plugin on whenever one is switched off, and only then', () => {
    const recommends = (input: unknown) => describeChange(one(input)).notes.some(note => note.includes('recommends'))
    for (const plugin of ['gate', 'capabilities', 'watchdog']) expect(recommends({ kind: 'plugin.off', plugin })).toBe(true)
    expect(recommends({ kind: 'plugin.off', plugin: 'search' })).toBe(false)
    expect(recommends({ kind: 'plugin.on', plugin: 'gate' })).toBe(false)
  })

  it('says any command lets the plugin run anything the user can', () => {
    expect(describeChange(one({ kind: 'exec.anyCommand', plugin: 'git', on: true })).notes).toEqual(['git can then run anything you can run'])
    expect(describeChange(one({ kind: 'exec.anyCommand', plugin: 'git', on: false })).notes).toEqual([])
  })
})

describe('typing to prove attention', () => {
  it("asks for a security control's id to switch it off", () => {
    expect(mustType(one({ kind: 'plugin.off', plugin: 'gate' }))).toBe('gate')
    expect(mustType(one({ kind: 'plugin.off', plugin: 'watchdog' }))).toBe('watchdog')
  })

  it('asks for log to stop recording', () => {
    expect(mustType(one({ kind: 'recordNothing', on: true }))).toBe('log')
  })

  it('asks for nothing anywhere else', () => {
    const asked = everyKind.filter(input => mustType(one(input)) !== null).map(input => input.kind)
    expect(asked).toEqual(['plugin.off', 'recordNothing'])
    expect(mustType(one({ kind: 'plugin.off', plugin: 'search' }))).toBeNull()
    expect(mustType(one({ kind: 'recordNothing', on: false }))).toBeNull()
  })
})

// The notice the core raises for a move up nobody confirmed: the plugin in quotes as data, both classes and why
describe("the core's words for a class moved up with no Confirm", () => {
  const raised = (cause: ClassRaised['cause'], by: string | null): ClassRaised =>
    classRaised.parse({ kind: 'class.raised', plugin: 'sync', from: 0, to: 4, cause, by })

  it('names the plugin, the class it held and the one it holds now and says it is answered, not approved', () => {
    expect(describeChange(raised('start', null))).toEqual({
      text: '"sync" moved from class 0, Contained to class 4, Powerful with no Confirm on screen',
      notes: [
        'Why: the classing at start, which found what changed while hetu was not running',
        'Its new class and the items that ask at first use are in place already. Confirm only says you saw it',
      ],
    })
  })

  it.each([
    ['approve', 'the approval of "reader" without a Confirm'],
    ['copy', 'the copy of "reader" hetu ships, made at start'],
    ['update', 'the update of "reader" without a Confirm'],
    ['widen', 'a grant given to "reader" without a Confirm'],
    ['restore', 'the restore of "reader" without a Confirm'],
    ['slot-on', 'the capabilities plugin switched on again'],
  ] as [ClassRaised['cause'], string][])('says why for %s', (cause, why) => {
    expect(describeChange(raised(cause, cause === 'slot-on' ? null : 'reader')).notes[0]).toBe(`Why: ${why}`)
  })

  it('takes a class not known as where the plugin moved from', () => {
    expect(describeChange(classRaised.parse({ kind: 'class.raised', plugin: 'sync', from: null, to: 4, cause: 'start', by: null })).text)
      .toBe('"sync" moved from a class not known to class 4, Powerful with no Confirm on screen')
  })

  it('is no change a window can ask for', () => {
    expect(change.safeParse({ kind: 'class.raised', plugin: 'sync', from: 0, to: 4, cause: 'start', by: null }).success).toBe(false)
    expect(changeKinds).not.toContain('class.raised')
  })
})
