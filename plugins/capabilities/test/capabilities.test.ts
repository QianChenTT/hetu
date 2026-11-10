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
