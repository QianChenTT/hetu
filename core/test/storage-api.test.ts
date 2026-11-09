import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { reasonCodes, windowRoles } from '../api/envelope.ts'
import { pluginId } from '../api/ids.ts'
import { quotas, spaceOf } from '../api/storage.ts'
import { folders } from '../backend/loader/folders.ts'

const MiB = 1024 * 1024

describe('a caller\'s space', () => {
  it('is a plugin\'s id, the folder the loader clears for it', () => {
    const space = spaceOf({ kind: 'plugin', id: 'search', half: 'worker', incarnation: 3 })
    expect(space).toBe('search')
    expect(path.basename(folders.storage('data', 'search'))).toBe(space)
    expect(path.basename(folders.cache('data', 'search'))).toBe(space)
  })

  it('is the same for every half and incarnation of one plugin', () => {
    const halves = ['worker', 'host', 'page', 'panel'].map(half => spaceOf({ kind: 'plugin', id: 'git', half, incarnation: 1 }))
    expect(new Set([...halves, spaceOf({ kind: 'plugin', id: 'git', half: 'worker', incarnation: 9 })])).toEqual(new Set(['git']))
  })

  it.each(windowRoles)('is window.%s for that window, whichever of its pages asks', role => {
    expect(spaceOf({ kind: 'window', role, n: 0 })).toBe(`window.${role}`)
    expect(spaceOf({ kind: 'window', role, n: 7 })).toBe(`window.${role}`)
  })

  it('of a window can never be a plugin\'s, since no plugin id holds a dot', () => {
    for (const role of windowRoles) expect(pluginId.safeParse(spaceOf({ kind: 'window', role, n: 0 })).success).toBe(false)
  })

  it('doesn\'t exist for content, which has no design yet', () => {
    expect(spaceOf({ kind: 'content', plugin: 'search', token: 'a'.repeat(32) })).toBeNull()
  })
})

describe('the quotas', () => {
  it('hold each storage space to 16 MiB and 1,024 keys and each cache to 64 MiB and 1,024 keys', () => {
    expect(quotas.storage).toEqual({ bytes: 16 * MiB, keys: 1024 })
    expect(quotas.cache).toEqual({ bytes: 64 * MiB, keys: 1024 })
  })

  it('can\'t be changed by a host half sharing the process', () => {
    expect(Object.isFrozen(quotas.storage)).toBe(true)
    expect(Object.getPrototypeOf(quotas)).toBeNull()
  })

  it('answer a set past one with the reason quota', () => {
    expect(reasonCodes).toContain('quota')
  })
})
