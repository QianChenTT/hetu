import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Call, Prepared } from 'hetu-core/api/policy-jobs.ts'
import { createLuoshu, type Luoshu } from '../src/luoshu.ts'

// What another program does to the disk once a write's temp file is open, after the version check and before the note
// lands, and what the disk answers a link or an unlink with
const disk = {
  onTemp: null as null | (() => Promise<void>),
  noLinks: false,
  // An unlink of a temp file that fails, as a crash right after the link leaves it
  keepTemp: false,
  // A rename of a temp file that fails
  renameFails: false,
  // What another program does right before a rename of any other file
  beforeRename: null as null | (() => Promise<void>),
}

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  const temp = (name: unknown) => String(name).endsWith('.hetu-tmp')
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      if (args[1] === 'wx' && temp(args[0]) && disk.onTemp !== null) {
        const run = disk.onTemp
        disk.onTemp = null
        await run()
      }
      return handle
    }) as typeof real.open,
    link: (async (from: string, to: string) => {
      if (disk.noLinks) throw Object.assign(new Error('no links'), { code: 'ENOTSUP' })
      return real.link(from, to)
    }) as typeof real.link,
    unlink: (async (file: string) => {
      if (disk.keepTemp && temp(file)) throw Object.assign(new Error('crashed'), { code: 'EIO' })
      return real.unlink(file)
    }) as typeof real.unlink,
    rename: (async (from: string, to: string) => {
      if (disk.renameFails && temp(from)) throw Object.assign(new Error('refused'), { code: 'EIO' })
      if (!temp(from) && disk.beforeRename !== null) {
        const act = disk.beforeRename
        disk.beforeRename = null
        await act()
      }
      return real.rename(from, to)
    }) as typeof real.rename,
  }
})

const onWindows = process.platform === 'win32'
const foldsCase = onWindows || process.platform === 'darwin'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const run = promisify(execFile)
const stale = { refused: { code: 'stale' } }

let base: string
let folder: string
let n = 0
const live: Luoshu[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-landing-')))
  folder = path.join(base, 'notes')
  for (const dir of [path.join(folder, 'box'), path.join(base, 'data'), path.join(base, 'install')]) await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  Object.assign(disk, { onTemp: null, noLinks: false, keepTemp: false, renameFails: false, beforeRename: null })
  for (const made of live.splice(0)) made.close()
  await rm(base, { recursive: true, force: true })
})

function opened(): Luoshu {
  const made = createLuoshu({ settleMs: 50 })
  live.push(made)
  made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
  return made
}

// A write through prepare and perform with a judge that allows the path prepare gave only. A refusal comes back as
// { refused }
async function write(luoshu: Luoshu, file: string, text: string, baseVersion?: string): Promise<unknown> {
  const call: Call = {
    callId: `c${++n}`, caller: { kind: 'plugin', id: 'beta', half: 'worker', incarnation: 1 }, action: 'luoshu.write',
    args: baseVersion === undefined ? { path: file, text } : { path: file, text, baseVersion }, deadline: Date.now() + 30000,
    judge: () => ({ code: 'not-granted' }),
  }
  const prepared = await luoshu.provider.prepare(call)
  if (!('scope' in prepared)) return { refused: prepared }
  try {
    return await luoshu.provider.perform(call, prepared as Prepared)
  } catch (err) {
    return { refused: err }
  }
}

const at = (...names: string[]) => path.join(folder, ...names)
const names = async (...dir: string[]) => (await readdir(at(...dir))).sort()
const until = async (check: () => Promise<boolean>) => {
  for (const begun = Date.now(); !(await check()); await new Promise(resolve => setTimeout(resolve, 20))) {
    if (Date.now() - begun > 5000) throw new Error('timed out')
  }
}

// The 8.3 short name Windows made for a name in a folder, as dir /x shows it. null when the volume makes none
async function shortName(dir: string, name: string): Promise<string | null> {
  const { stdout } = await run('cmd.exe', ['/d', '/c', 'dir', '/x', '/a'], { cwd: dir })
  for (const line of stdout.split(/\r?\n/).map(l => l.trimEnd())) {
    if (!line.endsWith(` ${name}`)) continue
    const short = line.slice(0, -name.length).trimEnd().split(/\s+/).at(-1)
    if (short?.includes('~')) return short
  }
  return null
}

// Whether this volume gives secretnote.md the short name SECRET~1.MD in an empty folder
async function shortNames(): Promise<boolean> {
  const dir = path.join(base, 'probe')
  await mkdir(dir)
  await writeFile(path.join(dir, 'secretnote.md'), '')
  const short = await shortName(dir, 'secretnote.md')
  await rm(dir, { recursive: true })
  return short === 'SECRET~1.MD'
}

describe('a new note', () => {
  it('lands with the bytes sent and leaves no temp file', async () => {
    expect(await write(opened(), 'box/n.md', 'MINE')).toEqual({ version: sha('MINE') })
    expect(await names('box')).toEqual(['n.md'])
    expect(await readFile(at('box', 'n.md'), 'utf8')).toBe('MINE')
  })

  // Whichever prepare takes the key's lock first lands
  it('refuses the later of two creates of one name sent together stale and keeps the earlier one\'s note', async () => {
    const luoshu = opened()
    const answers = await Promise.all([write(luoshu, 'box/n.md', 'ONE'), write(luoshu, 'box/n.md', 'TWO')])
    const first = answers.findIndex(answer => (answer as { version?: string }).version !== undefined)
    expect(answers).toEqual(first === 0 ? [{ version: sha('ONE') }, stale] : [stale, { version: sha('TWO') }])
    expect(await names('box')).toEqual(['n.md'])
    expect(await readFile(at('box', 'n.md'), 'utf8')).toBe(first === 0 ? 'ONE' : 'TWO')
  })

  it('refuses stale and makes nothing when a folder takes the name after the version check', async () => {
    disk.onTemp = () => mkdir(at('box', 'n.md'))
    expect(await write(opened(), 'box/n.md', 'MINE')).toEqual(stale)
    expect(await names('box')).toEqual(['n.md'])
    expect((await lstat(at('box', 'n.md'))).isDirectory()).toBe(true)
  })

  it('keeps a note another program makes under the other normal form of the name after the version check', async () => {
    const nfd = 'café.md'
    disk.onTemp = () => writeFile(at('box', nfd), 'OTHER')
    const answer = await write(opened(), 'box/café.md', 'MINE')
    // NTFS and ext4 keep the two forms apart and the write lands beside it. APFS reads them as one name
    expect([{ version: sha('MINE') }, stale]).toContainEqual(answer)
    expect(await readFile(at('box', nfd), 'utf8')).toBe('OTHER')
    expect((await names('box')).filter(name => name.startsWith('.'))).toEqual([])
  })

  it.runIf(foldsCase)('refuses stale and leaves a note another program makes under another case of the name after the version check', async () => {
    disk.onTemp = () => writeFile(at('box', 'N.md'), 'OTHER')
    expect(await write(opened(), 'box/n.md', 'MINE')).toEqual(stale)
    expect(await names('box')).toEqual(['N.md'])
    expect(await readFile(at('box', 'N.md'), 'utf8')).toBe('OTHER')
  })

  it.runIf(onWindows)('refuses stale and leaves a note whose 8.3 short name is the name, made after the version check', async ({ skip }) => {
    if (!(await shortNames())) {
      if (process.env.CI) throw new Error('no 8.3 short names on this CI volume, the landing through one unproven')
      return skip('this volume makes no 8.3 short names')
    }
    disk.onTemp = () => writeFile(at('box', 'secretnote.md'), 'OTHER')
    expect(await write(opened(), 'box/SECRET~1.MD', 'MINE')).toEqual(stale)
    expect(await names('box')).toEqual(['secretnote.md'])
    expect(await readFile(at('box', 'secretnote.md'), 'utf8')).toBe('OTHER')
  })

  // Two writes under two keys through one luoshu, sent a few milliseconds apart with no hook: one spelled as the 8.3
  // short name the other's new note gets
  it.runIf(onWindows)('never lands on another write\'s new note through its 8.3 short name', async ({ skip }) => {
    if (!(await shortNames())) {
      if (process.env.CI) throw new Error('no 8.3 short names on this CI volume, the landing through one unproven')
      return skip('this volume makes no 8.3 short names')
    }
    const luoshu = opened()
    const lost: number[] = []
    for (let i = 0; i < 60; i++) {
      await mkdir(at(`s${i}`))
      const delay = (i % 8) - 2
      const later = (ms: number, act: () => Promise<unknown>) => (ms <= 0 ? act() : new Promise(resolve => setTimeout(resolve, ms)).then(act))
      const [, other] = await Promise.all([
        later(-delay, () => write(luoshu, `s${i}/SECRET~1.MD`, 'x'.repeat(64 * 1024))),
        later(delay, () => write(luoshu, `s${i}/secretnote.md`, `OTHER ${i}`)),
      ])
      const held = await readFile(at(`s${i}`, 'secretnote.md'), 'utf8').catch(() => null)
      if ((other as { version?: string }).version !== undefined && held !== `OTHER ${i}`) lost.push(i)
    }
    expect(lost).toEqual([])
  }, 60_000)
})

describe('a crash between the link and the removal of the temp file', () => {
  it('still answers the write, whose note holds the bytes sent, and leaves the temp file as a second name of it', async () => {
    disk.keepTemp = true
    expect(await write(opened(), 'box/n.md', 'MINE')).toEqual({ version: sha('MINE') })
    const left = (await names('box')).filter(name => name.endsWith('.hetu-tmp'))
    expect(left).toHaveLength(1)
    expect((await lstat(at('box', left[0]), { bigint: true })).ino).toBe((await lstat(at('box', 'n.md'), { bigint: true })).ino)
    expect(await readFile(at('box', 'n.md'), 'utf8')).toBe('MINE')
  })

  it('has its temp files removed when the folder is opened again a minute later, and keeps the notes and a younger one', async () => {
    await writeFile(at('box', 'n.md'), 'NOTE')
    const old = at('box', '.n.md.0123456789ab.hetu-tmp')
    const young = at('box', '.m.md.ba9876543210.hetu-tmp')
    await link(at('box', 'n.md'), old)
    await writeFile(young, 'YOUNG')
    const hour = Date.now() / 1000 - 3600
    await utimes(old, hour, hour)
    opened()
    await until(async () => !(await names('box')).includes(path.basename(old)))
    expect(await names('box')).toEqual([path.basename(young), 'n.md'])
    expect(await readFile(at('box', 'n.md'), 'utf8')).toBe('NOTE')
  })

  it('leaves a dot file whose name only looks like a temp file\'s and anything in a dot folder', async () => {
    const hour = Date.now() / 1000 - 3600
    await mkdir(at('.obsidian'))
    const kept = [at('box', '.n.md.hetu-tmp'), at('box', '.n.md.0123456789AB.hetu-tmp'), at('.obsidian', '.n.md.0123456789ab.hetu-tmp')]
    for (const file of kept) {
      await writeFile(file, 'KEEP')
      await utimes(file, hour, hour)
    }
    const swept = at('box', '.s.md.0123456789ab.hetu-tmp')
    await writeFile(swept, 'GO')
    await utimes(swept, hour, hour)
    opened()
    await until(async () => !(await names('box')).includes(path.basename(swept)))
    for (const file of kept) expect(await readFile(file, 'utf8')).toBe('KEEP')
  })
})

describe('on a volume with no hard links', () => {
  it('lands a new note by claiming its name and leaves no temp file', async () => {
    disk.noLinks = true
    expect(await write(opened(), 'box/n.md', 'MINE')).toEqual({ version: sha('MINE') })
    expect(await names('box')).toEqual(['n.md'])
    expect(await readFile(at('box', 'n.md'), 'utf8')).toBe('MINE')
  })

  it.runIf(foldsCase)('refuses stale and leaves a note another program makes under another case of the name after the version check', async () => {
    disk.noLinks = true
    disk.onTemp = () => writeFile(at('box', 'N.md'), 'OTHER')
    expect(await write(opened(), 'box/n.md', 'MINE')).toEqual(stale)
    expect(await names('box')).toEqual(['N.md'])
    expect(await readFile(at('box', 'N.md'), 'utf8')).toBe('OTHER')
  })

  it.runIf(onWindows)('refuses stale and leaves a note whose 8.3 short name is the name, made after the version check', async ({ skip }) => {
    if (!(await shortNames())) {
      if (process.env.CI) throw new Error('no 8.3 short names on this CI volume, the landing through one unproven')
      return skip('this volume makes no 8.3 short names')
    }
    disk.noLinks = true
    disk.onTemp = () => writeFile(at('box', 'secretnote.md'), 'OTHER')
    expect(await write(opened(), 'box/SECRET~1.MD', 'MINE')).toEqual(stale)
    expect(await names('box')).toEqual(['secretnote.md'])
    expect(await readFile(at('box', 'secretnote.md'), 'utf8')).toBe('OTHER')
  })

  it.runIf(foldsCase)('moves a note only onto a to end nothing answers to, so another program\'s new note under another case of it is never replaced', async () => {
    disk.noLinks = true
    await writeFile(at('box', 'm.md'), 'OWN')
    let other = ''
    disk.beforeRename = async () => {
      other = await writeFile(at('TAKEN.md'), 'OTHER', { flag: 'wx' }).then(() => 'made', err => (err as NodeJS.ErrnoException).code ?? '')
    }
    const luoshu = opened()
    const call: Call = {
      callId: `c${++n}`, caller: { kind: 'plugin', id: 'beta', half: 'worker', incarnation: 1 }, action: 'luoshu.move',
      args: { from: 'box/m.md', to: 'taken.md' }, deadline: Date.now() + 30000, judge: () => ({ code: 'not-granted' }),
    }
    const prepared = await luoshu.provider.prepare(call) as Prepared
    expect(await luoshu.provider.perform(call, prepared)).toBeNull()
    // The other program's create found the name taken, so no note of its was there to replace
    expect(other).toBe('EEXIST')
    expect((await readdir(folder)).sort()).toEqual(['box', 'taken.md'])
    expect(await readFile(at('taken.md'), 'utf8')).toBe('OWN')
  })

  it('takes its claim on the name back when the rename onto it fails', async () => {
    disk.noLinks = true
    disk.renameFails = true
    expect(await write(opened(), 'box/n.md', 'MINE')).toMatchObject({ refused: { code: 'EIO' } })
    expect(await names('box')).toEqual([])
  })
})
