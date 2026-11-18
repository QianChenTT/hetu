import { mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Call, Prepared } from 'hetu-core/api/policy-jobs.ts'
import { ask, callOf, cleanup, commitOf, place, started } from './helpers.ts'

// How many times realpath runs while counting is on, what happens once a note named here is opened and once a
// realpath of the path named in resolved has run
const disk = { counting: false, realpaths: 0, opened: '', afterOpen: null as null | (() => Promise<void>), resolved: '', afterResolve: null as null | (() => Promise<void>) }

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    realpath: (async (...args: Parameters<typeof real.realpath>) => {
      if (disk.counting) disk.realpaths++
      const found = await real.realpath(...args)
      if (disk.afterResolve !== null && String(args[0]) === disk.resolved) {
        const act = disk.afterResolve
        disk.afterResolve = null
        await act()
      }
      return found
    }) as typeof real.realpath,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      if (disk.afterOpen !== null && String(args[0]) === disk.opened) {
        const act = disk.afterOpen
        disk.afterOpen = null
        await act()
      }
      return handle
    }) as typeof real.open,
  }
})

afterEach(async () => {
  Object.assign(disk, { counting: false, realpaths: 0, opened: '', afterOpen: null, resolved: '', afterResolve: null })
  await cleanup()
})

// What git holds for a commit: the paths of its tree
const treeOf = async (history: Awaited<ReturnType<typeof started>>, at: string) =>
  (await ask(history, 'history.log', { path: at }) as { commits: { commit: string }[] }).commits.length

describe('a commit of notes under a deep folder', () => {
  // The look at each note runs inside the one queue every history call waits in. Once the note's folder resolves to
  // itself only its last name is resolved again, not each folder from the notes folder down
  it('resolves each note\'s folder and last name in a few steps whatever the depth', async () => {
    const where = await place()
    const deep = Array.from({ length: 60 }, () => 'a')
    await mkdir(path.join(where.notes, ...deep), { recursive: true })
    const paths: string[] = []
    for (let i = 0; i < 16; i++) {
      await writeFile(path.join(where.notes, ...deep, `n${i}.md`), `note ${i}`)
      paths.push([...deep, `n${i}.md`].join('/'))
    }
    const history = await started(where)
    const call = { ...callOf('history.commit', { paths, message: 'deep' }), judge: () => null } as Call
    const prepared = await history.provider.prepare(call) as Prepared
    disk.counting = true
    const done = await history.provider.perform(call, prepared) as { commit: string | null }
    disk.counting = false
    expect(done.commit).toMatch(/^[0-9a-f]{40}$/)
    // Each note: its folder's look, then the last name resolved twice with hetu's own two folders. The whole spelling
    // would take a resolve for each of the 61 names twice over
    expect(disk.realpaths).toBeLessThanOrEqual(16 * 8)
  })

  // Windows refuses a rename of a folder that holds an open file, so the folder is swapped once its look held and
  // before the note is opened, through the junction
  it('refuses a note whose folder became a junction after its look and records nothing', async () => {
    const where = await place()
    await mkdir(path.join(where.notes, 'box'))
    await mkdir(path.join(where.notes, 'other'))
    await writeFile(path.join(where.notes, 'box', 'n.md'), 'MINE')
    await writeFile(path.join(where.notes, 'other', 'n.md'), 'OTHER')
    const history = await started(where)
    expect(await commitOf(history, ['other/n.md'], 'first')).toMatch(/^[0-9a-f]{40}$/)
    const call = { ...callOf('history.commit', { paths: ['box/n.md'], message: 'swapped' }), judge: (paths: readonly string[]) => (paths[0] === 'box/n.md' ? null : { code: 'not-granted' as const }) } as Call
    const prepared = await history.provider.prepare(call) as Prepared
    Object.assign(disk, {
      resolved: path.join(where.notes, 'box'),
      afterResolve: async () => {
        await rename(path.join(where.notes, 'box'), path.join(where.notes, 'box-was'))
        await symlink(path.join(where.notes, 'other'), path.join(where.notes, 'box'), 'junction')
      },
    })
    await expect(history.provider.perform(call, prepared)).rejects.toEqual({ code: 'not-granted' })
    // The look at the folder is what swapped it
    expect(disk.afterResolve).toBeNull()
    // The folder put back, so a log of box/n.md names that path and not the junction's
    await rm(path.join(where.notes, 'box'))
    await rename(path.join(where.notes, 'box-was'), path.join(where.notes, 'box'))
    expect(await treeOf(history, 'box/n.md')).toBe(0)
    expect(await treeOf(history, 'other/n.md')).toBe(1)
  })
})

describe('a commit whose deadline passes between its notes', () => {
  it('answers timeout and commits nothing', async () => {
    const where = await place()
    for (const name of ['a.md', 'b.md', 'c.md']) await writeFile(path.join(where.notes, name), name)
    const history = await started(where)
    Object.assign(disk, { opened: path.join(where.notes, 'a.md'), afterOpen: () => new Promise(resolve => setTimeout(resolve, 300)) })
    const call = { ...callOf('history.commit', { paths: ['a.md', 'b.md', 'c.md'], message: 'late' }), deadline: Date.now() + 150, judge: () => null } as Call
    const prepared = await history.provider.prepare(call) as Prepared
    await expect(history.provider.perform(call, prepared)).rejects.toEqual({ code: 'timeout' })
    for (const name of ['a.md', 'b.md', 'c.md']) expect(await treeOf(history, name)).toBe(0)
    expect(await readdir(where.notes)).toEqual(['a.md', 'b.md', 'c.md'])
  })
})
