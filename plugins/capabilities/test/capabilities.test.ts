import { describe, expect, it } from 'vitest'
import type { Capability } from 'hetu-core/api/capabilities.ts'
import { createCapabilities } from '../src/capabilities.ts'

const caps = createCapabilities()
const read: Capability = { type: 'luoshu.read', paths: ['notes/**'] }
const list: Capability = { type: 'luoshu.list', paths: ['**'] }
const write: Capability = { type: 'luoshu.write', paths: ['04 - Daily/**'] }
const writeAll: Capability = { type: 'luoshu.write', paths: ['**'] }
const fetchOne: Capability = { type: 'net.fetch', hosts: ['example.com'] }
const fetchAll: Capability = { type: 'net.fetch', hosts: ['*'] }
const call: Capability = { type: 'plugin.call', targets: ['sync'] }

describe('the class of one grant', () => {
  it.each([
    ['ui.panel', { type: 'ui.panel' }, 0],
    ['ui.decoration', { type: 'ui.decoration' }, 0],
    ['ui.command', { type: 'ui.command' }, 0],
    ['ui.statusBar', { type: 'ui.statusBar' }, 0],
    ['storage', { type: 'storage' }, 0],
    ['events.subscribe', { type: 'events.subscribe', topics: ['luoshu.changed'] }, 0],
    ['plugin.call on its own', call, 0],
    ['ui.keys, the key stream', { type: 'ui.keys' }, 1],
    ['luoshu.read', read, 1],
    ['luoshu.list', list, 1],
    ['a scoped luoshu.write', write, 2],
    ['history read', { type: 'history', access: 'read', paths: ['**'] }, 2],
    ['history commit', { type: 'history', access: 'commit', paths: ['notes/**'] }, 2],
    ['net.fetch to listed hosts', fetchOne, 3],
    ['net.fetch to every host', fetchAll, 4],
    ['luoshu.write on every note', writeAll, 4],
    ['luoshu.write on every folder’s notes', { type: 'luoshu.write', paths: ['**/*.md'] }, 4],
    ['exec', { type: 'exec', commands: [['git', 'status']], env: [] }, 4],
    ['guard.hook', { type: 'guard.hook' }, 4],
    ['log.read', { type: 'log.read' }, 4],
  ] as [string, Capability, number][])('counts %s as class %i', (_name, granted, expected) => {
    expect(caps.classify([granted], [])).toBe(expected)
  })

  it('counts nothing asked for as class 0', () => {
    expect(caps.classify([], [])).toBe(0)
  })
})

describe('a plugin\'s class', () => {
  it('is the highest of its grants', () => {
    expect(caps.classify([{ type: 'storage' }, read, write], [])).toBe(2)
  })

  it('takes in what it reaches through plugin.call', () => {
    expect(caps.classify([call], [write])).toBe(2)
    expect(caps.classify([call], [{ type: 'exec', commands: [['ls']], env: [] }])).toBe(4)
  })

  it.each([
    ['luoshu.read', [read, fetchOne], []],
    ['luoshu.list', [list, fetchOne], []],
    ['ui.keys', [{ type: 'ui.keys' }, fetchOne], []],
    ['history read', [{ type: 'history', access: 'read', paths: ['**'] }, fetchOne], []],
    ['reading here and network reached', [read, call], [fetchOne]],
    ['network here and reading reached', [fetchOne, call], [list]],
  ] as [string, Capability[], Capability[]][])('is 4 for %s with network, which can send notes out', (_name, granted, reachable) => {
    expect(caps.classify(granted, reachable)).toBe(4)
  })

  it('stays 3 for network beside a write or a commit, which read nothing', () => {
    expect(caps.classify([write, fetchOne], [])).toBe(3)
    expect(caps.classify([{ type: 'history', access: 'commit', paths: ['**'] }, fetchOne], [])).toBe(3)
  })
})

describe('the items that ask at first use', () => {
  it('are none for a plugin below class 4', () => {
    expect(caps.firstUse([read, write, { type: 'storage' }], [])).toEqual([])
    expect(caps.firstUse([write, fetchOne], [])).toEqual([])
  })

  it('are the items whose own class is 4', () => {
    const exec: Capability = { type: 'exec', commands: [['git', 'log']], env: [] }
    expect(caps.firstUse([read, exec, writeAll, { type: 'storage' }], [])).toEqual([exec, writeAll])
  })

  it('are the network items that close a read plus network pair', () => {
    expect(caps.firstUse([read, fetchOne], [])).toEqual([fetchOne])
    expect(caps.firstUse([fetchOne, call], [list])).toEqual([fetchOne])
  })

  it('are the plugin.call items that bring the network in, for a plugin with none of its own', () => {
    expect(caps.firstUse([read, call], [fetchOne])).toEqual([call])
  })
})

describe('the screen under the core\'s words', () => {
  it('names the class and what the plugin reaches through plugin.call', () => {
    expect(caps.screen({ granted: [call], reachable: [write], callers: [] })).toEqual([
      'Class 2, Writer',
      'Through plugin.call it reaches: luoshu.write on "04 - Daily/**"',
    ])
  })

  it('names the plugins that read and can reach a plugin with network, and none for a plugin without', () => {
    const callers = [{ id: 'notes-ai', granted: [read] }, { id: 'calc', granted: [{ type: 'storage' } as Capability] }, { id: 'search', granted: [list] }]
    expect(caps.screen({ granted: [fetchOne], reachable: [], callers })).toEqual([
      'Class 3, Network',
      'Plugins that read and can reach it: notes-ai, search',
    ])
    expect(caps.screen({ granted: [write], reachable: [], callers })).toEqual(['Class 2, Writer'])
  })

  it('names class 4 by what makes it so', () => {
    expect(caps.screen({ granted: [read, fetchOne], reachable: [], callers: [] })).toEqual([
      'Class 4, Powerful: it can read notes and reach the network, so it could send notes out',
    ])
  })
})
