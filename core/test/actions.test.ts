import { describe, expect, it } from 'vitest'
import {
  coreActions, coreTopics, eventActions, installProblems, LIST_PAGE, MAX_CALL_TOPICS, MAX_FILTER_PATHS, MAX_LINK_LENGTH, MAX_LOCK_PATHS, MAX_RELEASE_ZIPS,
  MAX_REFUSAL_COUNT, providerActions, refusedReasons, roleActions,
} from '../api/actions.ts'
import { answer, cancel, cancelled, delivery, request, callEnvelope } from '../api/envelope.ts'
import { coreNamespaces, guardableActions, providers, serverOf } from '../api/ids.ts'
import { MAX_LIST } from '../api/manifest.ts'
import { MAX_VIEW_BINDINGS } from '../api/ui.ts'
import { measurePlain, plainProblem } from '../api/plain.ts'
import { pluginStates, policyJobStates } from '../api/policy-jobs.ts'

const MiB = 1024 * 1024
const namespace = (action: string) => action.slice(0, action.indexOf('.'))

describe('the core actions', () => {
  it('names who may call each one, which the floor decides and never the gate', () => {
    expect(Object.fromEntries(Object.entries(coreActions).map(([action, spec]) => [action, spec.from]))).toEqual({
      'core.self': 'any',
      'gate.filterReadable': 'any',
      'core.status': 'windows',
      'log.segments': 'windows',
      'log.verify': 'windows',
      'security.request': 'windows',
      'security.confirm': 'trusted',
      'security.cancel': 'trusted',
      'app.openSecurity': 'windows',
      'security.list': 'trusted',
      'core.stop': 'trusted',
      'core.restart': 'windows',
      'app.quit': 'windows',
      'app.relaunch': 'trusted',
      'app.pickFolder': 'trusted',
      'app.stagePicked': 'trusted',
      'core.findRelease': 'trusted',
      'core.stage': 'trusted',
      'core.unstage': 'trusted',
      'gate.reach': 'windows',
      'core.views': 'windows',
      'editor.frame': 'windows',
      'editor.frameGone': 'windows',
      'editor.focusTaken': 'windows',
      'editor.viewKeys': 'windows',
      'editor.image': 'windows',
      'core.refused': 'door',
      'core.bindFailed': 'door',
      'core.identityAsk': 'pair',
      'core.identities': 'door',
      'core.consentAsk': 'door',
      'core.consentAnswer': 'door',
    })
  })

  it('names why a link or a source found nothing to install, fixed and frozen', () => {
    expect(installProblems).toEqual([
      'not-github', 'no-release', 'no-zip', 'rate-limited', 'offline', 'off-github', 'not-found', 'digest-mismatch', 'timed-out',
      'cancelled', 'bad-answer', 'invalid', 'name', 'duplicate', 'special', 'encrypted', 'too-many', 'too-big', 'not-a-folder', 'same-id',
      'none',
    ])
    expect(Object.isFrozen(installProblems)).toBe(true)
  })

  it('names the eight reasons an agent is refused at the door for, fixed and frozen', () => {
    expect(refusedReasons).toEqual(['host', 'origin', 'method', 'size', 'rate', 'token', 'malformed', 'timeout'])
    expect(Object.isFrozen(refusedReasons)).toBe(true)
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

  it.each<[string, unknown, boolean]>([
    ['core.self', undefined, true],
    ['core.self', {}, true],
    ['core.self', { as: 'gate' }, false],
    ['gate.filterReadable', { call: 'c1', paths: ['notes/a.md'] }, true],
    ['gate.filterReadable', { call: 'a b', paths: [] }, false],
    ['gate.filterReadable', { call: 'c1', paths: [''] }, false],
    ['gate.filterReadable', { call: 'c1', paths: Array.from({ length: MAX_FILTER_PATHS + 1 }, () => 'a.md') }, false],
    // A canonical path a link gave can hold a name outside the grammar, which the filter drops rather than refusing
    ['gate.filterReadable', { call: 'c1', paths: ['notes\\a.md', 'notes/a:b.md'] }, true],
    ['security.request', { change: { kind: 'plugin.off', plugin: 'gate' } }, true],
    ['security.request', { change: { kind: 'plugin.off', plugin: 'gate' }, confirmed: true }, false],
    ['security.confirm', { requestId: 'req-1' }, true],
    ['security.confirm', { requestId: 'a b' }, false],
    ['security.confirm', { request: 'req-1' }, false],
    // What the human typed to prove attention, which the core checks against the control's id
    ['security.confirm', { requestId: 'req-1', typed: 'gate' }, true],
    ['security.confirm', { requestId: 'req-1', typed: 'x'.repeat(65) }, false],
    ['security.confirm', { requestId: 'req-1', typed: 7 }, false],
    ['security.cancel', { requestId: 'req-1' }, true],
    ['security.cancel', {}, false],
    ['app.openSecurity', undefined, true],
    ['app.openSecurity', { requestId: 'req-1' }, true],
    ['app.openSecurity', { requestId: 'a b' }, false],
    ['security.list', undefined, true],
    ['security.list', { all: true }, false],
    ['core.stop', { plugin: 'search' }, true],
    ['core.stop', { plugin: 'search', force: true }, false],
    ['core.restart', { plugin: 'search' }, true],
    ['app.quit', undefined, true],
    ['app.quit', { code: 1 }, false],
    ['app.relaunch', undefined, true],
    ['gate.reach', { plugin: 'search', path: 'notes/a.md' }, true],
    ['gate.reach', { plugin: 'search', path: 'notes/../a.md' }, false],
    ['gate.reach', { plugin: 'Search', path: 'a.md' }, false],
    ['gate.reach', { plugin: 'search' }, true],
    ['gate.reach', {}, false],
    ['gate.reach', { plugin: 'search', path: 'a.md', write: true }, false],
    ['core.views', undefined, true],
    ['core.views', { plugin: 'search' }, false],
    ['editor.frame', { plugin: 'kanban', frame: 'board' }, true],
    ['editor.frame', { plugin: 'kanban', frame: 'worker' }, false],
    ['editor.frame', { plugin: 'kanban' }, false],
    ['editor.frame', { plugin: 'Kanban', frame: 'board' }, false],
    ['editor.frameGone', { url: 'hetu://kanban.views/0123456789abcdef0123456789abcdef/dist/board.html', navigated: true }, true],
    ['editor.frameGone', { url: 'hetu://my--board-2.views/0123456789abcdef0123456789abcdef/board.html', navigated: false }, true],
    ['editor.frameGone', { url: 'hetu://my_board-2.views/0123456789abcdef0123456789abcdef/board.html', navigated: false }, false],
    ['editor.frameGone', { url: 'hetu://my---board.views/0123456789abcdef0123456789abcdef/board.html', navigated: false }, false],
    ['editor.frameGone', { url: `hetu://${'a'.repeat(65)}.views/0123456789abcdef0123456789abcdef/board.html`, navigated: false }, false],
    ['editor.frameGone', { url: 'hetu://con.views/0123456789abcdef0123456789abcdef/board.html', navigated: false }, false],
    ['editor.frameGone', { url: 'hetu://views/0123456789abcdef0123456789abcdef/dist/board.html', navigated: true }, false],
    ['editor.frameGone', { url: 'hetu://x.kanban.views/0123456789abcdef0123456789abcdef/board.html', navigated: true }, false],
    ['editor.frameGone', { url: 'hetu://Kanban.views/0123456789abcdef0123456789abcdef/board.html', navigated: true }, false],
    ['editor.frameGone', { url: 'https://example.com/', navigated: false }, false],
    ['editor.frameGone', { url: 'hetu://kanban.views/0123456789abcdef0123456789abcdef/', navigated: 'yes' }, false],
    ['editor.focusTaken', { url: 'hetu://kanban.views/0123456789abcdef0123456789abcdef/board.html' }, true],
    ['editor.focusTaken', { url: 'hetu://x.kanban.views/0123456789abcdef0123456789abcdef/board.html' }, false],
    ['editor.focusTaken', { url: 'https://example.com/' }, false],
    ['editor.focusTaken', {}, false],
    ['editor.viewKeys', { plugin: 'kanban', keys: ['j', 'Mod-Shift-k', 'ArrowDown'] }, true],
    ['editor.viewKeys', { plugin: 'kanban', keys: [] }, true],
    ['editor.viewKeys', { plugin: 'kanban', keys: Array.from({ length: MAX_VIEW_BINDINGS }, (_, i) => `Alt-${i}`) }, true],
    ['editor.viewKeys', { plugin: 'kanban', keys: Array.from({ length: MAX_VIEW_BINDINGS + 1 }, (_, i) => `Alt-${i}`) }, false],
    ['editor.viewKeys', { plugin: 'kanban', keys: ['x'.repeat(65)] }, false],
    ['editor.viewKeys', { plugin: 'kanban', keys: [''] }, false],
    ['editor.viewKeys', { plugin: 'Kanban', keys: ['j'] }, false],
    ['editor.viewKeys', { plugin: 'kanban' }, false],
    ['editor.image', { plugin: 'kanban', path: 'pics/a.png' }, true],
    ['editor.image', { plugin: 'kanban', path: '.obsidian/a.png' }, false],
    ['editor.image', { plugin: 'kanban', path: 'a.md' }, false],
    ['editor.image', { plugin: 'kanban' }, false],
    ['editor.image', { plugin: 'kanban', path: 'a.png', url: 'hetu://images/x' }, false],
    ...refusedReasons.map((reason): [string, unknown, boolean] => ['core.refused', { reason, count: 1 }, true]),
    ['core.refused', { reason: 'token', count: MAX_REFUSAL_COUNT }, true],
    ['core.refused', { reason: 'token', count: MAX_REFUSAL_COUNT + 1 }, false],
    ['core.refused', { reason: 'token', count: 0 }, false],
    ['core.refused', { reason: 'token', count: -1 }, false],
    ['core.refused', { reason: 'token', count: 1.5 }, false],
    ['core.refused', { reason: 'token', count: '3' }, false],
    ['core.refused', { reason: 'token' }, false],
    ['core.refused', { count: 1 }, false],
    ['core.refused', { reason: 'Token', count: 1 }, false],
    ['core.refused', { reason: 'refused at the door', count: 1 }, false],
    ['core.refused', { reason: 'token', count: 1, host: 'evil.example' }, false],
    ['core.refused', { reason: 'token', count: 1, plugin: 'search' }, false],
    ['core.bindFailed', { reason: 'port-taken' }, true],
    ['core.bindFailed', { reason: 'bind-failed' }, true],
    ['core.bindFailed', { reason: 'crashed' }, false],
    ['core.bindFailed', { reason: 'port taken by another program' }, false],
    ['core.bindFailed', {}, false],
    ['core.bindFailed', undefined, false],
    // A half speaks only about itself, so no plugin is named
    ['core.bindFailed', { reason: 'port-taken', plugin: 'gate' }, false],
    ['core.bindFailed', { reason: 'port-taken', port: 4748 }, false],
    // The Install button's flow: a picked zip or folder or a link's release zip staged, then dropped. Its Confirm is a
    // security request
    ['app.stagePicked', { source: 'zip' }, true],
    ['app.stagePicked', { source: 'folder' }, true],
    ['app.stagePicked', { source: 'link' }, false],
    ['app.stagePicked', undefined, false],
    ['core.findRelease', { link: 'https://github.com/someone/plugins' }, true],
    ['core.findRelease', { link: 'x'.repeat(MAX_LINK_LENGTH) }, true],
    ['core.findRelease', { link: 'x'.repeat(MAX_LINK_LENGTH + 1) }, false],
    ['core.findRelease', { link: '' }, false],
    ['core.findRelease', { link: 'https://github.com/someone/plugins' + String.fromCharCode(0x202e) }, false],
    // The window names a release zip by the handle main answered and its place in the list, never by a path or a link
    ['core.stage', { release: 'g1', zip: 0 }, true],
    ['core.stage', { release: 'g1', zip: MAX_RELEASE_ZIPS - 1 }, true],
    ['core.stage', { release: 'g1', zip: MAX_RELEASE_ZIPS }, false],
    ['core.stage', { release: 'g1', zip: -1 }, false],
    ['core.stage', { release: 'g1', zip: 0.5 }, false],
    ['core.stage', { release: 'g1' }, false],
    ['core.stage', { release: 'g1', zip: 0, url: 'https://github.com/someone/plugins/releases/download/v1/a.zip' }, false],
    ['core.stage', { source: { kind: 'zip', path: 'C:\\Users\\someone\\plugins.zip' } }, false],
    ['core.stage', { source: { kind: 'folder', path: '/Users/someone/plugins' } }, false],
    ['core.stage', { source: { kind: 'link', link: 'https://github.com/someone/plugins', asset: 'plugins.zip' } }, false],
    ['core.stage', { release: '../x', zip: 0 }, false],
    ['app.stagePicked', { source: 'zip', path: '/tmp/p.zip' }, false],
    ['security.request', { change: { kind: 'plugin.install', staged: 'stage-1', plugins: [{ id: 'search', digest: 'a'.repeat(64) }] } }, true],
    ['core.unstage', { staged: 'stage-1' }, true],
    ['core.unstage', {}, false],
  ])('checks %s with %j', (action, args, ok) => {
    expect(coreActions[action].args.safeParse(args).success).toBe(ok)
  })
})

describe('the bus\'s actions', () => {
  it('serves subscribe, unsubscribe and publish in events, with the two topics the core sends', () => {
    expect(Object.keys(eventActions)).toEqual(['events.subscribe', 'events.unsubscribe', 'events.publish'])
    expect(coreTopics).toEqual(['core.status', 'core.security', 'core.quitting'])
    expect(Object.isFrozen(eventActions) && Object.isFrozen(coreTopics)).toBe(true)
    expect(Object.getPrototypeOf(eventActions)).toBeNull()
    // Acknowledging is the ack message, never a call
    expect(eventActions['events.ack']).toBeUndefined()
  })

  it.each([
    ['events.subscribe', { topics: ['luoshu.changed'] }, true],
    ['events.subscribe', { topics: ['core.status', 'core.security'] }, true],
    ['events.subscribe', { topics: ['core.status', 'luoshu.changed'] }, true],
    ['events.subscribe', { topics: ['file-explorer.opened'] }, true],
    ['events.subscribe', { topics: Array.from({ length: MAX_CALL_TOPICS }, (_, i) => `p${i}.a`) }, true],
    ['events.subscribe', { topics: Array.from({ length: MAX_CALL_TOPICS + 1 }, (_, i) => `p${i}.a`) }, false],
    ['events.subscribe', { topics: [] }, false],
    ['events.subscribe', { topics: ['core.secret'] }, false],
    ['events.subscribe', { topics: ['events.dropped'] }, false],
    ['events.subscribe', { topics: ['events.ended'] }, false],
    ['events.subscribe', { topics: ['security.request'] }, false],
    ['events.subscribe', { topics: ['security.stop'] }, false],
    ['events.subscribe', { topics: ['ui.view'] }, false],
    ['events.subscribe', { topics: ['plugin.call'] }, false],
    ['events.subscribe', { topics: ['luoshu.*'] }, false],
    ['events.subscribe', { topics: ['luoshu'] }, false],
    ['events.subscribe', { topics: 'luoshu.changed' }, false],
    ['events.subscribe', { topics: ['luoshu.changed'], paths: ['**'] }, false],
    ['events.unsubscribe', { topics: ['luoshu.changed'] }, true],
    ['events.unsubscribe', { topics: ['events.dropped'] }, false],
    ['events.publish', { topic: 'search.indexed' }, true],
    ['events.publish', { topic: 'luoshu.changed', path: 'notes/a.md' }, true],
    // The floor refuses a topic no manifest can declare, which shape leaves to it
    ['events.publish', { topic: 'core.status' }, true],
    ['events.publish', { topic: 'luoshu.changed', path: '' }, false],
    ['events.publish', { topic: 'luoshu.changed', path: 'notes\\a.md' }, false],
    ['events.publish', { topic: 'luoshu.changed', path: 'notes/../a.md' }, false],
    ['events.publish', { topic: 'luoshu.changed', path: 'notes/a.md', text: 'the note' }, false],
    ['events.publish', { topic: 'luoshu.changed', path: 'notes/a.md', version: 3 }, false],
    ['events.publish', { topics: ['luoshu.changed'] }, false],
    ['events.publish', { topic: 'luoshu' }, false],
  ])('checks %s with %j', (action, args, ok) => {
    expect(eventActions[action].args.safeParse(args).success).toBe(ok)
  })
})

describe('the provider actions', () => {
  it('checks each against the capability it needs, the free ones against none', () => {
    expect(Object.fromEntries(Object.entries(providerActions).map(([action, spec]) => [action, spec.capability]))).toEqual({
      'luoshu.read': 'luoshu.read',
      'luoshu.write': 'luoshu.write',
      'luoshu.remove': 'luoshu.write',
      'luoshu.move': 'luoshu.write',
      // Free at the gate's decide step: the router keeps only the names the gate's canList allows
      'luoshu.list': null,
      'lock.set': 'lock.set',
      // A plugin clears only its own chain's locks, so it needs no grant
      'lock.clear': null,
      'lock.held': 'luoshu.read',
      'storage.get': null,
      'storage.set': null,
      'storage.delete': null,
      'cache.get': null,
      'cache.set': null,
      'cache.delete': null,
      'history.commit': 'history',
      'history.log': 'history',
      'history.read': 'history',
      'exec.run': 'exec',
    })
  })

  it('holds only what the router and the providers read, no row naming who outside the core may call it', () => {
    const fields = ['capability', 'args', 'scope', 'access', 'also', 'write', 'filter']
    for (const spec of Object.values(providerActions)) expect(Object.keys(spec).every(field => fields.includes(field))).toBe(true)
  })

  it('belongs only to provider namespaces', () => {
    for (const action of Object.keys(providerActions)) expect(Object.keys(providers)).toContain(namespace(action))
  })

  it('keeps writes one audit record each and the guardable action among them', () => {
    const writes = Object.entries(providerActions).filter(([, spec]) => spec.write).map(([action]) => action)
    expect(writes).toEqual([
      'luoshu.write', 'luoshu.remove', 'luoshu.move', 'lock.set', 'lock.clear', 'storage.set', 'storage.delete', 'cache.set', 'cache.delete',
      'history.commit', 'exec.run',
    ])
    for (const action of guardableActions) expect(providerActions[action].write).toBe(true)
  })

  it('filters only a listing, a page of at most 1,000 names, by what the caller may list', () => {
    expect(Object.entries(providerActions).filter(([, spec]) => 'filter' in spec).map(([action, spec]) => [action, (spec as { filter: string }).filter]))
      .toEqual([['luoshu.list', 'list']])
    expect(providerActions['luoshu.list'].scope).toBeNull()
    expect(providerActions['luoshu.list'].write).toBe(false)
    expect(LIST_PAGE).toBe(1000)
  })

  it('takes the raw scope from the argument it names', () => {
    expect(providerActions['luoshu.read'].scope).toBe('path')
    expect(providerActions['lock.set'].scope).toBe('paths')
    expect(providerActions['lock.held'].scope).toBe('paths')
    expect(providerActions['lock.clear'].scope).toBeNull()
    expect(providerActions['history.commit'].scope).toBe('paths')
    expect(providerActions['exec.run'].scope).toBe('command')
    expect(providerActions['luoshu.remove'].scope).toBe('path')
    expect(providerActions['luoshu.move'].scope).toBe('ends')
  })

  it('asks a second requirement of a move alone: read on the end it leaves', () => {
    const second = Object.entries(providerActions).filter(([, spec]) => spec.also !== undefined).map(([action, spec]) => [action, spec.also])
    expect(second).toEqual([['luoshu.move', { capability: 'luoshu.read', ends: ['from'] }]])
  })

  it.each([
    ['luoshu.read', { path: 'notes/a.md' }, true],
    ['luoshu.read', { path: '' }, false],
    ['luoshu.read', { path: 'a'.repeat(513) }, false],
    ['luoshu.read', { path: 'a.md', follow: true }, false],
    // Spellings no canonical path holds, refused at shape. A trailing dot and a device name are the canonicaliser's
    ['luoshu.read', { path: 'notes\\a.md' }, false],
    ['luoshu.read', { path: 'notes/a:b.md' }, false],
    ['luoshu.read', { path: `notes/a${String.fromCharCode(7)}.md` }, false],
    ['luoshu.read', { path: 'notes//a.md' }, false],
    ['luoshu.read', { path: 'notes/./a.md' }, false],
    ['luoshu.read', { path: 'notes/../a.md' }, false],
    ['luoshu.read', { path: '/notes/a.md' }, false],
    ['luoshu.read', { path: 'C:/notes/a.md' }, false],
    ['luoshu.read', { path: `notes/${String.fromCharCode(0xd800)}.md` }, false],
    ['luoshu.read', { path: 'notes/a.md.' }, true],
    ['luoshu.read', { path: 'notes/con' }, true],
    ['luoshu.write', { path: 'a.md', text: 'x' }, true],
    ['luoshu.write', { path: 'a.md', text: 'x', baseVersion: 'f'.repeat(64) }, true],
    ['luoshu.write', { path: 'a.md', text: 'x', baseVersion: 'F'.repeat(64) }, false],
    ['luoshu.write', { path: 'a.md' }, false],
    ['luoshu.write', { path: 'a.md', text: 42 }, false],
    ['luoshu.write', { path: 'notes\\a.md', text: 'x' }, false],
    ['luoshu.remove', { path: 'a.md' }, false],
    ['luoshu.remove', { path: 'a.md', baseVersion: 'f'.repeat(64) }, true],
    ['luoshu.remove', { path: 'a.md', baseVersion: 'F'.repeat(64) }, false],
    ['luoshu.remove', { path: 'notes\\a.md' }, false],
    ['luoshu.remove', { path: 'a.md', text: 'x' }, false],
    ['luoshu.move', { from: 'a.md', to: 'b/a.md' }, true],
    ['luoshu.move', { from: 'a.md' }, false],
    ['luoshu.move', { from: 'a.md', to: '../a.md' }, false],
    ['luoshu.move', { from: 'notes/../a.md', to: 'a.md' }, false],
    ['luoshu.move', { from: 'a.md', to: 'b.md', overwrite: true }, false],
    ['luoshu.move', { from: 'a.md', to: 'b.md', baseVersion: 'f'.repeat(64) }, false],
    ['luoshu.list', {}, true],
    ['luoshu.list', undefined, false],
    ['luoshu.list', { folder: 'notes' }, true],
    ['luoshu.list', { folder: 'notes', after: 'notes/a.md' }, true],
    ['luoshu.list', { folder: 'notes\\b' }, false],
    ['luoshu.list', { after: '../a.md' }, false],
    ['luoshu.list', { page: 2 }, false],
    ['lock.set', { paths: ['a.md'], ms: 600000 }, true],
    // Over the cap is the module's to clamp
    ['lock.set', { paths: ['a.md'], ms: Number.MAX_SAFE_INTEGER }, true],
    ['lock.set', { paths: ['a.md'] }, false],
    ['lock.set', { paths: ['a.md'], ms: 0 }, false],
    ['lock.set', { paths: ['a.md'], ms: 1.5 }, false],
    ['lock.set', { paths: [], ms: 1000 }, false],
    ['lock.set', { paths: Array.from({ length: MAX_LOCK_PATHS + 1 }, (_, i) => `${i}.md`), ms: 1000 }, false],
    ['lock.set', { paths: ['notes/a.md', 'notes\\b.md'], ms: 1000 }, false],
    // The holder is the caller's own chain, never one the arguments name
    ['lock.set', { paths: ['a.md'], ms: 1000, holder: 'claude-code#1' }, false],
    ['lock.clear', { paths: ['a.md'] }, true],
    ['lock.clear', { paths: [] }, false],
    ['lock.clear', { paths: ['a.md'], holder: 'claude-code#1' }, false],
    ['lock.held', { paths: ['a.md', 'b/c.md'] }, true],
    ['lock.held', { paths: Array.from({ length: MAX_LOCK_PATHS + 1 }, (_, i) => `${i}.md`) }, false],
    ['lock.held', undefined, false],
    ['storage.get', { key: 'index' }, true],
    ['storage.get', { key: '../search/index' }, false],
    ['storage.set', { key: 'index', value: { a: [1] } }, true],
    ['storage.set', { key: '../search/index', value: 1 }, false],
    ['cache.set', { key: 'a/b', value: 1 }, false],
    ['storage.get', { key: 'index', plugin: 'search' }, false],
  ])('checks %s with %j', (action, args, ok) => {
    expect(providerActions[action].args.safeParse(args).success).toBe(ok)
  })
})

// A role is an action the core names and one plugin serves, the plugin holding the role's item. The floor decides who
// may call it, as for a core action
describe('the role actions', () => {
  it('names door.handle alone, called by a utility half and served by the plugin holding door.handle', () => {
    expect(Object.fromEntries(Object.entries(roleActions).map(([action, spec]) => [action, [spec.from, spec.capability]]))).toEqual({
      'door.handle': ['door', 'door.handle'],
    })
    for (const action of Object.keys(roleActions)) expect(serverOf(namespace(action))?.route).toBe('role')
    // Each call names the label it is made for, so what the holder does under it is judged for that pair
    expect(roleActions['door.handle'].onBehalf).toBe(true)
  })

  it('is frozen with no prototype', () => {
    expect(Object.isFrozen(roleActions)).toBe(true)
    expect(Object.isFrozen(roleActions['door.handle'])).toBe(true)
    expect(Object.getPrototypeOf(roleActions)).toBeNull()
    expect(roleActions['toString']).toBeUndefined()
  })

  const headers = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`mcp-h${i}`, 'v']))
  it.each([
    ['a body and a header', { body: '{"jsonrpc":"2.0"}', headers: { 'mcp-session-id': 'a' } }, true],
    ['an empty body and no header', { body: '', headers: {} }, true],
    ['the most headers', { body: 'x', headers: headers(MAX_LIST) }, true],
    ['one header past the most', { body: 'x', headers: headers(MAX_LIST + 1) }, false],
    ['no headers', { body: 'x' }, false],
    ['no body', { headers: {} }, false],
    ['a body that is no text', { body: 1, headers: {} }, false],
    ['a header value that is no text', { body: 'x', headers: { 'mcp-a': 1 } }, false],
    ['an onBehalf among the arguments', { body: 'x', headers: {}, onBehalf: 'claude-code#1' }, false],
    ['nothing', undefined, false],
  ])('checks door.handle with %s', (_name, args, ok) => {
    expect(roleActions['door.handle'].args.safeParse(args).success).toBe(ok)
  })
})

describe('the envelope beside a request', () => {
  const call = { v: 1, kind: 'call', id: 1, action: 'luoshu.read', args: { path: 'a.md' } }

  it('leaves args to the router, which measures them against the caller\'s own cap', () => {
    const big = { ...call, args: 'x'.repeat(MiB + 1) }
    expect(request.safeParse(big).success).toBe(false)
    expect(callEnvelope.safeParse(big).success).toBe(true)
  })

  it('refuses in the envelope what the request refuses outside args', () => {
    for (const bad of [{ ...call, v: 2 }, { ...call, caller: { kind: 'window', role: 'trusted', n: 0 } }, { ...call, id: -1 }, { ...call, action: 'read' }]) {
      expect(callEnvelope.safeParse(bad).success).toBe(false)
    }
  })

  it('shapes a delivery with the caller and no parent', () => {
    const delivered = { v: 1, kind: 'call', callId: 'c1', caller: { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 }, action: 'mcp.handle', args: {}, deadline: 1 }
    expect(delivery.safeParse(delivered).success).toBe(true)
    expect(delivery.safeParse({ ...delivered, onBehalf: 'agent-a' }).success).toBe(false)
    expect(delivery.safeParse({ ...delivered, onBehalf: 'agent-a', root: delivered.caller }).success).toBe(true)
    expect(delivery.safeParse({ ...delivered, parent: 'p1' }).success).toBe(false)
    expect(delivery.safeParse({ ...delivered, caller: { kind: 'agent' } }).success).toBe(false)
    expect(delivery.safeParse({ ...delivered, deadline: 1.5 }).success).toBe(false)
  })

  it('hands the root caller beside onBehalf only, so a callee reads whose field it is', () => {
    const delivered = { v: 1, kind: 'call', callId: 'c1', caller: { kind: 'plugin', id: 'mcp', half: 'worker', incarnation: 1 }, action: 'search.query', args: {}, deadline: 1 }
    const root = { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 2 }
    expect(delivery.safeParse({ ...delivered, onBehalf: 'client#1', root }).success).toBe(true)
    expect(delivery.safeParse({ ...delivered, onBehalf: 'client#1', root: { kind: 'window', role: 'editor', n: 3 } }).success).toBe(true)
    expect(delivery.safeParse({ ...delivered, root }).success).toBe(false)
    expect(delivery.safeParse({ ...delivered, onBehalf: 'client#1', root: { kind: 'plugin', id: 'mcp-http-handler' } }).success).toBe(false)
    expect(delivery.safeParse({ ...delivered, onBehalf: 'client#1', root: 'mcp-http-handler' }).success).toBe(false)
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
    // Past the cap on an array's policy jobs and on a key, before any value is walked
    expect(measurePlain(new Array(10), 50)).toMatchObject({ ok: false, tooLarge: true })
    expect(measurePlain({ ['k'.repeat(60)]: 1 }, 50)).toMatchObject({ ok: false, tooLarge: true })
  })
})

describe('the state lists', () => {
  it('has the five policy job states and the plugin lifecycle states', () => {
    expect(policyJobStates).toEqual(['on', 'off', 'starting', 'failed', 'absent'])
    expect(pluginStates).toEqual(['found', 'refused', 'waiting', 'off', 'starting', 'ready', 'unresponsive', 'stopping', 'stopped', 'crashed', 'failed'])
    expect(Object.isFrozen(policyJobStates) && Object.isFrozen(pluginStates)).toBe(true)
  })
})

// Each core action sits in the namespace of the part that serves it: the gate module's own, the runtime's app.* and
// editor.frame, recording's log.* and the plugins manager's core.* and security.*
describe('the core actions by their server', () => {
  it('names the gate module\'s and the runtime\'s actions in their own namespaces', () => {
    for (const action of ['gate.filterReadable', 'gate.reach', 'app.quit', 'app.relaunch', 'app.pickFolder', 'app.openSecurity']) {
      expect(coreActions[action], action).toBeDefined()
    }
    for (const action of ['core.filterReadable', 'editor.reach', 'core.quit', 'core.relaunch', 'core.pickFolder', 'security.open']) {
      expect(coreActions[action], action).toBeUndefined()
    }
    expect(coreNamespaces).toEqual(expect.arrayContaining(['gate', 'app']))
  })
})
