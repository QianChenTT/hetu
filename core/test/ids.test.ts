import { describe, expect, it } from 'vitest'
import {
  coreNamespaces, firstPartyIds, guardableActions, guards, installIds, isReservedId, localName, MAX_ID_LENGTH,
  MAX_NAME_LENGTH, pluginId, providers, qualifiedName, reservedIds, slotIds,
} from '../api/ids.ts'
import { plainProblem } from '../api/plain.ts'

describe('plugin ids', () => {
  it.each(['search', 'file-explorer', 'my_plugin', 'a1', '1a', 'hidden-marks', 'a-b_c', 'x'.repeat(MAX_ID_LENGTH)])('takes %j', id => {
    expect(pluginId.safeParse(id).success).toBe(true)
  })

  // A dot would let <id>.<name> split two ways, so plugin ids lost the dot
  it.each(['my.plugin', 'a.b', 'search.', '.search', 'a..b'])('refuses %j, which holds a dot', id => {
    expect(pluginId.safeParse(id).success).toBe(false)
  })

  it.each(['con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com9', 'lpt0', 'lpt1', 'lpt9'])('refuses the Windows device name %j', id => {
    expect(pluginId.safeParse(id).success).toBe(false)
  })

  it.each(['console', 'com10', 'lpt', 'auxiliary', 'x-con', 'nul-x', 'con_1'])('takes %j, which only looks like a device name', id => {
    expect(pluginId.safeParse(id).success).toBe(true)
  })

  it.each([
    '', 'Search', 'a b', '-a', '_a', 'a-', 'a_', 'a--b', 'a/b', 'a\\b', '../evil', 'evil\0', 'été', 'x'.repeat(MAX_ID_LENGTH + 1),
  ])('refuses %j', id => {
    expect(pluginId.safeParse(id).success).toBe(false)
  })

  // Plain data refuses both as keys, so a map keyed by plugin id would refuse such a plugin
  it.each(['constructor', 'prototype'])('refuses %j, a key plain data refuses', id => {
    expect(plainProblem({ [id]: 1 }, 1024)).toBe(`the key ${id}`)
    expect(pluginId.safeParse(id).success).toBe(false)
  })

  it('takes no id that names a member of Object, so a plain object keyed by plugin id finds only its own entries', () => {
    const members = Object.getOwnPropertyNames(Object.prototype)
    expect(members).toContain('constructor')
    expect(members.filter(member => pluginId.safeParse(member).success)).toEqual([])
  })
})

describe('names', () => {
  it.each(['vault.read', 'core.openTrusted', 'file-explorer.open', 'search.indexed', 'my_plugin.do2'])('takes %j as an action or topic', value => {
    expect(qualifiedName.safeParse(value).success).toBe(true)
  })

  it.each([
    'read', 'vault.read.x', 'vault..read', '.read', 'vault.', 'Vault.read', 'vault.Read', 'vault.1read', 'vault.re-ad', 'vault.*',
    `${'a'.repeat(MAX_ID_LENGTH + 1)}.read`, `vault.${'a'.repeat(MAX_NAME_LENGTH + 1)}`,
  ])('refuses %j', value => {
    expect(qualifiedName.safeParse(value).success).toBe(false)
  })

  it('takes each part at its cap', () => {
    expect(qualifiedName.safeParse(`${'a'.repeat(MAX_ID_LENGTH)}.${'b'.repeat(MAX_NAME_LENGTH)}`).success).toBe(true)
  })

  it.each(['query', 'openFolder', 'a1'])('takes %j as a local name', value => {
    expect(localName.safeParse(value).success).toBe(true)
  })

  it.each(['', 'Query', '1a', 'a-b', 'a.b', 'a b', 'x'.repeat(MAX_NAME_LENGTH + 1)])('refuses %j as a local name', value => {
    expect(localName.safeParse(value).success).toBe(false)
  })
})

describe('slots, providers and guards', () => {
  it('has the four policy slots', () => {
    expect(slotIds).toEqual(['gate', 'capabilities', 'log', 'watchdog'])
  })

  it("names the provider of every namespace in section 4's table", () => {
    expect(providers).toEqual({
      vault: 'vault', leases: 'leases', history: 'history', exec: 'exec', storage: 'storage', cache: 'storage', log: 'log', net: 'net',
    })
  })

  it('serves core, security, watchdog, events, ui and plugin in the core', () => {
    expect(coreNamespaces).toEqual(['core', 'security', 'watchdog', 'events', 'ui', 'plugin'])
  })

  it('lets guards hook vault.write and expects none until leases ships', () => {
    expect(guardableActions).toEqual(['vault.write'])
    expect(guards).toEqual({ 'vault.write': [] })
  })

  it('lists the install plugins, host-level and in-page', () => {
    expect(installIds).toEqual([
      'log', 'gate', 'capabilities', 'watchdog', 'storage', 'vault', 'leases', 'history', 'exec', 'http', 'net',
      'editor-core', 'hidden-marks',
    ])
  })

  it('serves every provider and fills every slot from the install', () => {
    for (const id of [...slotIds, ...Object.values(providers)]) expect(installIds).toContain(id)
  })
})

describe('reserved ids', () => {
  // Section 3: every namespace the carrier serves, every slot, provider and install id and the ids first party keeps
  const expected = [
    'core', 'security', 'events', 'ui', 'plugin', 'storage', 'cache', 'watchdog',
    'gate', 'capabilities', 'log',
    'vault', 'leases', 'history', 'exec', 'net', 'http', 'editor-core', 'hidden-marks',
    'mcp', 'git', 'search', 'file-explorer', 'artifacts', 'notify',
  ]

  it('holds exactly the ids section 3 reserves', () => {
    expect(reservedIds).toEqual([...expected].sort())
  })

  it('keeps the first-party ids apart, the only reserved ids a folder plugin may hold', () => {
    expect(firstPartyIds).toEqual(['mcp', 'git', 'search', 'file-explorer', 'artifacts', 'notify'])
  })

  it.each(expected)('reserves %j', id => {
    expect(isReservedId(id)).toBe(true)
  })

  // Otherwise the id grammar alone would keep a reserved id out and the reserved list would test nothing
  it.each(expected)('treats %j as a valid plugin id', id => {
    expect(pluginId.safeParse(id).success).toBe(true)
  })

  it.each(['searchx', 'my-notes', 'leases2', 'gates', 'core-tools', 'git-lfs', 'notify-me', 'editor', 'trusted', 'hetu'])(
    'leaves %j free',
    id => {
      expect(isReservedId(id)).toBe(false)
    },
  )

  it('reserves no name from Object', () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(isReservedId(id)).toBe(false)
  })
})

describe('the tables', () => {
  it('are frozen, so code sharing the process can not change one', () => {
    expect(() => (reservedIds as unknown as string[]).push('mine')).toThrow()
    expect(() => (slotIds as unknown as string[]).push('mine')).toThrow()
    expect(() => (coreNamespaces as unknown as string[]).push('mine')).toThrow()
    expect(() => (installIds as unknown as string[]).push('mine')).toThrow()
    expect(() => (firstPartyIds as unknown as string[]).push('mine')).toThrow()
    expect(() => { (providers as Record<string, string>).vault = 'mine' }).toThrow()
    expect(() => { (guards['vault.write'] as string[]).push('mine') }).toThrow()
    expect(isReservedId('mine')).toBe(false)
  })

  // Section 3: the core decides with null-prototype tables, so a prototype bug in a host half can't flip a decision
  it('have no prototype, so a namespace or action named like a member of Object finds nothing', () => {
    for (const table of [providers, guards] as Record<string, unknown>[]) {
      expect(Object.getPrototypeOf(table)).toBeNull()
      expect(table.constructor).toBeUndefined()
      expect('toString' in table).toBe(false)
    }
  })

  it('find nothing a slip added to Object.prototype', () => {
    const shared = Object.prototype as Record<string, unknown>
    shared.search = 'vault'
    shared['vault.read'] = ['mcp']
    try {
      expect((providers as Record<string, unknown>).search).toBeUndefined()
      expect((guards as Record<string, unknown>)['vault.read']).toBeUndefined()
    } finally {
      delete shared.search
      delete shared['vault.read']
    }
  })
})
