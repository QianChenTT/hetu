import { describe, expect, it } from 'vitest'
import { change, changeKinds, MAX_FOLDER_LENGTH } from '../api/changes.ts'
import { floorConstantNames, MAX_TIMER_MS, timeConstants } from '../api/floor.ts'

const raw = (text: string) => JSON.parse(text)
const HASH = 'a'.repeat(64)

// One of every kind
const everyKind = [
  { kind: 'plugin.approve', plugin: 'search' },
  { kind: 'plugin.update', plugin: 'search' },
  { kind: 'plugin.on', plugin: 'search' },
  { kind: 'plugin.off', plugin: 'gate' },
  { kind: 'plugin.remove', plugin: 'search' },
  { kind: 'plugin.restore', plugin: 'git' },
  { kind: 'plugin.clearStorage', plugin: 'mcp' },
  { kind: 'grant.widen', plugin: 'search', capability: { type: 'luoshu.read', paths: ['**'] } },
  { kind: 'grant.narrow', plugin: 'search', capability: { type: 'luoshu.read', paths: ['notes/**'] } },
  { kind: 'item.on', plugin: 'search', capability: { type: 'ui.panel' } },
  { kind: 'item.off', plugin: 'git', capability: { type: 'exec', commands: [['git', 'status']], env: [] } },
  { kind: 'luoshu.set', folder: '/Users/han/notes' },
  { kind: 'devMode', plugin: 'search', on: true },
  { kind: 'skipVerification', on: false },
  { kind: 'allowUnsigned', hash: HASH, on: true },
  { kind: 'confirmOff', on: true },
  { kind: 'exec.anyCommand', plugin: 'git', on: true },
  { kind: 'limit.set', constant: 'callsInFlight', value: 128, plugin: 'search' },
  { kind: 'recordNothing', on: true },
]

describe('the change kinds', () => {
  it("are the nineteen change kinds the trusted window applies", () => {
    expect(changeKinds).toEqual([
      'plugin.approve', 'plugin.update', 'plugin.on', 'plugin.off', 'plugin.remove', 'plugin.restore', 'plugin.clearStorage',
      'grant.widen', 'grant.narrow', 'item.on', 'item.off', 'luoshu.set', 'devMode', 'exec.anyCommand', 'skipVerification',
      'confirmOff', 'recordNothing', 'allowUnsigned', 'limit.set',
    ])
  })

  it('have a schema for every listed kind and no other', () => {
    expect(new Set(everyKind.map(one => one.kind))).toEqual(new Set(changeKinds))
  })

  it.each(everyKind)('takes $kind', one => {
    expect(change.parse(one)).toEqual(one)
  })

  it.each(['plugin.install', 'security.confirm', 'switches.set', 'watchdog.control', ''])('refuses the kind %j', kind => {
    expect(change.safeParse({ kind, plugin: 'search' }).success).toBe(false)
  })

  // Each change names one target, never the state as a whole
  it.each(everyKind)('refuses $kind with an extra field', one => {
    expect(change.safeParse({ ...one, state: { switches: {} } }).success).toBe(false)
  })

  it.each(everyKind)('refuses $kind with a field missing', one => {
    const fields = Object.keys(one).filter(field => field !== 'kind')
    for (const field of fields) {
      const { [field]: _left, ...rest } = one as Record<string, unknown>
      expect(change.safeParse(rest).success).toBe(false)
    }
  })

  it('keeps the list frozen', () => {
    expect(Object.isFrozen(changeKinds)).toBe(true)
    expect(() => (changeKinds as unknown as string[]).push('everything.off')).toThrow()
  })
})

describe('what each kind holds', () => {
  it('names plugins by their id', () => {
    for (const plugin of ['my.plugin', 'Search', 'con', '', '../search']) {
      expect(change.safeParse({ kind: 'plugin.on', plugin }).success).toBe(false)
    }
  })

  it('holds a grant to the capability list and its scopes', () => {
    expect(change.safeParse({ kind: 'grant.widen', plugin: 'search', capability: { type: 'watchdog.control' } }).success).toBe(false)
    expect(change.safeParse({ kind: 'grant.widen', plugin: 'search', capability: { type: 'luoshu.read', paths: ['../**'] } }).success).toBe(false)
    expect(change.safeParse({ kind: 'item.off', plugin: 'search', capability: { type: 'history', access: 'read' } }).success).toBe(false)
  })

  // Grants change only for folder plugins, an install plugin's grants are its manifest
  it.each(['grant.widen', 'grant.narrow', 'item.on', 'item.off'])('refuses an install-only type in %s', kind => {
    expect(change.safeParse({ kind, plugin: 'search', capability: { type: 'guard.hook' } }).success).toBe(false)
    expect(change.safeParse({ kind, plugin: 'search', capability: { type: 'ui.panel' } }).success).toBe(true)
  })

  it('takes a luoshu folder as text with no control characters', () => {
    expect(change.safeParse({ kind: 'luoshu.set', folder: 'C:\\Users\\han\\notes' }).success).toBe(true)
    expect(change.safeParse({ kind: 'luoshu.set', folder: 'x'.repeat(MAX_FOLDER_LENGTH) }).success).toBe(true)
    for (const folder of ['', '/notes\n/etc', '/notes\u0000/etc', '/notes\u001b[2K/etc', 'x'.repeat(MAX_FOLDER_LENGTH + 1)]) {
      expect(change.safeParse({ kind: 'luoshu.set', folder }).success).toBe(false)
    }
  })

  // The trusted window shows the folder before Confirm, where an override would show the path in another order
  it('refuses a luoshu folder with a bidi control', () => {
    for (const folder of ['/Users/me/\u202esseteton', '/Users/\u2066me\u2069/notes', '/notes\u202d/x']) {
      expect(change.safeParse({ kind: 'luoshu.set', folder }).success).toBe(false)
    }
  })

  it('takes a switch only as a boolean', () => {
    for (const on of ['true', 1, null]) {
      expect(change.safeParse({ kind: 'confirmOff', on }).success).toBe(false)
      expect(change.safeParse({ kind: 'devMode', plugin: 'search', on }).success).toBe(false)
    }
  })

  it('refuses a plugin on a switch that holds for everything', () => {
    expect(change.safeParse({ kind: 'recordNothing', on: true, plugin: 'search' }).success).toBe(false)
  })

  it('takes an unsigned build only by its lowercase content hash', () => {
    for (const hash of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`, '']) {
      expect(change.safeParse({ kind: 'allowUnsigned', hash, on: true }).success).toBe(false)
    }
  })

  describe('limit.set', () => {
    it.each(floorConstantNames)('takes the floor constant %s', constant => {
      expect(change.safeParse({ kind: 'limit.set', constant, value: 1, plugin: null }).success).toBe(true)
    })

    it('says all plugins with null, never with a name a plugin could hold', () => {
      expect(change.parse({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null })).toMatchObject({ plugin: null })
      expect(change.safeParse({ kind: 'limit.set', constant: 'readyMs', value: 20000 }).success).toBe(false)
    })

    it.each([
      ['an unknown constant', { constant: 'maxPlugins', value: 1 }],
      ['zero', { constant: 'callsInFlight', value: 0 }],
      ['a negative value', { constant: 'callsInFlight', value: -1 }],
      ['a value that is not whole', { constant: 'callsInFlight', value: 1.5 }],
      ['a value past the safe integers', { constant: 'callsInFlight', value: 2 ** 53 }],
      ['a value as text', { constant: 'callsInFlight', value: '64' }],
      ['a deadline past the longest timer', { constant: 'callDeadlineMs', value: 2 ** 31 }],
      ['a heartbeat past the longest timer', { constant: 'heartbeatMs', value: 2 ** 31 }],
    ])('refuses %s', (_name, over) => {
      expect(change.safeParse({ kind: 'limit.set', plugin: null, ...over }).success).toBe(false)
    })

    it('takes a time up to the longest timer and any other constant past it', () => {
      for (const constant of timeConstants) {
        expect(change.safeParse({ kind: 'limit.set', constant, value: MAX_TIMER_MS, plugin: 'search' }).success).toBe(true)
      }
      expect(timeConstants).toEqual(['callDeadlineMs', 'guardAnswerMs', 'readyMs', 'stopGraceMs', 'heartbeatMs', 'floodMs'])
      expect(change.safeParse({ kind: 'limit.set', constant: 'bytesInFlight', value: 2 ** 40, plugin: null }).success).toBe(true)
    })
  })
})

describe('keys that reach Object', () => {
  it.each([
    ['__proto__ beside the fields', '{"kind":"plugin.on","plugin":"search","__proto__":{"kind":"confirmOff"}}'],
    ['__proto__ in the capability', '{"kind":"grant.widen","plugin":"search","capability":{"type":"storage","__proto__":{}}}'],
    ['constructor beside the fields', '{"kind":"confirmOff","on":true,"constructor":1}'],
    ['constructor in the capability', '{"kind":"item.on","plugin":"search","capability":{"type":"ui.panel","constructor":1}}'],
    ['prototype beside the fields', '{"kind":"luoshu.set","folder":"/x","prototype":1}'],
    ['prototype in the capability', '{"kind":"item.off","plugin":"s","capability":{"type":"log.read","prototype":{}}}'],
  ])('refuses %s', (_name, text) => {
    expect(change.safeParse(raw(text)).success).toBe(false)
  })
})
