import { describe, expect, it } from 'vitest'
import type { Capability } from 'hetu-core/api/capabilities.ts'
import type { Flow } from 'hetu-core/api/slots.ts'
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
    ['ui.view', { type: 'ui.view' }, 0],
    ['ui.decoration', { type: 'ui.decoration' }, 0],
    ['ui.command', { type: 'ui.command' }, 0],
    ['ui.layout', { type: 'ui.layout' }, 0],
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
    ['luoshu.write on every note spelled without **', { type: 'luoshu.write', paths: ['*', '*/**'] }, 4],
    ['luoshu.write on a wildcard top folder', { type: 'luoshu.write', paths: ['*/journal/**'] }, 4],
    ['luoshu.write on two named folders', { type: 'luoshu.write', paths: ['notes/**', '04 - Daily/**'] }, 2],
    ['luoshu.write on one named note', { type: 'luoshu.write', paths: ['inbox.md'] }, 2],
    // The human sees each edit and saves it, so ui.edit stays a scoped writer on every note too
    ['ui.edit on a named folder', { type: 'ui.edit', paths: ['notes/**'] }, 2],
    ['ui.edit on every note', { type: 'ui.edit', paths: ['**'] }, 2],
    // It reads what the human opened, so it is a reader
    ['ui.read on every note', { type: 'ui.read', paths: ['**'] }, 1],
    ['exec', { type: 'exec', commands: [['git', 'status']], env: [] }, 4],
    ['guard.hook', { type: 'guard.hook' }, 4],
    ['log.read', { type: 'log.read' }, 4],
  ] as [string, Capability, number][])('counts %s at the class the table gives', (_name, granted, expected) => {
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
    ['ui.read', [{ type: 'ui.read', paths: ['**'] }, fetchOne], []],
    ['ui.read here and network reached', [{ type: 'ui.read', paths: ['**'] }, call], [fetchOne]],
    ['history read', [{ type: 'history', access: 'read', paths: ['**'] }, fetchOne], []],
    ['reading here and network reached', [read, call], [fetchOne]],
    ['network here and reading reached', [fetchOne, call], [list]],
    ['a write, whose version check tests a guess at a note', [write, fetchOne], []],
  ] as [string, Capability[], Capability[]][])('is 4 for %s with network, which can send notes out', (_name, granted, reachable) => {
    expect(caps.classify(granted, reachable)).toBe(4)
  })

  it('stays 3 for network beside a commit, which reads nothing', () => {
    expect(caps.classify([{ type: 'history', access: 'commit', paths: ['**'] }, fetchOne], [])).toBe(3)
  })

  // An edit is served only beside a read, which the pair rule counts
  it('stays 3 for network beside ui.edit, which reads nothing, and asks at no first use of it', () => {
    const edits: Capability = { type: 'ui.edit', paths: ['**'] }
    expect(caps.classify([edits, fetchOne], [])).toBe(3)
    expect(caps.classify([call], [edits, fetchOne])).toBe(3)
    expect(caps.firstUse([edits], [])).toEqual([])
    expect(caps.screen({ granted: [edits], reachable: [], callers: [] })).toEqual(['Class 2, Writer'])
  })

  it('counts a type it doesn’t know as 4, so nothing new is ever class 0 by default', () => {
    expect(caps.classify([{ type: 'net.listen' } as unknown as Capability], [])).toBe(4)
    expect(caps.firstUse([{ type: 'net.listen' } as unknown as Capability], [])).toEqual([{ type: 'net.listen' }])
  })
})

describe('the items that ask at first use', () => {
  it('are none for a plugin below class 4', () => {
    expect(caps.firstUse([read, write, { type: 'storage' }], [])).toEqual([])
    expect(caps.firstUse([{ type: 'history', access: 'commit', paths: ['**'] }, fetchOne], [])).toEqual([])
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

// Data moves along plugin.call both ways and along a subscription from the plugin that owns the topic to the one that
// hears it. The loader hands what lies upstream and downstream that way, and the class reached stays plugin.call's
describe('the pair rule over where data moves', () => {
  const hears: Capability = { type: 'events.subscribe', topics: ['notes.done'] }
  const hearsMore: Capability = { type: 'events.subscribe', topics: ['luoshu.changed'] }
  const flow = (part: Partial<Flow>): Flow => ({ upstream: [], downstream: [], heard: [], ...part })
  const reader = { id: 'notes', granted: [read] }
  const sender = { id: 'sync', granted: [fetchOne] }

  it('is 4 for a read upstream and network here, and for a read here and network downstream', () => {
    expect(caps.classify([fetchOne, hears], [], flow({ upstream: [reader] }))).toBe(4)
    expect(caps.classify([read], [], flow({ downstream: [sender] }))).toBe(4)
    expect(caps.classify([hears], [], flow({ upstream: [reader], downstream: [sender] }))).toBe(4)
  })

  it('keeps each plugin\'s own class for network upstream and a read downstream, which carries nothing out', () => {
    expect(caps.classify([read, hears], [], flow({ upstream: [sender] }))).toBe(1)
    expect(caps.classify([fetchOne], [], flow({ downstream: [reader] }))).toBe(3)
  })

  it('takes no class from what lies upstream or downstream, only from what plugin.call reaches', () => {
    const writer = { id: 'writer', granted: [writeAll] }
    expect(caps.classify([{ type: 'ui.view' }, hears], [], flow({ upstream: [writer], downstream: [writer] }))).toBe(0)
  })

  it('asks at the subscriptions that bring a read in, beside the network items, for a plugin reading nothing itself', () => {
    const heard = [{ item: hears, upstream: [read] }, { item: hearsMore, upstream: [] }]
    expect(caps.firstUse([fetchOne, hears, hearsMore], [], flow({ upstream: [reader], heard }))).toEqual([fetchOne, hears])
    expect(caps.firstUse([hears], [], flow({ upstream: [reader], downstream: [sender], heard }))).toEqual([hears])
  })

  it('asks at no subscription for a plugin that reads itself, nor for one that isn\'t paired', () => {
    const heard = [{ item: hears, upstream: [list] }]
    expect(caps.firstUse([read, fetchOne, hears], [], flow({ upstream: [reader], heard }))).toEqual([fetchOne])
    expect(caps.firstUse([hears], [], flow({ upstream: [reader], heard }))).toEqual([])
  })

  it('names the readers upstream of a plugin with network and the network plugins downstream of one that reads', () => {
    expect(caps.screen({ granted: [fetchOne, hears], reachable: [], callers: [], flow: flow({ upstream: [reader] }) })).toEqual([
      'Class 4, Powerful: it can read notes and reach the network, so it could send notes out',
      'Plugins that read and can reach it through events: notes',
    ])
    expect(caps.screen({ granted: [read], reachable: [], callers: [], flow: flow({ downstream: [sender] }) })).toEqual([
      'Class 4, Powerful: it can read notes and reach the network, so it could send notes out',
      'Plugins with network it can reach through events: sync',
    ])
    expect(caps.screen({ granted: [read, hears], reachable: [], callers: [], flow: flow({ upstream: [sender] }) })).toEqual(['Class 1, Reader'])
  })

  it('names in those lines no plugin plugin.call already connects', () => {
    const callers = [reader]
    expect(caps.screen({ granted: [fetchOne, call], reachable: [read], callers, flow: flow({ upstream: [reader], downstream: [reader] }) })).toEqual([
      'Class 4, Powerful: it can read notes and reach the network, so it could send notes out',
      'Through plugin.call it is connected to: luoshu.read on "notes/**"',
      'Plugins that read and are connected to it through plugin.call: notes',
    ])
  })
})

describe('the screen under the core\'s words', () => {
  it('names the class and what the plugin reaches through plugin.call', () => {
    expect(caps.screen({ granted: [call], reachable: [write], callers: [] })).toEqual([
      'Class 2, Writer',
      'Through plugin.call it is connected to: luoshu.write on "04 - Daily/**"',
    ])
  })

  it('names the plugins that read and can reach a plugin with network, and none for a plugin without', () => {
    const callers = [{ id: 'notes-ai', granted: [read] }, { id: 'calc', granted: [{ type: 'storage' } as Capability] }, { id: 'search', granted: [list] }]
    expect(caps.screen({ granted: [fetchOne], reachable: [], callers })).toEqual([
      'Class 3, Network',
      'Plugins that read and are connected to it through plugin.call: notes-ai, search',
    ])
    expect(caps.screen({ granted: [write], reachable: [], callers })).toEqual(['Class 2, Writer'])
  })

  it('names class 4 by what makes it so', () => {
    expect(caps.screen({ granted: [read, fetchOne], reachable: [], callers: [] })).toEqual([
      'Class 4, Powerful: it can read notes and reach the network, so it could send notes out',
    ])
  })
})

describe('the screen\'s line on programs that run other programs', () => {
  const exec = (...commands: string[][]): Capability => ({ type: 'exec', commands, env: [] })
  const line = (...programs: string[]) => `It can run programs that run other programs or code: ${programs.join(', ')}`

  it('names each such program in an exec item by its base name, once, in the order first seen', () => {
    const granted = [exec(['C:\\Program Files\\Git\\cmd\\git.exe', 'status'], ['/usr/bin/python3.12', '-V']), exec(['git', 'log'], ['NODE', '-v'])]
    const lines = caps.screen({ granted, reachable: [], callers: [] })
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(line('git', 'python', 'node'))
  })

  it.each([
    'bash', 'sh', 'zsh', 'cmd.exe', 'powershell.exe', 'pwsh', 'npm.cmd', 'npx', 'curl', 'wget', 'perl', 'ruby', 'deno', 'bun',
    'py', 'wsl', 'ssh', 'env', 'xargs', 'cscript', 'wscript', 'mshta', 'rundll32', 'java',
    'pythonw.exe', 'javaw', 'msbuild', 'forfiles', 'wmic', 'schtasks', 'docker', 'awk', 'tar', 'busybox', 'nohup', 'timeout', 'gawk', 'sed',
  ])('counts %s', program => {
    expect(caps.screen({ granted: [exec([program, 'x'])], reachable: [], callers: [] })).toContain(line(program.replace(/\.\w+$/, '').toLowerCase()))
  })

  it('adds no line for programs that run nothing else, nor for a name that only contains one', () => {
    const lines = caps.screen({ granted: [exec(['pandoc', 'a.md'], ['/opt/gitk-viewer', 'x'], ['nodemon-like', 'y'])], reachable: [], callers: [] })
    expect(lines).toHaveLength(1)
  })

  it('names a program reached through plugin.call too', () => {
    const lines = caps.screen({ granted: [call], reachable: [exec(['bash', '-c', 'x'])], callers: [] })
    expect(lines.at(-1)).toBe(line('bash'))
  })
})

// The loader hands every plugin a change moves to another class, with the class stored and the one the change gives
describe('the classes a change moves', () => {
  it('shows each move up by the plugin with both classes, into 4 and below it', () => {
    expect(caps.moves!([
      { id: 'sync', from: 3, to: 4 },
      { id: 'calc', from: 0, to: 2 },
      { id: 'notes', from: 1, to: 3 },
    ])).toEqual([
      'Raises sync from class 3, Network to class 4, Powerful',
      'Raises calc from class 0, Contained to class 2, Writer',
      'Raises notes from class 1, Reader to class 3, Network',
    ])
  })

  it('shows no move down', () => {
    expect(caps.moves!([{ id: 'sync', from: 4, to: 3 }, { id: 'calc', from: 2, to: 0 }])).toEqual([])
  })

  it('counts a class not known as 4, so a move from one is never up and a move to one is', () => {
    expect(caps.moves!([{ id: 'sync', from: null, to: 4 }, { id: 'calc', from: null, to: 1 }])).toEqual([])
    expect(caps.moves!([{ id: 'sync', from: 3, to: null }])).toEqual(['Raises sync from class 3, Network to a class not known, counted as 4'])
  })
})
