import { describe, expect, it } from 'vitest'
import { coreActions, coreTopics, eventActions, MAX_CALL_TOPICS, MAX_FILTER_PATHS, MAX_LEASE_PATHS, providerActions } from '../api/actions.ts'
import { answer, cancel, cancelled, delivery, request, requestEnvelope } from '../api/envelope.ts'
import { coreNamespaces, guardableActions, providers } from '../api/ids.ts'
import { measurePlain, plainProblem } from '../api/plain.ts'
import { pluginStates, slotStates } from '../api/slots.ts'

const MiB = 1024 * 1024
const namespace = (action: string) => action.slice(0, action.indexOf('.'))

describe('the core actions', () => {
  it('names who may call each one, which the floor decides and never the gate', () => {
    expect(Object.fromEntries(Object.entries(coreActions).map(([action, spec]) => [action, spec.from]))).toEqual({
      'core.self': 'any',
      'core.filterReadable': 'any',
      'security.request': 'windows',
      'security.confirm': 'trusted',
      'watchdog.stop': 'watchdog',
      'watchdog.restart': 'watchdog',
      'watchdog.limit': 'watchdog',
    })
  })

  it('lives only in the namespaces the core serves, none of them events, which the bus has, or ui yet', () => {
    for (const action of Object.keys(coreActions)) expect(coreNamespaces).toContain(namespace(action))
    expect(Object.keys(coreActions).some(action => ['events', 'ui'].includes(namespace(action)))).toBe(false)
  })

  it('is frozen with no prototype, so a key naming an Object member finds nothing', () => {
    expect(Object.isFrozen(coreActions)).toBe(true)
    expect(Object.isFrozen(coreActions['core.self'])).toBe(true)
    expect(Object.getPrototypeOf(coreActions)).toBeNull()
    expect(coreActions['toString']).toBeUndefined()
    expect(() => { (coreActions as Record<string, unknown>)['core.load'] = { from: 'any' } }).toThrow()
  })

  it.each([
    ['core.self', undefined, true],
    ['core.self', {}, true],
    ['core.self', { as: 'gate' }, false],
    ['core.filterReadable', { call: 'c1', paths: ['notes/a.md'] }, true],
    ['core.filterReadable', { call: 'a b', paths: [] }, false],
    ['core.filterReadable', { call: 'c1', paths: [''] }, false],
    ['core.filterReadable', { call: 'c1', paths: Array.from({ length: MAX_FILTER_PATHS + 1 }, () => 'a.md') }, false],
    // A canonical path a link gave can hold a name outside the grammar, which the filter drops rather than refusing
    ['core.filterReadable', { call: 'c1', paths: ['notes\\a.md', 'notes/a:b.md'] }, true],
    ['security.request', { change: { kind: 'plugin.off', plugin: 'gate' } }, true],
    ['security.request', { change: { kind: 'plugin.off', plugin: 'gate' }, confirmed: true }, false],
    ['security.confirm', { requestId: 'req-1' }, true],
    ['security.confirm', { requestId: 'a b' }, false],
    ['security.confirm', { request: 'req-1' }, false],
    ['watchdog.stop', { plugin: 'search' }, true],
    ['watchdog.stop', { plugin: 'my.plugin' }, false],
    ['watchdog.stop', { plugin: 'search', force: true }, false],
    ['watchdog.restart', { plugin: 'search', force: true }, false],
    ['watchdog.limit', { plugin: 'search', constant: 'messagesPerSecond', value: 10 }, true],
    ['watchdog.limit', { plugin: 'search', constant: 'messagesPerSecond', value: 1.5 }, false],
  ])('checks %s with %j', (action, args, ok) => {
    expect(coreActions[action].args.safeParse(args).success).toBe(ok)
  })
})

describe('the bus\'s actions', () => {
  it('serves subscribe, unsubscribe and publish in events, with the two topics the core sends', () => {
    expect(Object.keys(eventActions)).toEqual(['events.subscribe', 'events.unsubscribe', 'events.publish'])
    expect(coreTopics).toEqual(['core.status', 'core.security'])
    expect(Object.isFrozen(eventActions) && Object.isFrozen(coreTopics)).toBe(true)
    expect(Object.getPrototypeOf(eventActions)).toBeNull()
    // Acknowledging is the ack message, never a call
    expect(eventActions['events.ack']).toBeUndefined()
  })

  it.each([
    ['events.subscribe', { topics: ['vault.changed'] }, true],
    ['events.subscribe', { topics: ['core.status', 'core.security'] }, true],
    ['events.subscribe', { topics: ['core.status', 'vault.changed'] }, true],
    ['events.subscribe', { topics: ['file-explorer.opened'] }, true],
    ['events.subscribe', { topics: Array.from({ length: MAX_CALL_TOPICS }, (_, i) => `p${i}.a`) }, true],
    ['events.subscribe', { topics: Array.from({ length: MAX_CALL_TOPICS + 1 }, (_, i) => `p${i}.a`) }, false],
    ['events.subscribe', { topics: [] }, false],
    ['events.subscribe', { topics: ['core.secret'] }, false],
    ['events.subscribe', { topics: ['events.dropped'] }, false],
    ['events.subscribe', { topics: ['events.ended'] }, false],
    ['events.subscribe', { topics: ['security.request'] }, false],
    ['events.subscribe', { topics: ['watchdog.stop'] }, false],
    ['events.subscribe', { topics: ['ui.panel'] }, false],
    ['events.subscribe', { topics: ['plugin.call'] }, false],
    ['events.subscribe', { topics: ['vault.*'] }, false],
    ['events.subscribe', { topics: ['vault'] }, false],
    ['events.subscribe', { topics: 'vault.changed' }, false],
    ['events.subscribe', { topics: ['vault.changed'], paths: ['**'] }, false],
    ['events.unsubscribe', { topics: ['vault.changed'] }, true],
    ['events.unsubscribe', { topics: ['events.dropped'] }, false],
    ['events.publish', { topic: 'search.indexed' }, true],
    ['events.publish', { topic: 'vault.changed', path: 'notes/a.md' }, true],
    // The floor refuses a topic no manifest can declare, which shape leaves to it
    ['events.publish', { topic: 'core.status' }, true],
    ['events.publish', { topic: 'vault.changed', path: '' }, false],
    ['events.publish', { topic: 'vault.changed', path: 'notes\\a.md' }, false],
    ['events.publish', { topic: 'vault.changed', path: 'notes/../a.md' }, false],
    ['events.publish', { topic: 'vault.changed', path: 'notes/a.md', text: 'the note' }, false],
    ['events.publish', { topic: 'vault.changed', path: 'notes/a.md', version: 3 }, false],
    ['events.publish', { topics: ['vault.changed'] }, false],
    ['events.publish', { topic: 'vault' }, false],
  ])('checks %s with %j', (action, args, ok) => {
    expect(eventActions[action].args.safeParse(args).success).toBe(ok)
  })
})

describe('the provider actions', () => {
  it('checks each against the capability it needs, the free ones against none', () => {
    expect(Object.fromEntries(Object.entries(providerActions).map(([action, spec]) => [action, spec.capability]))).toEqual({
      'vault.read': 'vault.read',
      'vault.write': 'vault.write',
      'leases.acquire': 'vault.write',
      'leases.renew': null,
      'leases.release': null,
      'leases.list': null,
      'storage.get': null,
      'storage.set': null,
      'storage.delete': null,
      'cache.get': null,
      'cache.set': null,
      'cache.delete': null,
      'log.history': 'log.read',
      'log.verify': 'log.read',
    })
  })

  it('belongs only to provider namespaces', () => {
    for (const action of Object.keys(providerActions)) expect(Object.keys(providers)).toContain(namespace(action))
  })

  it('keeps writes one audit record each and the guardable action among them', () => {
    const writes = Object.entries(providerActions).filter(([, spec]) => spec.write).map(([action]) => action)
    expect(writes).toEqual(['vault.write', 'leases.acquire', 'leases.renew', 'leases.release', 'storage.set', 'storage.delete', 'cache.set', 'cache.delete'])
    for (const action of guardableActions) expect(providerActions[action].write).toBe(true)
  })

  it('takes the raw scope from the argument it names', () => {
    expect(providerActions['vault.read'].scope).toBe('path')
    expect(providerActions['leases.acquire'].scope).toBe('paths')
    expect(providerActions['log.history'].scope).toBeNull()
  })

  it.each([
    ['vault.read', { path: 'notes/a.md' }, true],
    ['vault.read', { path: '' }, false],
    ['vault.read', { path: 'a'.repeat(513) }, false],
    ['vault.read', { path: 'a.md', follow: true }, false],
    // Spellings no canonical path holds, refused at shape. A trailing dot and a device name are the canonicaliser's
    ['vault.read', { path: 'notes\\a.md' }, false],
    ['vault.read', { path: 'notes/a:b.md' }, false],
    ['vault.read', { path: `notes/a${String.fromCharCode(7)}.md` }, false],
    ['vault.read', { path: 'notes//a.md' }, false],
    ['vault.read', { path: 'notes/./a.md' }, false],
    ['vault.read', { path: 'notes/../a.md' }, false],
    ['vault.read', { path: '/notes/a.md' }, false],
    ['vault.read', { path: 'C:/notes/a.md' }, false],
    ['vault.read', { path: `notes/${String.fromCharCode(0xd800)}.md` }, false],
    ['vault.read', { path: 'notes/a.md.' }, true],
    ['vault.read', { path: 'notes/con' }, true],
    ['vault.write', { path: 'a.md', text: 'x' }, true],
    ['vault.write', { path: 'a.md', text: 'x', baseVersion: 'f'.repeat(64) }, true],
    ['vault.write', { path: 'a.md', text: 'x', baseVersion: 'F'.repeat(64) }, false],
    ['vault.write', { path: 'a.md' }, false],
    ['vault.write', { path: 'a.md', text: 42 }, false],
    ['vault.write', { path: 'notes\\a.md', text: 'x' }, false],
    ['leases.acquire', { paths: ['a.md'] }, true],
    ['leases.acquire', { paths: [] }, false],
    ['leases.acquire', { paths: Array.from({ length: MAX_LEASE_PATHS + 1 }, (_, i) => `${i}.md`) }, false],
    ['leases.acquire', { paths: ['notes/a.md', 'notes\\b.md'] }, false],
    ['leases.list', undefined, true],
    ['leases.list', { paths: ['a.md'] }, false],
    ['storage.get', { key: 'index' }, true],
    ['storage.get', { key: '../search/index' }, false],
    ['storage.set', { key: 'index', value: { a: [1] } }, true],
    ['storage.set', { key: '../search/index', value: 1 }, false],
    ['cache.set', { key: 'a/b', value: 1 }, false],
    ['storage.get', { key: 'index', plugin: 'search' }, false],
    ['log.history', undefined, true],
  ])('checks %s with %j', (action, args, ok) => {
    expect(providerActions[action].args.safeParse(args).success).toBe(ok)
  })
})

describe('the envelope beside a request', () => {
  const call = { v: 1, kind: 'call', id: 1, action: 'vault.read', args: { path: 'a.md' } }

  it('leaves args to the carrier, which measures them against the caller\'s own cap', () => {
    const big = { ...call, args: 'x'.repeat(MiB + 1) }
    expect(request.safeParse(big).success).toBe(false)
    expect(requestEnvelope.safeParse(big).success).toBe(true)
  })

  it('refuses in the envelope what the request refuses outside args', () => {
    for (const bad of [{ ...call, v: 2 }, { ...call, caller: { kind: 'window', role: 'trusted', n: 0 } }, { ...call, id: -1 }, { ...call, action: 'read' }]) {
      expect(requestEnvelope.safeParse(bad).success).toBe(false)
    }
  })

  it('shapes a delivery with the caller and no parent', () => {
    const delivered = { v: 1, kind: 'call', callId: 'c1', caller: { kind: 'plugin', id: 'http', half: 'host', incarnation: 1 }, action: 'mcp.handle', args: {}, deadline: 1 }
    expect(delivery.safeParse(delivered).success).toBe(true)
    expect(delivery.safeParse({ ...delivered, onBehalf: 'agent-a' }).success).toBe(true)
    expect(delivery.safeParse({ ...delivered, parent: 'p1' }).success).toBe(false)
    expect(delivery.safeParse({ ...delivered, caller: { kind: 'agent' } }).success).toBe(false)
    expect(delivery.safeParse({ ...delivered, deadline: 1.5 }).success).toBe(false)
  })

  it('shapes a callee\'s answer by call id with a refusal inside its schema', () => {
    expect(answer.safeParse({ v: 1, kind: 'reply', callId: 'c1', ok: true, result: 'x'.repeat(MiB) }).success).toBe(true)
    expect(answer.safeParse({ v: 1, kind: 'reply', callId: 'c1', ok: false, refusal: { code: 'not-found', action: 'git.log' } }).success).toBe(true)
    expect(answer.safeParse({ v: 1, kind: 'reply', callId: 'c1', ok: false, refusal: { code: 'not-found', action: 'git.log', holder: 'mcp' } }).success).toBe(false)
    expect(answer.safeParse({ v: 1, kind: 'reply', id: 1, callId: 'c1', ok: true, result: 1 }).success).toBe(false)
  })

  it('shapes a cancel by the caller\'s own id one way and by call id the other', () => {
    expect(cancel.safeParse({ v: 1, kind: 'cancel', id: 3 }).success).toBe(true)
    expect(cancel.safeParse({ v: 1, kind: 'cancel', callId: 'c1' }).success).toBe(false)
    expect(cancelled.safeParse({ v: 1, kind: 'cancel', callId: 'c1' }).success).toBe(true)
    expect(cancelled.safeParse({ v: 1, kind: 'cancel', id: 3 }).success).toBe(false)
    // Never both
    expect(cancel.safeParse({ v: 1, kind: 'cancel', id: 3, callId: 'c1' }).success).toBe(false)
    expect(cancelled.safeParse({ v: 1, kind: 'cancel', callId: 'c1', id: 3 }).success).toBe(false)
  })
})

describe('measuring plain data', () => {
  it('gives the bytes plainProblem counts', () => {
    // 8 for the object, 1 for the key, 8 for the value and 2 for its text
    expect(measurePlain({ a: 'xy' }, 100)).toEqual({ ok: true, bytes: 19 })
    expect(measurePlain(undefined, 100)).toEqual({ ok: true, bytes: 8 })
  })

  it('tells the size cap from the other problems', () => {
    expect(measurePlain({ a: 'xy' }, 18)).toEqual({ ok: false, problem: 'larger than 18 bytes', tooLarge: true })
    expect(measurePlain({ a: new Date(0) }, 100)).toEqual({ ok: false, problem: 'not plain data', tooLarge: false })
    expect(plainProblem({ a: 'xy' }, 18)).toBe('larger than 18 bytes')
    expect(plainProblem({ a: 'xy' }, 19)).toBeNull()
    // Past the cap on an array's slots and on a key, before any value is walked
    expect(measurePlain(new Array(10), 50)).toMatchObject({ ok: false, tooLarge: true })
    expect(measurePlain({ ['k'.repeat(60)]: 1 }, 50)).toMatchObject({ ok: false, tooLarge: true })
  })
})

describe('the state lists', () => {
  it('has the six slot states and the plugin lifecycle states', () => {
    expect(slotStates).toEqual(['on', 'off', 'starting', 'failed', 'absent', 'tampered'])
    expect(pluginStates).toEqual(['found', 'refused', 'waiting', 'off', 'starting', 'ready', 'unresponsive', 'stopping', 'stopped', 'crashed', 'failed'])
    expect(Object.isFrozen(slotStates) && Object.isFrozen(pluginStates)).toBe(true)
  })
})
