import { describe, expect, it } from 'vitest'
import {
  ack, busSignals, caller, event, kindOf, messageKinds, reasonCodes, refusal, refusalCodes, reply, request, signal, VERSION,
} from '../api/envelope.ts'
import { floorConstants } from '../api/floor.ts'
import { MAX_DEPTH, plainProblem } from '../api/plain.ts'

const MiB = 1024 * 1024
const call = (over: object = {}) => ({ v: 1, kind: 'call', id: 7, action: 'luoshu.read', args: { path: 'notes/a.md' }, ...over })
// JSON.parse keeps __proto__ as an own key, which is how such a key arrives from a file or a port
const raw = (text: string) => JSON.parse(text)
const nest = (levels: number, inner: unknown = 1): unknown => {
  let value = inner
  for (let i = 0; i < levels; i++) value = { a: value }
  return value
}

describe('the fixed lists', () => {
  it('has the twelve message kinds', () => {
    expect(messageKinds).toEqual(['init', 'ready', 'call', 'reply', 'cancel', 'event', 'ack', 'deps', 'ping', 'pong', 'stop', 'stopped'])
  })

  it('has the seventeen refusal codes', () => {
    expect(refusalCodes).toEqual([
      'invalid', 'not-granted', 'not-found', 'needs-confirm', 'switched-off', 'unavailable', 'starting', 'policy-down',
      'guard-refused', 'guard-down', 'throttled', 'timeout', 'stopped', 'crashed', 'failed', 'stale', 'tampered',
    ])
  })

  it('has the six reason codes', () => {
    expect(reasonCodes).toEqual(['declined', 'too-large', 'cycle', 'dependency', 'reserved-id', 'quota'])
  })

  it('keeps every list frozen, so code sharing the process can not add to one', () => {
    for (const list of [messageKinds, refusalCodes, reasonCodes]) {
      expect(Object.isFrozen(list)).toBe(true)
      expect(() => (list as unknown as string[]).push('x')).toThrow()
    }
  })
})

describe('the kind of a message', () => {
  it.each(messageKinds)('reads %s in this version', kind => {
    expect(kindOf({ v: VERSION, kind })).toBe(kind)
  })

  it.each([
    ['another version', { v: 2, kind: 'call' }],
    ['a version as text', { v: '1', kind: 'call' }],
    ['no version', { kind: 'call' }],
    ['an unknown kind', { v: 1, kind: 'hello' }],
    ['a kind that is not text', { v: 1, kind: 3 }],
    ['an array', [1, 'call']],
    ['null', null],
    ['text', 'call'],
  ])('reads nothing from %s', (_name, message) => {
    expect(kindOf(message)).toBeNull()
  })
})

describe('a request', () => {
  it.each([
    ['a plain call', call()],
    ['a call with parent and onBehalf', call({ parent: 'c0ffee-42_x', onBehalf: 'https://client.example/metadata.json' })],
    ['a call with no args', call({ args: undefined })],
    ['id 0', call({ id: 0 })],
    ['an action with a dash in the namespace and camel case in the name', call({ action: 'file-explorer.openFolder' })],
    ['args with null, undefined, numbers, booleans and a null prototype object', call({ args: { a: null, b: undefined, c: [1, -0, 2.5], d: true, e: Object.create(null) } })],
  ])('takes %s', (_name, message) => {
    expect(request.safeParse(message).success).toBe(true)
  })

  const refused: [string, unknown][] = [
    ['another version', call({ v: 2 })],
    ['no version', { kind: 'call', id: 7, action: 'luoshu.read', args: {} }],
    ['another kind', call({ kind: 'reply' })],
    ['a negative id', call({ id: -1 })],
    ['an id that is not whole', call({ id: 1.5 })],
    ['an id past the safe integers', call({ id: 2 ** 53 })],
    ['an id as text', call({ id: '7' })],
    ['an action with no namespace', call({ action: 'read' })],
    ['an action with two dots', call({ action: 'luoshu.read.x' })],
    ['an uppercase namespace', call({ action: 'Luoshu.read' })],
    ['a name starting with a capital', call({ action: 'luoshu.Read' })],
    ['a name starting with a digit', call({ action: 'luoshu.1read' })],
    ['an empty name', call({ action: 'luoshu.' })],
    ['an empty namespace', call({ action: '.read' })],
    ['a namespace over 64 characters', call({ action: `${'a'.repeat(65)}.read` })],
    ['a name over 64 characters', call({ action: `luoshu.${'a'.repeat(65)}` })],
    ['an empty parent', call({ parent: '' })],
    ['a parent with a space', call({ parent: 'a b' })],
    ['a parent over 64 characters', call({ parent: 'a'.repeat(65) })],
    ['an empty onBehalf', call({ onBehalf: '' })],
    ['an onBehalf with a control character', call({ onBehalf: 'agent\nadmin' })],
    ['an onBehalf with an escape', call({ onBehalf: 'agent\u001b[2Kadmin' })],
    ['an onBehalf with a right to left override', call({ onBehalf: 'agent\u202enimda' })],
    ['an onBehalf with a bidi isolate', call({ onBehalf: 'agent\u2067admin\u2069' })],
    ['an onBehalf over 512 characters', call({ onBehalf: 'a'.repeat(513) })],
    // Floor rule 1, a message never names the sender
    ['a caller in the message', call({ caller: { kind: 'plugin', id: 'gate', half: 'host', incarnation: 1 } })],
    ['an unknown field', call({ chain: [] })],
    ['__proto__ beside the fields', raw('{"v":1,"kind":"call","id":7,"action":"luoshu.read","args":{},"__proto__":{"admin":true}}')],
    ['constructor beside the fields', call({ constructor: 1 })],
  ]

  it.each(refused)('refuses %s', (_name, message) => {
    expect(request.safeParse(message).success).toBe(false)
  })

  describe('its args', () => {
    it.each([
      ['__proto__ at the top', '{"__proto__":{"x":1}}'],
      ['__proto__ one level down', '{"a":{"__proto__":{"x":1}}}'],
      ['__proto__ inside an array', '{"a":[1,{"__proto__":{}}]}'],
      ['__proto__ deep down', `${'{"a":'.repeat(30)}{"__proto__":1}${'}'.repeat(30)}`],
      ['constructor', '{"constructor":{"prototype":{}}}'],
      ['constructor deep down', `${'{"a":'.repeat(30)}{"constructor":1}${'}'.repeat(30)}`],
      ['prototype', '{"a":[{"prototype":1}]}'],
    ])('refuses %s', (_name, args) => {
      expect(request.safeParse(call({ args: raw(args) })).success).toBe(false)
    })

    it('refuses a port anywhere in them', () => {
      const { port1, port2 } = new MessageChannel()
      try {
        expect(request.safeParse(call({ args: port1 })).success).toBe(false)
        expect(request.safeParse(call({ args: { deep: [{ port: port1 }] } })).success).toBe(false)
      } finally {
        port1.close()
        port2.close()
      }
    })

    class Note {
      text = 'x'
    }
    // Structured clone turns one into a plain array, so only a caller in main's own process could send one
    class List extends Array {}
    it.each([
      ['a Map', new Map([['a', 1]])],
      ['a Set', new Set([1])],
      ['a Date', new Date(0)],
      ['a class instance', new Note()],
      ['an object with another prototype', Object.create({ admin: true })],
      ['an array of a subclass with its own methods', List.from([1])],
      ['an array with no prototype', Object.setPrototypeOf([1], null)],
      ['a function', () => 1],
      ['a symbol', Symbol('x')],
      ['a bigint', 1n],
      ['a typed array', new Uint8Array(4)],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('refuses %s, which is not plain data', (_name, value) => {
      expect(request.safeParse(call({ args: { value } })).success).toBe(false)
    })

    it('refuses an object reached twice, which could stand for a huge value', () => {
      const shared = { a: 1 }
      expect(request.safeParse(call({ args: { one: shared, two: shared } })).success).toBe(false)
      const loop: Record<string, unknown> = {}
      loop.self = loop
      expect(request.safeParse(call({ args: loop })).success).toBe(false)
    })

    it(`takes ${MAX_DEPTH} levels of nesting and refuses one more`, () => {
      // Pinned, since the cases below follow MAX_DEPTH wherever it goes. JSON.stringify and structuredClone on Node 24 run
      // out of stack by 10000 levels
      expect(MAX_DEPTH).toBe(64)
      expect(request.safeParse(call({ args: nest(MAX_DEPTH) })).success).toBe(true)
      expect(request.safeParse(call({ args: nest(MAX_DEPTH + 1) })).success).toBe(false)
    })

    it('refuses nesting far too deep for a recursive walk without overflowing', () => {
      expect(plainProblem(nest(200000), MiB)).toBe(`nested deeper than ${MAX_DEPTH}`)
    })

    it('takes args just under the 1 MiB cap and refuses them past it', () => {
      expect(floorConstants.argumentBytes).toBe(MiB)
      expect(request.safeParse(call({ args: 'x'.repeat(MiB - 100) })).success).toBe(true)
      expect(request.safeParse(call({ args: 'x'.repeat(MiB + 1) })).success).toBe(false)
    })

    it('counts UTF-8 bytes, not characters', () => {
      const euros = '€'.repeat(Math.ceil(MiB / 3) + 1)
      expect(euros.length).toBeLessThan(MiB)
      expect(request.safeParse(call({ args: euros })).success).toBe(false)
    })

    // 8 for the value plus the character's own UTF-8 bytes: 2 for Latin, Greek and Cyrillic letters, 4 for a pair
    it('counts 2 bytes for a character under U+0800 and 4 for a surrogate pair', () => {
      expect(plainProblem('\u00e9', 9)).toBe('larger than 9 bytes')
      expect(plainProblem('\u00e9', 10)).toBeNull()
      expect(plainProblem('\u{1F600}', 11)).toBe('larger than 11 bytes')
      expect(plainProblem('\u{1F600}', 12)).toBeNull()
    })

    it('counts 8 for every value beside the bytes of every key and string', () => {
      // 8 for the object, 1 for the key, 8 for the value and 2 for its text
      expect(plainProblem({ a: 'xy' }, 19)).toBeNull()
      expect(plainProblem({ a: 'xy' }, 18)).toBe('larger than 18 bytes')
    })

    it('counts the slots of a sparse array and the values of empty strings', () => {
      expect(request.safeParse(call({ args: new Array(200000) })).success).toBe(false)
      expect(request.safeParse(call({ args: new Array(100000).fill('') })).success).toBe(false)
      expect(request.safeParse(call({ args: new Array(1000).fill('') })).success).toBe(true)
    })

    it('stops walking a huge value once it is past the cap', () => {
      const huge = Array.from({ length: 2000000 }, (_, i) => i)
      const started = performance.now()
      expect(plainProblem(huge, MiB)).toBe(`larger than ${MiB} bytes`)
      expect(performance.now() - started).toBeLessThan(50)
    })

    it('stops a wide object at its first key past the cap, before the keys after it are looked at', () => {
      const wide = Object.fromEntries([...Array.from({ length: 200 }, (_, i) => [`k${i}`, 1]), ['constructor', 1]])
      expect(Object.keys(wide).at(-1)).toBe('constructor')
      expect(plainProblem(wide, 100)).toBe('larger than 100 bytes')
      expect(plainProblem(wide, MiB)).toBe('the key constructor')
    })
  })
})

describe('a reply', () => {
  const head = { v: 1, kind: 'reply', id: 7, callId: 'call-1' }

  it('takes a result and a refusal', () => {
    expect(reply.safeParse({ ...head, ok: true, result: { text: 'hello' } }).success).toBe(true)
    expect(reply.safeParse({ ...head, ok: false, refusal: { code: 'not-granted', action: 'luoshu.read' } }).success).toBe(true)
  })

  it.each([
    ['a result beside a refusal', { ...head, ok: true, result: 1, refusal: { code: 'failed', action: 'luoshu.read' } }],
    ['a refusal marked ok', { ...head, ok: true, refusal: { code: 'failed', action: 'luoshu.read' } }],
    ['a result marked not ok', { ...head, ok: false, result: 1 }],
    ['ok as text', { ...head, ok: 'true', result: 1 }],
    ['no call id', { v: 1, kind: 'reply', id: 7, ok: true, result: 1 }],
    ['another version', { ...head, v: 2, ok: true, result: 1 }],
    ['an unknown field', { ...head, ok: true, result: 1, extra: 1 }],
    ['__proto__ in the result', raw('{"v":1,"kind":"reply","id":7,"callId":"c","ok":true,"result":{"a":{"__proto__":{}}}}')],
    ['constructor in the result', { ...head, ok: true, result: [{ constructor: 1 }] }],
    ['prototype in the result', { ...head, ok: true, result: { prototype: 1 } }],
    // A callee's refusal never carries another principal's id, path or lease (A-05)
    ['a refusal outside the refusal schema', { ...head, ok: false, refusal: { code: 'guard-refused', action: 'luoshu.write', holder: 'mcp' } }],
  ])('refuses %s', (_name, message) => {
    expect(reply.safeParse(message).success).toBe(false)
  })

  it('takes a result up to 16 MiB and refuses one past it', () => {
    expect(floorConstants.resultBytes).toBe(16 * MiB)
    expect(reply.safeParse({ ...head, ok: true, result: 'x'.repeat(16 * MiB - 100) }).success).toBe(true)
    expect(reply.safeParse({ ...head, ok: true, result: 'x'.repeat(16 * MiB + 1) }).success).toBe(false)
  })
})

describe('a refusal', () => {
  it.each(refusalCodes)('takes the code %s', code => {
    expect(refusal.safeParse({ code, action: 'luoshu.read' }).success).toBe(true)
  })

  it.each(reasonCodes)('takes the reason %s', reason => {
    expect(refusal.safeParse({ code: 'not-granted', action: 'luoshu.read', reason }).success).toBe(true)
  })

  it('takes the request id behind needs-confirm', () => {
    expect(refusal.safeParse({ code: 'needs-confirm', action: 'luoshu.write', request: 'req-1' }).success).toBe(true)
  })

  it.each([
    ['an unknown code', { code: 'forbidden', action: 'luoshu.read' }],
    ['a reason that is not a fixed code', { code: 'not-granted', action: 'luoshu.read', reason: 'held by mcp' }],
    // Never another principal's id, path or lease
    ['another plugin named beside it', { code: 'guard-refused', action: 'luoshu.write', holder: 'mcp' }],
    ['a path beside it', { code: 'not-found', action: 'luoshu.read', path: 'secret/a.md' }],
    ['an action past its cap', { code: 'invalid', action: 'a'.repeat(200) }],
    ['a request id with a space', { code: 'needs-confirm', action: 'luoshu.write', request: 'a b' }],
    ['__proto__', raw('{"code":"invalid","action":"luoshu.read","__proto__":{"reason":"declined"}}')],
    ['constructor', { code: 'invalid', action: 'luoshu.read', constructor: 1 }],
    ['prototype', { code: 'invalid', action: 'luoshu.read', prototype: 1 }],
  ])('refuses %s', (_name, value) => {
    expect(refusal.safeParse(value).success).toBe(false)
  })
})

describe('a caller', () => {
  it.each([
    ['a plugin half', { kind: 'plugin', id: 'search', half: 'worker', incarnation: 1 }],
    ['a frame half', { kind: 'plugin', id: 'search', half: 'panel', incarnation: 3 }],
    ['the editor window', { kind: 'window', role: 'editor', n: 1 }],
    ['the trusted window', { kind: 'window', role: 'trusted', n: 0 }],
    ['a content frame, reserved for #97', { kind: 'content', plugin: 'artifacts', token: 'tok_1' }],
  ])('takes %s', (_name, value) => {
    expect(caller.safeParse(value).success).toBe(true)
  })

  it.each([
    ['a dotted plugin id', { kind: 'plugin', id: 'my.plugin', half: 'worker', incarnation: 1 }],
    ['incarnation 0', { kind: 'plugin', id: 'search', half: 'worker', incarnation: 0 }],
    ['a half that is not a name', { kind: 'plugin', id: 'search', half: 'Worker', incarnation: 1 }],
    ['another window role', { kind: 'window', role: 'host', n: 1 }],
    ['a negative window number', { kind: 'window', role: 'editor', n: -1 }],
    ['a content token outside the grammar', { kind: 'content', plugin: 'artifacts', token: 'a b' }],
    ['a content caller with a dotted plugin', { kind: 'content', plugin: 'my.plugin', token: 't' }],
    ['an unknown kind', { kind: 'agent', id: 'claude' }],
    ['an onBehalf inside it', { kind: 'window', role: 'editor', n: 1, onBehalf: 'x' }],
    ['__proto__', raw('{"kind":"window","role":"editor","n":1,"__proto__":{"role":"trusted"}}')],
    ['constructor', { kind: 'window', role: 'editor', n: 1, constructor: 1 }],
    ['prototype', { kind: 'content', plugin: 'artifacts', token: 't', prototype: 1 }],
  ])('refuses %s', (_name, value) => {
    expect(caller.safeParse(value).success).toBe(false)
  })
})

describe('what the bus pushes and hears', () => {
  const pushed = (over: object = {}) => ({ v: 1, kind: 'event', seq: 1, topic: 'luoshu.changed', path: 'notes/a.md', ...over })

  it('has the two signals', () => {
    expect(busSignals).toEqual(['events.dropped', 'events.ended'])
    expect(Object.isFrozen(busSignals)).toBe(true)
  })

  it.each([
    ['an event with a path', pushed()],
    ['an event with no path', { v: 1, kind: 'event', seq: 3, topic: 'search.indexed' }],
    ['a core topic', { v: 1, kind: 'event', seq: 1, topic: 'core.status' }],
  ])('takes %s', (_name, message) => {
    expect(event.safeParse(message).success).toBe(true)
  })

  it.each([
    ['no seq', { v: 1, kind: 'event', topic: 'luoshu.changed' }],
    ['seq 0', pushed({ seq: 0 })],
    ['a seq that is not whole', pushed({ seq: 1.5 })],
    ['content beside the path', pushed({ text: 'the whole note' })],
    ['a signal\'s topic', pushed({ topic: 'events.dropped' })],
    ['a topic outside the grammar', pushed({ topic: 'luoshu' })],
    ['an empty path', pushed({ path: '' })],
    ['a path with a dot segment', pushed({ path: 'notes/../a.md' })],
    ['a path with a backslash', pushed({ path: 'notes\\a.md' })],
    ['another version', pushed({ v: 2 })],
    ['another kind', pushed({ kind: 'call' })],
  ])('refuses an event with %s', (_name, message) => {
    expect(event.safeParse(message).success).toBe(false)
  })

  it('shapes a signal with the subscriber\'s own topics and no seq, which no event schema takes', () => {
    for (const topic of busSignals) {
      const message = { v: 1, kind: 'event', topic, topics: ['luoshu.changed', 'luoshu.outside'] }
      expect(signal.safeParse(message).success).toBe(true)
      expect(event.safeParse(message).success).toBe(false)
    }
    expect(signal.safeParse({ v: 1, kind: 'event', topic: 'events.dropped', topics: [] }).success).toBe(false)
    expect(signal.safeParse({ v: 1, kind: 'event', topic: 'events.dropped', topics: ['luoshu.changed'], seq: 1 }).success).toBe(false)
    expect(signal.safeParse({ v: 1, kind: 'event', topic: 'events.other', topics: ['luoshu.changed'] }).success).toBe(false)
    expect(signal.safeParse({ v: 1, kind: 'event', topic: 'events.ended', topics: ['luoshu.changed'], path: 'a.md' }).success).toBe(false)
  })

  it('shapes an ack by a seq and nothing else', () => {
    expect(ack.safeParse({ v: 1, kind: 'ack', seq: 0 }).success).toBe(true)
    expect(ack.safeParse({ v: 1, kind: 'ack', seq: 7 }).success).toBe(true)
    for (const seq of [-1, 1.5, '1', 2 ** 53, null]) expect(ack.safeParse({ v: 1, kind: 'ack', seq }).success).toBe(false)
    expect(ack.safeParse({ v: 1, kind: 'ack' }).success).toBe(false)
    expect(ack.safeParse({ v: 1, kind: 'ack', seq: 1, topic: 'luoshu.changed' }).success).toBe(false)
    expect(ack.safeParse({ v: 2, kind: 'ack', seq: 1 }).success).toBe(false)
  })
})
