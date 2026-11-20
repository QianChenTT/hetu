import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLuoshu } from '../backend/providers/luoshu/luoshu.ts'
import { cleanup, code, harness, tick, worker } from './router-fakes.ts'

// What another program does right after a move's link, and the path whose every unlink fails
const disk = { afterLink: null as null | (() => Promise<void>), failing: '' }

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    link: (async (from: string, to: string) => {
      await real.link(from, to)
      const act = disk.afterLink
      disk.afterLink = null
      await act?.()
    }) as typeof real.link,
    unlink: (async (file: string) => {
      if (disk.failing !== '' && String(file) === disk.failing) throw Object.assign(new Error('held'), { code: 'EPERM' })
      return real.unlink(file)
    }) as typeof real.unlink,
  }
})

const bases: string[] = []

afterEach(async () => {
  Object.assign(disk, { afterLink: null, failing: '' })
  cleanup()
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true })
})

// Windows and macOS read two cases of one name as one file
describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('a move whose link at the to end can\'t be taken back', () => {
  it('answers failed, records the call failed and the luoshu\'s fault', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-move-back-')))
    bases.push(base)
    const folder = path.join(base, 'notes')
    await mkdir(path.join(folder, 'box'), { recursive: true })
    for (const dir of ['data', 'install']) await mkdir(path.join(base, dir))
    await writeFile(path.join(folder, 'box', 'm.md'), 'OWN')
    const luoshu = createLuoshu({ settleMs: 50 })
    luoshu.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
    const parts = harness()
    parts.gate.grants.mover = [{ type: 'luoshu.read', paths: ['box/m.md'] }, { type: 'luoshu.write', paths: ['box/m.md', 'taken.md'] }] as never
    parts.providers.luoshu = luoshu.provider
    // Right after the link the note moves out of the from end and another program's note takes it under another case,
    // so the move is refused and its link taken back, which the disk refuses every time
    disk.afterLink = async () => {
      await rename(path.join(folder, 'box', 'm.md'), path.join(folder, 'kept.md'))
      await writeFile(path.join(folder, 'box', 'M.md'), 'OTHER M')
    }
    disk.failing = path.join(folder, 'taken.md')
    // The unlink is tried again for about 2.5 seconds on Windows before the move gives up
    const side = parts.connect(worker('mover'))
    const reply = await side.reply(side.call('luoshu.move', { from: 'box/m.md', to: 'taken.md' }), 10_000)
    luoshu.close()
    expect(code(reply)).toBe('failed')
    expect(await readFile(path.join(folder, 'taken.md'), 'utf8')).toBe('OWN')
    await parts.recording.flush()
    expect(parts.log.events('audit.call').map(record => record.fields)).toMatchObject([{ action: 'luoshu.move', code: 'failed' }])
    // The router's coalesced records are written as it closes
    parts.router.close()
    await tick()
    expect(parts.log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'luoshu', step: 'perform', count: 1 }])
  }, 15_000)
})
