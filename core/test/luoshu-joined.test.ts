import { cp, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import type { GuardCall } from '../api/slots.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore } from '../backend/boot/state.ts'
import { wireCore, type WireOptions } from '../backend/wire.ts'
import { createGate } from '../../plugins/gate/src/gate.ts'
import { createLuoshu } from '../../plugins/luoshu/src/luoshu.ts'
import { coreInstall, FakeRuntime, filesFor, hostManifest, tempBase, writeInstall } from './loader-fakes.ts'

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

type Reply = { id?: number, ok?: boolean, result?: unknown, refusal?: { code: string } }

// The joined core over a real boot, with the gate and the luoshu plugins as they ship and the folder picked. Calls come
// from the editor window, each reply handed back the moment the carrier sends it
async function joined(folder: string, options: { behave?: FakeRuntime['behave'], wire?: Pick<WireOptions, 'guardsFor' | 'trash'>, install?: object, gate?: 'off' } = {}) {
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  await mkdir(installDir, { recursive: true })
  await writeInstall(installDir, { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) }, ...options.install })
  const store = new StateStore(dataDir)
  // The gate switched off by the human, as the trusted window does
  await store.writeSwitches(options.gate === 'off' ? { ...defaultSwitches(), off: ['gate'] } : defaultSwitches())
  await store.writeLuoshu({ folder })
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const luoshu = createLuoshu()
  const runtime = new FakeRuntime()
  runtime.behave = { gate: { exports: { gate: createGate() } }, luoshu: { exports: { provider: luoshu.provider, luoshu: luoshu.role } }, ...options.behave }
  const { loader, carrier } = wireCore({ booted, installDir, runtime, confirmDelayMs: 0, ...options.wire })
  open.push(async () => {
    luoshu.close()
    await loader.shutdown().catch(() => {})
    carrier.close()
    await carrier.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true })
  })
  await loader.start()
  await loader.settled()
  const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
  const waiting = new Map<number, (reply: Reply) => void>()
  const receive = carrier.window<string>(sender => (sender === 'editor' ? editor : null))
  let next = 1
  const ask = (action: string, args?: unknown) => new Promise<Reply>(resolve => {
    const id = next++
    waiting.set(id, resolve)
    receive('editor', { v: 1, kind: 'call', id, action, args }, message => {
      const reply = message as Reply
      if (typeof reply.id !== 'number') return
      waiting.get(reply.id)?.(reply)
      waiting.delete(reply.id)
    })
  })
  return { loader, carrier, dataDir, base, ask }
}

async function events(dataDir: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path.join(dataDir, 'events', 'events-1.jsonl'), 'utf8')
  return text.split('\n').slice(0, -1).map(line => JSON.parse(line) as Record<string, unknown>)
}

async function notes(): Promise<string> {
  const folder = path.join(await tempBase(), 'notes')
  await mkdir(folder, { recursive: true })
  open.push(() => rm(path.dirname(folder), { recursive: true, force: true }))
  return folder
}

describe('the guard step', () => {
  it('refuses a write a guard denies, leaving the note as it was and the lock free', async () => {
    const folder = await notes()
    await writeFile(path.join(folder, 'a.md'), 'as it was')
    const { ask } = await joined(folder, {
      install: { leases: { files: filesFor(hostManifest('leases')) } },
      behave: { leases: { exports: { guard: { check: () => 'deny' } } } },
      wire: { guardsFor: () => ['leases'] },
    })
    const read = await ask('luoshu.read', { path: 'a.md' })
    const { version } = read.result as { version: string }
    expect((await ask('luoshu.write', { path: 'a.md', text: 'changed', baseVersion: version })).refusal?.code).toBe('guard-refused')
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('as it was')
    expect((await ask('luoshu.read', { path: 'a.md' })).result).toEqual({ text: 'as it was', version })
  })

  it('refuses a move a guard denies on either end and the remove of a guarded note, leaving every note, then moves past it', async () => {
    const folder = await notes()
    await writeFile(path.join(folder, 'held.md'), 'held')
    await writeFile(path.join(folder, 'free.md'), 'free')
    const asked: string[][] = []
    const { ask } = await joined(folder, {
      install: { leases: { files: filesFor(hostManifest('leases')) } },
      behave: { leases: { exports: { guard: { check: (call: GuardCall) => {
        const paths = call.scope.paths ?? []
        asked.push([...paths])
        return paths.includes('held.md') ? 'deny' : 'allow'
      } } } } },
      wire: { guardsFor: () => ['leases'] },
    })
    expect((await ask('luoshu.move', { from: 'held.md', to: 'moved.md' })).refusal?.code).toBe('guard-refused')
    expect((await ask('luoshu.move', { from: 'free.md', to: 'held.md' })).refusal?.code).toBe('guard-refused')
    expect((await ask('luoshu.remove', { path: 'held.md' })).refusal?.code).toBe('guard-refused')
    expect(await readFile(path.join(folder, 'held.md'), 'utf8')).toBe('held')
    expect(await readFile(path.join(folder, 'free.md'), 'utf8')).toBe('free')
    expect((await ask('luoshu.move', { from: 'free.md', to: 'kept.md' })).ok).toBe(true)
    expect(await readFile(path.join(folder, 'kept.md'), 'utf8')).toBe('free')
    expect(asked).toEqual([['held.md', 'moved.md'], ['free.md', 'held.md'], ['held.md'], ['free.md', 'kept.md']])
  })
})

// main hands the bin it builds on shell.trashItem through the wiring, and the luoshu removes nothing itself
describe('a remove through the bin main hands the core', () => {
  it('hands the bin the absolute path of the note and answers null', async () => {
    const folder = await notes()
    await writeFile(path.join(folder, 'a.md'), 'to the bin')
    const binned: string[] = []
    const bin = path.join(path.dirname(folder), 'bin')
    await mkdir(bin)
    const { ask } = await joined(folder, { wire: { trash: async absolute => {
      binned.push(absolute)
      await rename(absolute, path.join(bin, path.basename(absolute)))
    } } })
    expect(await ask('luoshu.remove', { path: 'a.md' })).toMatchObject({ ok: true, result: null })
    expect(binned).toEqual([path.join(await realpath(folder), 'a.md')])
    expect(await readFile(path.join(bin, 'a.md'), 'utf8')).toBe('to the bin')
  })

  it('fails the remove when the bin refuses and leaves the note', async () => {
    const folder = await notes()
    await writeFile(path.join(folder, 'a.md'), 'stays')
    const { ask } = await joined(folder, { wire: { trash: async () => { throw new Error('the bin refused') } } })
    expect((await ask('luoshu.remove', { path: 'a.md' })).refusal?.code).toBe('failed')
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('stays')
  })
})

// With the gate off by the human the carrier asks no one about a path, so the luoshu's canonical is the one check left
describe('the dot rule with the gate off by the human', () => {
  // A gate that throws at every question, so a call it would have to answer fails if the carrier asks it
  const asked = () => {
    throw new Error('the gate was asked')
  }
  const unasked = { gate: { exports: { gate: { decide: asked, canRead: asked, canList: asked, verbs: asked, stateChanged: asked } } } }

  async function dotted() {
    const folder = await notes()
    await mkdir(path.join(folder, '.obsidian', 'plugins', 'x'), { recursive: true })
    await mkdir(path.join(folder, 'journal'))
    await writeFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
    await writeFile(path.join(folder, 'journal', '.hidden.md'), 'hidden')
    await writeFile(path.join(folder, 'a.md'), 'note a')
    await symlink(path.join(folder, '.obsidian'), path.join(folder, 'cfg'), 'junction')
    // A remove past canonical would answer failed here, so not-granted shows canonical refused it
    const { ask } = await joined(folder, { gate: 'off', behave: unasked, wire: { trash: async () => { throw new Error('nothing goes to the bin') } } })
    return { folder, ask }
  }

  it('refuses either end of a move and a remove that names a dot folder or a dot file, a junction into one too', async () => {
    const { folder, ask } = await dotted()
    for (const to of ['.obsidian/a.md', '.obsidian/plugins/x/a.js', '.github/workflows/x.yml', 'journal/.config/a.md', 'journal/.a.md', '.a.md', 'cfg/a.md']) {
      expect((await ask('luoshu.move', { from: 'a.md', to })).refusal?.code, to).toBe('not-granted')
    }
    for (const from of ['.obsidian/plugins/x/main.js', 'journal/.hidden.md', 'cfg/plugins/x/main.js']) {
      expect((await ask('luoshu.move', { from, to: 'stolen.md' })).refusal?.code, from).toBe('not-granted')
      expect((await ask('luoshu.remove', { path: from })).refusal?.code, from).toBe('not-granted')
    }
    expect(await readFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
    expect(await readFile(path.join(folder, 'journal', '.hidden.md'), 'utf8')).toBe('hidden')
    expect(await readdir(path.join(folder, '.obsidian'))).toEqual(['plugins'])
    expect(await readdir(path.join(folder, 'journal'))).toEqual(['.hidden.md'])
    expect((await readdir(folder)).sort()).toEqual(['.obsidian', 'a.md', 'cfg', 'journal'])
    // A plain move goes through with the gate never asked
    expect((await ask('luoshu.move', { from: 'a.md', to: 'journal/a.md' })).ok).toBe(true)
    expect(await readFile(path.join(folder, 'journal', 'a.md'), 'utf8')).toBe('note a')
  })

  it('lists no dot file and nothing under a dot folder at any depth, and refuses listing a dot folder', async () => {
    const { folder, ask } = await dotted()
    await mkdir(path.join(folder, 'journal', 'deep', '.config'), { recursive: true })
    await writeFile(path.join(folder, 'journal', 'deep', '.config', 'x.md'), 'x')
    await writeFile(path.join(folder, 'journal', 'deep', 'b.md'), 'note b')
    await writeFile(path.join(folder, '.hidden.md'), 'hidden')
    // Every name passes canList with the gate off, so these are what the luoshu's walk found
    expect(await ask('luoshu.list', {})).toMatchObject({ ok: true, result: { paths: ['a.md', 'journal/deep/b.md'], next: null } })
    expect(await ask('luoshu.list', { folder: 'journal' })).toMatchObject({ ok: true, result: { paths: ['journal/deep/b.md'], next: null } })
    for (const at of ['.obsidian', 'cfg', 'journal/deep/.config']) {
      expect((await ask('luoshu.list', { folder: at })).refusal?.code, at).toBe('not-granted')
    }
  })
})

// The audit trail near 250 calls a second. The vault is a real one's size, 469 notes
// and about 4.2 MB, or a copy of a real one where HETU_BUDGET_LUOSHU names it
describe('indexing a vault through the carrier with the log on', () => {
  it('reads every note within its budget, and a save made halfway doesn\'t wait behind the reads', async () => {
    const folder = await notes()
    const real = process.env.HETU_BUDGET_LUOSHU
    if (real !== undefined) await cp(real, folder, { recursive: true, filter: source => !source.split(/[\\/]/).includes('.git') })
    else {
      const line = 'A line of a note about something worth keeping, with a [[link]] and some **bold** words in it.\n'
      for (let i = 0; i < 469; i++) {
        const dir = path.join(folder, `folder ${i % 23}`)
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, `note ${i}.md`), line.repeat(93))
      }
    }
    const { ask, carrier, dataDir } = await joined(folder)

    const started = performance.now()
    const listed: string[] = []
    for (let after: string | undefined; ;) {
      const page = (await ask('luoshu.list', after === undefined ? {} : { after })).result as { paths: string[], next: string | null }
      listed.push(...page.paths)
      if (page.next === null) break
      after = page.next
    }
    const md = listed.filter(name => name.endsWith('.md'))
    expect(md.length).toBeGreaterThanOrEqual(real === undefined ? 469 : 1)
    let saveMs = 0
    let at = 0
    const reader = async () => {
      while (at < md.length) {
        const mine = at++
        if (mine === Math.floor(md.length / 2)) {
          const saving = performance.now()
          const saved = await ask('luoshu.write', { path: 'hetu budget probe.md', text: 'saved halfway' })
          saveMs = performance.now() - saving
          expect(saved.ok).toBe(true)
        }
        const reply = await ask('luoshu.read', { path: md[mine] })
        expect(reply.ok).toBe(true)
      }
    }
    await Promise.all(Array.from({ length: 16 }, reader))
    const totalMs = performance.now() - started
    console.log(`budget: ${md.length} notes read in ${Math.round(totalMs)} ms, the save answered in ${Math.round(saveMs)} ms`)

    carrier.close()
    await carrier.flush()
    const written = await events(dataDir)
    expect(written.some(record => record.event === 'audit.call' && record.action === 'luoshu.write' && record.code === null)).toBe(true)
    expect(written.filter(record => record.event === 'audit.call' && record.action === 'luoshu.read').length).toBeGreaterThan(0)
    expect(totalMs).toBeLessThan(BUDGET_TOTAL_MS)
    expect(saveMs).toBeLessThan(BUDGET_SAVE_MS)
  }, 60_000)
})

// About 205 ms and 13 ms on the PC this was built on. The whole run within 2 s is past the 250 calls a second the case
// against feared, with room for a slower CI runner. A save within half a second while an index reads stays unnoticed
const BUDGET_TOTAL_MS = 2_000
const BUDGET_SAVE_MS = 500
