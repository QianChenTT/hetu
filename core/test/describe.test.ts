import { describe, expect, it } from 'vitest'
import { change, changeKinds, mustType } from '../api/changes.ts'
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
  { kind: 'item.on', plugin: 'search', capability: { type: 'ui.panel' } },
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

  it('quotes the notes folder', () => {
    expect(describeChange(one({ kind: 'luoshu.set', folder: '/Users/han/notes' })).text).toBe('Use "/Users/han/notes" as the notes folder')
  })

  it('names a limit for one plugin or for every plugin', () => {
    expect(describeChange(one({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null })).text).toBe('Set readyMs to 20000 for every plugin')
    expect(describeChange(one({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: 'search' })).text).toBe('Set readyMs to 20000 for search')
  })

  // Decision 12: allow all means all, so the per-item switches lapse
  it('says switching the gate off lets every call with power pass and lapses the per-item switches', () => {
    const { notes } = describeChange(one({ kind: 'plugin.off', plugin: 'gate' }))
    expect(notes.some(note => note.includes('per-item switches'))).toBe(true)
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
