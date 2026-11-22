import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { START_HUNG } from '../api/actions.ts'
import type { Opening } from '../api/policy-jobs.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore } from '../backend/boot/state.ts'
import { createLock, type Lock } from '../backend/lock/lock.ts'
import { wireCore } from '../backend/wire.ts'
import { createLuoshu } from '../backend/providers/luoshu/luoshu.ts'
import {
  allowAll, coreInstall, entryFor, FakeRuntime, filesFor, tempBase, tick, workerManifest, writeFolder, writeInstall, type Half, type Message,
} from './plugins-manager-fakes.ts'

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

// The joined core over a real boot with the guards core/api expects, the real luoshu and lock unless lock is given, a
// gate that allows everything, a notes folder picked holding a.md and two folder plugins, alpha and beta. opened gets
// each folder the luoshu is handed
async function joined(options: { off?: string[], lock?: Lock, before?: (dataDir: string) => Promise<void>, opened?: Opening[] } = {}) {
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  const folder = path.join(base, 'notes')
  await mkdir(installDir, { recursive: true })
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, 'a.md'), 'as it was')
  await writeInstall(installDir, coreInstall())
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: (options.off ?? []) as never })
  await store.writeLuoshu({ folder })
  for (const id of ['alpha', 'beta']) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id)))
    await store.writePlugin(id, await entryFor(root))
  }
  await options.before?.(dataDir)
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const luoshu = createLuoshu()
  const opened = options.opened ?? []
  const watched = {
    ...luoshu,
    role: {
      open(opening: Opening) {
        opened.push(opening)
        luoshu.role.open(opening)
      },
    },
  }
  const runtime = new FakeRuntime()
  const modules = { gate: allowAll(), luoshu: watched, ...(options.lock !== undefined ? { lock: options.lock } : {}) }
  const parts = wireCore({ booted, installDir, runtime, modules, confirmDelayMs: 0 })
  open.push(async () => {
    luoshu.close()
    await parts.pluginsManager.shutdown().catch(() => {})
    parts.router.close()
    await parts.recording.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true })
  })
  await parts.pluginsManager.start()
  await parts.pluginsManager.settled()
  return { ...parts, runtime, folder, dataDir, opened }
}

let next = 1

// A call from a half with the envelope fields given and its reply
async function ask(half: Half, action: string, args: unknown, extra: object = {}): Promise<Message> {
  const id = 7000 + next++
  half.send({ v: 1, kind: 'call', id, action, args, ...extra })
  for (let waited = 0; waited < 3000; waited += 5) {
    const reply = half.inbox.find(message => message.kind === 'reply' && message.id === id)
    if (reply !== undefined) return reply
    await tick(5)
  }
  throw new Error(`no reply to ${action}`)
}

// A write of a.md over the text it holds now
async function write(half: Half, folder: string, text: string, extra: object = {}): Promise<Message> {
  const baseVersion = createHash('sha256').update(await readFile(path.join(folder, 'a.md'), 'utf8')).digest('hex')
  return ask(half, 'luoshu.write', { path: 'a.md', text, baseVersion }, extra)
}

// A call from the editor window through its way in and its reply
function windowAsk(router: Awaited<ReturnType<typeof joined>>['router'], action: string, args: unknown): Promise<Message> {
  const editor = { kind: 'window' as const, role: 'editor' as const, n: 1 }
  const receive = router.window<string>(sender => (sender === 'editor' ? editor : null))
  const id = 7000 + next++
  return new Promise(resolve => {
    receive('editor', { v: 1, kind: 'call', id, action, args }, message => {
      if ((message as Message).id === id) resolve(message as Message)
    })
  })
}

const refusal = (reply: Message) => (reply.refusal as { code: string } | undefined)?.code ?? 'ok'

// A lock module whose guard throws, as one that crashed in use, or whose folder throws once told to
function breaking(): Lock & { throws: boolean } {
  const real = createLock({ clock: () => performance.now() })
  const made = {
    throws: false,
    provider: real.provider,
    guard: { check: () => { throw new Error('the lock crashed') } },
    role: {
      open(opening: Opening) {
        if (made.throws) throw new Error('the lock crashed')
        real.role.open(opening)
      },
      release: () => real.role.release(),
    },
  }
  return made
}

describe('the lock module through the joined core', () => {
  it('answers locked to another plugin\'s write, remove and move of a note one plugin locked and lets the holder write', async () => {
    const { runtime, folder } = await joined()
    const alpha = runtime.half('alpha')
    const beta = runtime.half('beta')
    expect((await ask(alpha, 'lock.set', { paths: ['a.md'], ms: 60_000 })).result).toEqual({ ms: 60_000 })
    expect(refusal(await write(beta, folder, 'beta'))).toBe('locked')
    expect(refusal(await ask(beta, 'luoshu.remove', { path: 'a.md', baseVersion: '0'.repeat(64) }))).toBe('locked')
    expect(refusal(await ask(beta, 'luoshu.move', { from: 'a.md', to: 'b.md' }))).toBe('locked')
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('as it was')
    expect(refusal(await write(alpha, folder, 'alpha'))).toBe('ok')
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('alpha')
    expect((await ask(beta, 'lock.held', { paths: ['a.md', 'b.md'] })).result).toMatchObject({ paths: ['a.md'] })
    expect(refusal(await ask(alpha, 'lock.clear', { paths: ['a.md'] }))).toBe('ok')
    expect(refusal(await write(beta, folder, 'beta'))).toBe('ok')
  })

  // Each session under one root plugin holds its own locks
  it('answers locked to a write from another session of the plugin that locked the note', async () => {
    const { runtime, folder } = await joined()
    const alpha = runtime.half('alpha')
    expect(refusal(await ask(alpha, 'lock.set', { paths: ['a.md'], ms: 60_000 }, { onBehalf: 'client#1' }))).toBe('ok')
    expect(refusal(await write(alpha, folder, 'two', { onBehalf: 'client#2' }))).toBe('locked')
    expect(refusal(await write(alpha, folder, 'none'))).toBe('locked')
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('as it was')
    expect(refusal(await write(alpha, folder, 'one', { onBehalf: 'client#1' }))).toBe('ok')
  })

  // The human is the policy: the editor window's save answers locked and its clear frees any holder's lock
  it('answers locked to the editor window\'s save and lets the window take the note over in one clear', async () => {
    const { runtime, router, folder } = await joined()
    expect(refusal(await ask(runtime.half('alpha'), 'lock.set', { paths: ['a.md', 'b.md'], ms: 60_000 }, { onBehalf: 'client#1' }))).toBe('ok')
    const baseVersion = createHash('sha256').update('as it was').digest('hex')
    const save = () => windowAsk(router, 'luoshu.write', { path: 'a.md', text: 'human', baseVersion })
    expect((await save()).refusal).toEqual({ code: 'locked', action: 'luoshu.write' })
    expect(refusal(await windowAsk(router, 'lock.clear', { paths: ['a.md'] }))).toBe('ok')
    expect(refusal(await save())).toBe('ok')
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('human')
    const before = Date.now()
    const held = (await windowAsk(router, 'lock.held', { paths: ['a.md', 'b.md'] })).result as { paths: string[], until: number[] }
    expect(held.paths).toEqual(['b.md'])
    expect(held.until[0]).toBeGreaterThan(before + 50_000)
    expect(held.until[0]).toBeLessThanOrEqual(Date.now() + 60_000 + 1)
  })

  // The module's own publish as wireCore wires it, the gate here letting every plugin read every note
  it('tells a subscribed plugin each note locked, renewed and cleared with its end in wall time and no holder', async () => {
    const { runtime, router } = await joined()
    const alpha = runtime.half('alpha')
    const beta = runtime.half('beta')
    expect(refusal(await ask(alpha, 'events.subscribe', { topics: ['lock.changed'] }))).toBe('ok')
    const before = Date.now()
    expect(refusal(await ask(beta, 'lock.set', { paths: ['a.md', 'new.md'], ms: 60_000 }, { onBehalf: 'client#1' }))).toBe('ok')
    expect(refusal(await ask(beta, 'lock.set', { paths: ['a.md'], ms: 120_000 }, { onBehalf: 'client#1' }))).toBe('ok')
    expect(refusal(await windowAsk(router, 'lock.clear', { paths: ['a.md'] }))).toBe('ok')
    const told = () => alpha.inbox.filter(message => message.kind === 'event' && message.topic === 'lock.changed')
    for (let waited = 0; told().length < 4 && waited < 3000; waited += 5) await tick(5)
    const after = Date.now()
    const events = told()
    expect(events.map(({ path, locked }) => [path, locked])).toEqual([['a.md', true], ['new.md', true], ['a.md', true], ['a.md', false]])
    expect(events.map(event => Object.keys(event).sort())).toEqual(Array(4).fill(['kind', 'locked', 'path', 'seq', 'topic', 'until', 'v']))
    const ends = events.map(event => event.until as number | null)
    for (const [i, ms] of [[0, 60_000], [1, 60_000], [2, 120_000]]) {
      expect(ends[i]).toBeGreaterThanOrEqual(before + ms - 1)
      expect(ends[i]).toBeLessThanOrEqual(after + ms + 1)
    }
    expect(ends[3]).toBeNull()
    expect(JSON.stringify(events)).not.toMatch(/client|beta/)
  })

  it('lets every write past with the lock switched off, as if its step did not exist', async () => {
    const { runtime, pluginsManager, folder } = await joined({ off: ['lock'], lock: breaking() })
    expect(pluginsManager.stopped()).toBe(null)
    expect(pluginsManager.policyJob('lock')).toBe('off')
    expect(refusal(await ask(runtime.half('alpha'), 'lock.set', { paths: ['a.md'], ms: 60_000 }))).toBe('unavailable')
    expect(refusal(await write(runtime.half('beta'), folder, 'beta'))).toBe('ok')
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('beta')
  })

  it('refuses every write guard-down when the lock\'s guard throws in use, leaving the note', async () => {
    const { runtime, folder } = await joined({ lock: breaking() })
    expect(refusal(await write(runtime.half('beta'), folder, 'beta'))).toBe('guard-down')
    expect(refusal(await ask(runtime.half('beta'), 'luoshu.move', { from: 'a.md', to: 'b.md' }))).toBe('guard-down')
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('as it was')
  })

  it('refuses every write once the lock failed in use, though no lock is held', async () => {
    const lock = breaking()
    lock.guard.check = () => 'allow' as never
    const { runtime, modules, folder } = await joined({ lock })
    lock.throws = true
    modules.picked()
    expect(modules.state('lock')).toBe('failed')
    expect(refusal(await write(runtime.half('beta'), folder, 'beta'))).toBe('guard-down')
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('as it was')
  })

  it('starts the lock with the fail-safe controls, its start marker on disk and before the luoshu is handed its folder', async () => {
    const lock = breaking()
    lock.guard.check = () => 'allow' as never
    const seen: { marked: boolean, luoshuOpened: number }[] = []
    const opened: Opening[] = []
    let dataDir = ''
    const open = lock.role.open
    lock.role.open = opening => {
      seen.push({ marked: existsSync(path.join(dataDir, 'starting', 'lock')), luoshuOpened: opened.length })
      open(opening)
    }
    const made = await joined({ lock, opened, before: async data => { dataDir = data } })
    expect(opened).toHaveLength(1)
    expect(seen[0]).toEqual({ marked: true, luoshuOpened: 0 })
    expect(existsSync(path.join(made.dataDir, 'starting', 'lock'))).toBe(false)
    expect(made.pluginsManager.stopped()).toBe(null)
  })

  it('stops hetu in the fail-safe naming the lock when its start fails, no other module begun and no plugin started', async () => {
    const lock = breaking()
    lock.throws = true
    const { pluginsManager, runtime, modules, opened } = await joined({ lock })
    expect(pluginsManager.stopped()).toEqual({ control: 'lock', why: 'start-failed', reason: 'state-changed', again: false })
    expect(opened).toEqual([])
    expect(modules.state('luoshu')).not.toBe('on')
    expect(runtime.order()).toEqual([])
  })

  it('stops hetu in the fail-safe naming the lock when the run before left its start marker', async () => {
    const { pluginsManager, runtime, opened } = await joined({
      before: async dataDir => {
        await mkdir(path.join(dataDir, 'starting'), { recursive: true })
        await writeFile(path.join(dataDir, 'starting', 'lock'), '')
      },
    })
    expect(pluginsManager.stopped()).toEqual({ control: 'lock', why: 'start-failed', reason: START_HUNG, again: false })
    expect(opened).toEqual([])
    expect(runtime.order()).toEqual([])
  })
})
