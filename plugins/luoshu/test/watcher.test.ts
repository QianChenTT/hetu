import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Call, Prepared } from 'hetu-core/api/slots.ts'
import { createLuoshu, type Luoshu } from '../src/luoshu.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let base: string
let folder: string
let made: (Luoshu & { heard: [string, string][] }) | null = null
let n = 0

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-watch-')))
  folder = path.join(base, 'notes')
  for (const dir of [path.join(folder, '.git'), path.join(folder, 'journal'), path.join(base, 'data'), path.join(base, 'install')]) {
    await mkdir(dir, { recursive: true })
  }
  await writeFile(path.join(folder, 'a.md'), 'note a')
})

afterEach(async () => {
  made?.close()
  made = null
  await rm(base, { recursive: true, force: true })
})

async function watching(): Promise<Luoshu & { heard: [string, string][] }> {
  const heard: [string, string][] = []
  made = Object.assign(createLuoshu({ publish: (topic, at) => heard.push([topic, at]), settleMs: 100 }), { heard })
  made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
  // The watch starts once the folder is open
  await tick(200)
  return made
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (let waited = 0; !check(); waited += 25) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(25)
  }
}

async function write(luoshu: Luoshu, at: string, text: string, baseVersion?: string): Promise<unknown> {
  const call: Call = { callId: `w${++n}`, caller: { kind: 'window', role: 'editor', n: 0 }, action: 'luoshu.write', args: { path: at, text, baseVersion }, deadline: Date.now() + 30000 }
  const prepared = await luoshu.provider.prepare(call)
  return luoshu.provider.perform(call, prepared as Prepared)
}

describe('the watcher', () => {
  it('publishes an outside save once it settles, as luoshu.outside with the path', async () => {
    const luoshu = await watching()
    await writeFile(path.join(folder, 'journal', 'b.md'), 'from obsidian')
    await until(() => luoshu.heard.length > 0)
    await tick(300)
    expect(luoshu.heard).toEqual([['outside', 'journal/b.md']])
  })

  it('publishes an outside delete', async () => {
    const luoshu = await watching()
    await unlink(path.join(folder, 'a.md'))
    await until(() => luoshu.heard.length > 0)
    expect(luoshu.heard).toEqual([['outside', 'a.md']])
  })

  it('takes hetu\'s own write for its own, then an outside save over it for outside', async () => {
    const luoshu = await watching()
    await write(luoshu, 'a.md', 'from hetu', sha('note a'))
    await tick(500)
    expect(luoshu.heard).toEqual([['changed', 'a.md']])
    await writeFile(path.join(folder, 'a.md'), 'from obsidian')
    await until(() => luoshu.heard.length > 1)
    expect(luoshu.heard).toEqual([['changed', 'a.md'], ['outside', 'a.md']])
  })

  it('publishes nothing for .git, a temp file or hetu\'s own folders', async () => {
    const luoshu = await watching()
    await writeFile(path.join(folder, '.git', 'index'), 'x')
    await writeFile(path.join(folder, 'journal', '.c.md.1234.hetu-tmp'), 'x')
    await mkdir(path.join(folder, 'empty'))
    await tick(600)
    expect(luoshu.heard).toEqual([])
  })

  it('stops publishing once closed or given no folder', async () => {
    const luoshu = await watching()
    luoshu.role.open({ folder: null, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
    await writeFile(path.join(folder, 'a.md'), 'later')
    await tick(500)
    expect(luoshu.heard).toEqual([])
  })
})
