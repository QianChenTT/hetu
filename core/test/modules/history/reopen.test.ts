import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prepared } from '../../../api/policy-jobs.ts'
import { ask, callOf, cleanup, place, started } from './helpers.ts'

// Each open of a note named here is followed by the note moved away and another file put at its name, as many times
// as replacing says. Windows refuses a rename over a file held open, so the one opened moves first
const replacing = { name: '', times: 0, opens: 0 }

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      if (replacing.name !== '' && String(args[0]) === replacing.name) {
        replacing.opens++
        if (replacing.times > 0) {
          replacing.times--
          const temp = `${replacing.name}.next`
          await real.writeFile(temp, `written after open ${replacing.opens}`)
          await real.rename(replacing.name, `${replacing.name}.was${replacing.opens}`)
          await real.rename(temp, replacing.name)
        }
      }
      return handle
    }) as typeof real.open,
  }
})

afterEach(async () => {
  Object.assign(replacing, { name: '', times: 0, opens: 0 })
  await cleanup()
})

describe('a note replaced between the open and the look after it', () => {
  it('is opened again and the commit holds the note as it is now', async () => {
    const where = await place()
    await mkdir(path.join(where.notes, 'box'))
    await writeFile(path.join(where.notes, 'box', 'n.md'), 'first')
    const history = await started(where)
    const call = { ...callOf('history.commit', { paths: ['box/n.md'], message: 'mine' }), judge: () => null }
    const prepared = await history.provider.prepare(call) as Prepared
    Object.assign(replacing, { name: path.join(where.notes, 'box', 'n.md'), times: 1 })
    const made = await history.provider.perform(call, prepared) as { commit: string }
    expect(replacing.opens).toBe(2)
    expect(await ask(history, 'history.read', { path: 'box/n.md', commit: made.commit })).toMatchObject({ text: 'written after open 1' })
  })

  it('answers stale when the note is replaced after each of three opens and commits nothing', async () => {
    const where = await place()
    await mkdir(path.join(where.notes, 'box'))
    await writeFile(path.join(where.notes, 'box', 'n.md'), 'first')
    const history = await started(where)
    const call = { ...callOf('history.commit', { paths: ['box/n.md'], message: 'mine' }), judge: () => null }
    const prepared = await history.provider.prepare(call) as Prepared
    Object.assign(replacing, { name: path.join(where.notes, 'box', 'n.md'), times: 3 })
    await expect(history.provider.perform(call, prepared)).rejects.toEqual({ code: 'stale' })
    expect(replacing.opens).toBe(3)
    expect(await ask(history, 'history.log', { path: 'box/n.md' })).toEqual({ commits: [] })
  })
})
