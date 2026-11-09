import { describe, expect, it } from 'vitest'
import { capabilities, capability, isInstallOnly } from '../api/capabilities.ts'
import { change } from '../api/changes.ts'
import { windowRoles } from '../api/envelope.ts'
import { floorConstantNames, floorConstants } from '../api/floor.ts'
import { scopeMatches } from '../api/scope.ts'
import { windowGrants } from '../api/windows.ts'

const MiB = 1024 * 1024

// Section 3: the core decides with null-prototype tables, so a prototype bug in a host half can't flip a decision
describe.each([['window grants', windowGrants], ['floor constants', floorConstants]])('the %s table', (_name, table) => {
  it('has no prototype, so a key named like a member of Object finds nothing', () => {
    expect(Object.getPrototypeOf(table)).toBeNull()
    expect((table as Record<string, unknown>).constructor).toBeUndefined()
    expect('hasOwnProperty' in table).toBe(false)
  })

  it('finds nothing a slip added to Object.prototype', () => {
    const shared = Object.prototype as Record<string, unknown>
    shared.agent = [{ type: 'exec', commands: [['sh']], env: [] }]
    shared.maxPlugins = 1e9
    try {
      expect((table as Record<string, unknown>).agent).toBeUndefined()
      expect((table as Record<string, unknown>).maxPlugins).toBeUndefined()
    } finally {
      delete shared.agent
      delete shared.maxPlugins
    }
  })
})

describe('window grants', () => {
  it('has an entry for each window and no other', () => {
    expect(Object.keys(windowGrants).sort()).toEqual([...windowRoles].sort())
  })

  it.each(windowRoles)('holds only capabilities the list knows for the %s window', role => {
    for (const granted of windowGrants[role]) expect(capability.safeParse(granted).success).toBe(true)
    expect(capabilities.safeParse([...windowGrants[role]]).success).toBe(true)
  })

  it('gives the editor the luoshu, history, luoshu events, the ui verbs and its own storage', () => {
    expect(windowGrants.editor).toEqual([
      { type: 'luoshu.read', paths: ['**'] },
      { type: 'luoshu.write', paths: ['**'] },
      { type: 'history', access: 'read', paths: ['**'] },
      { type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] },
      { type: 'ui.panel' },
      { type: 'ui.decoration' },
      { type: 'ui.command' },
      { type: 'ui.statusBar' },
      { type: 'ui.keys' },
      { type: 'storage' },
    ])
  })

  it('never gives a window exec, the network, plugin calls or an install-only type', () => {
    for (const role of windowRoles) {
      for (const granted of windowGrants[role]) {
        expect(['exec', 'net.fetch', 'plugin.call']).not.toContain(granted.type)
        expect(isInstallOnly(granted.type)).toBe(false)
      }
    }
  })

  it('gives the trusted window no capability, it calls core actions only', () => {
    expect(windowGrants.trusted).toEqual([])
  })

  // ** never reaches a dot segment, so the editor stops at dot files and folders. Reaching one or two dot segments deep
  // would take **/.*/** and **/.*/**/.*/** beside **
  it('stops the editor at dot files and dot folders', () => {
    const scopes = (type: string) => windowGrants.editor.flatMap(granted => granted.type === type && 'paths' in granted ? granted.paths : [])
    const reaches = (type: string, path: string) => scopes(type).some(grant => scopeMatches(grant, path, { foldCase: false }))
    for (const type of ['luoshu.read', 'luoshu.write', 'history']) {
      expect(reaches(type, 'notes/a.md')).toBe(true)
      for (const path of ['.scratch.md', 'notes/.todo.md', '.trash/a.md', 'notes/.trash/a.md', '.obsidian/app.json']) {
        expect(reaches(type, path)).toBe(false)
      }
    }
  })

  it('is frozen to the last scope', () => {
    expect(() => (windowGrants.trusted as unknown[]).push({ type: 'exec' })).toThrow()
    expect(() => (windowGrants.editor as unknown[]).push({ type: 'exec' })).toThrow()
    const read = windowGrants.editor[0] as { paths: string[] }
    expect(() => read.paths.push('.git/**')).toThrow()
    expect(() => { (windowGrants.editor[1] as { type: string }).type = 'exec' }).toThrow()
  })
})

describe('floor constants', () => {
  it("holds the starting values", () => {
    expect(floorConstants).toEqual({
      messagesPerSecond: 1000,
      bytesPerSecond: 4 * MiB,
      callsInFlight: 64,
      bytesInFlight: 32 * MiB,
      argumentBytes: MiB,
      resultBytes: 16 * MiB,
      callDeadlineMs: 30000,
      guardAnswerMs: 2000,
      parentDepth: 4,
      readyMs: 10000,
      stopGraceMs: 3000,
      heartbeatMs: 5000,
      heartbeatMisses: 3,
      eventCredits: 256,
      topicsPerHalf: 64,
      filterMsPerSecond: 100,
      auditQueue: 10000,
      logFailMs: 30000,
      floorBacklog: 1000,
      floodFactor: 10,
      floodMs: 5000,
      firstUseAsks: 1,
    })
  })

  it('names every constant limit.set may change', () => {
    expect(floorConstantNames).toEqual(Object.keys(floorConstants))
    for (const constant of floorConstantNames) {
      expect(change.safeParse({ kind: 'limit.set', constant, value: floorConstants[constant], plugin: null }).success).toBe(true)
    }
  })

  it('holds only positive whole numbers, which limit.set can set again', () => {
    for (const value of Object.values(floorConstants)) {
      expect(Number.isSafeInteger(value) && value > 0).toBe(true)
    }
  })

  it('is frozen', () => {
    expect(() => { (floorConstants as Record<string, number>).callsInFlight = 1e9 }).toThrow()
    expect(() => (floorConstantNames as string[]).push('everything')).toThrow()
  })
})
