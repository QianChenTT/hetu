import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Call, Prepared } from '../api/policy-jobs.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore, type Plugin } from '../backend/boot/state.ts'
import { wireCore } from '../backend/wire.ts'
import { createGate } from '../backend/policy/gate/gate.ts'
import { createLuoshu } from '../backend/providers/luoshu/luoshu.ts'
import { luoshuModule } from './modules-fakes.ts'
import { coreInstall, entryFor, FakeRuntime, filesFor, tempBase, tick, workerManifest, writeFolder, writeInstall, type Message } from './plugins-manager-fakes.ts'

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close()
})

// A folder renamed under the luoshu's watch, which can hold it open for a moment on Windows
async function renamed(from: string, to: string): Promise<void> {
  for (let wait = 10; ; wait *= 2) {
    try {
      return await rename(from, to)
    } catch (err) {
      if (!['EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '') || wait > 1280) throw err
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
}

const grants = (...paths: string[]) => (['luoshu.read', 'luoshu.write', 'luoshu.list'] as const).map(type => ({ type, paths }))
const labelOf = (action: string, args: unknown) => `${action} ${JSON.stringify(args)}`

type Reply = { ok?: boolean, result?: { text?: string, path?: string, paths?: string[] }, refusal?: { code: string } }
const replyOf = (message: Message | null) => message as Reply | null

// The joined core over a real boot with the gate and the luoshu as they ship, each plugin granted read, write and list
// on the paths given. Around the luoshu's provider: what happens on the disk before a call named by its action and
// arguments is performed and when a call's prepare and perform have ended
async function world(granted: Record<string, string[]>) {
  const base = await tempBase()
  const folder = path.join(await realpath(base), 'notes')
  await mkdir(path.join(folder, '.obsidian'), { recursive: true })
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  await mkdir(installDir, { recursive: true })
  await writeInstall(installDir, coreInstall())
  const store = new StateStore(dataDir)
  // The grant risk classifier off, so no item of a class 4 plugin asks at first use and the path alone is judged
  await store.writeSwitches({ ...defaultSwitches(), off: ['grant-risk-classifier'] })
  for (const [id, paths] of Object.entries(granted)) {
    const items = grants(...paths)
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, { capabilities: items }) as never))
    await store.writePlugin(id, await entryFor(root, { granted: items, class: 4 } as Partial<Plugin>))
  }
  await store.writeLuoshu({ folder })
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const runtime = new FakeRuntime()
  const luoshu = createLuoshu({ settleMs: 50 })
  const before = new Map<string, () => Promise<void>>()
  const happened = new Set<string>()
  const waiting = new Map<string, (() => void)[]>()
  const signal = (name: string) => {
    happened.add(name)
    for (const wake of waiting.get(name) ?? []) wake()
    waiting.delete(name)
  }
  const when = (name: string) => happened.has(name) ? Promise.resolve() : new Promise<void>(resolve => {
    waiting.set(name, [...(waiting.get(name) ?? []), resolve])
  })
  const provider = {
    prepare: async (call: Call) => {
      const given = await luoshu.provider.prepare(call)
      signal(`prepared ${labelOf(call.action, call.args)}`)
      return given
    },
    release: luoshu.provider.release,
    perform: async (call: Call, prepared: Prepared) => {
      const label = labelOf(call.action, call.args)
      const hook = before.get(label)
      before.delete(label)
      await hook?.()
      try {
        return await luoshu.provider.perform(call, prepared)
      } finally {
        signal(`performed ${label}`)
      }
    },
  }
  const modules = { gate: createGate(), luoshu: luoshuModule(provider, luoshu.role) }
  const { pluginsManager, carrier } = wireCore({ booted, installDir, runtime, modules, confirmDelayMs: 0, debug: () => {} } as never)
  const junctions: string[] = []
  open.push(async () => {
    luoshu.close()
    await pluginsManager.shutdown().catch(() => {})
    carrier.close()
    await carrier.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    // A junction first, so the removal never follows one into the folder it leads to
    for (const junction of junctions) await rmdir(junction).catch(() => {})
    await rm(base, { recursive: true, force: true })
  })
  await pluginsManager.start()
  await pluginsManager.settled()
  const ask = (id: string, action: string, args: unknown) => runtime.half(id).ask(action, args, 5000).then(replyOf)
  const at = (...names: string[]) => path.join(folder, ...names)
  // Another program swaps a folder for a junction to the folder given and puts it back
  const swap = (name: string, target: string) => async () => {
    await renamed(at(name), at(`${name}-was`))
    await symlink(at(target), at(name), 'junction')
    junctions.push(at(name))
  }
  const unswap = async (name: string) => {
    await rmdir(at(name))
    junctions.splice(junctions.indexOf(at(name)), 1)
    await renamed(at(`${name}-was`), at(name))
  }
  return { folder, at, ask, before, when, swap, unswap }
}

const names = async (dir: string) => (await readdir(dir)).sort()
const notGranted = { ok: false, refusal: { code: 'not-granted' } }

describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('a folder made under another case while a call waits', () => {
  it('refuses a read by a plugin granted one case of the folder a write is making under the other case while the read waits on its lock', async () => {
    const { ask, before } = await world({ alpha: ['**'], beta: ['box*/**'] })
    const write = { path: 'Box7/n.md', text: 'ALPHA NOTE' }
    let read: Promise<Reply | null> = Promise.resolve(null)
    // The read is sent while the write holds the key, so its prepare resolves box7 before the folder is made
    before.set(labelOf('luoshu.write', write), async () => {
      read = ask('beta', 'luoshu.read', { path: 'box7/n.md' })
      await tick(60)
    })
    expect((await ask('alpha', 'luoshu.write', write))?.ok).toBe(true)
    expect(await read).toMatchObject(notGranted)
    // As the gate answers when asked about the folder as it is now
    expect(await ask('beta', 'luoshu.read', { path: 'box7/n.md' })).toMatchObject(notGranted)
  })

  it('gives no read sent beside a write that makes the folder under another case the note the write made', async () => {
    const { ask } = await world({ alpha: ['**'], beta: ['box*/**'] })
    const answers: string[] = []
    for (let i = 0; i < 25; i++) {
      const writing = ask('alpha', 'luoshu.write', { path: `Box${i}/n.md`, text: `ALPHA NOTE ${i}` })
      const reads = await Promise.all([0, 1, 2, 3].map(() => ask('beta', 'luoshu.read', { path: `box${i}/n.md` })))
      expect((await writing)?.ok).toBe(true)
      for (const read of reads) answers.push(read?.ok === true ? `ok ${read.result?.path}` : read?.refusal?.code ?? 'no reply')
    }
    expect(answers.filter(answer => answer.startsWith('ok'))).toEqual([])
  }, 30000)

  it('refuses a write into a new folder by a plugin granted the case the folder was not made in, when the two writes are sent together', async () => {
    const { at, ask, before, when } = await world({ alpha: ['Inbox/**'], beta: ['inbox/**'] })
    const mine = { path: 'Inbox/a.md', text: 'alpha note' }
    const theirs = { path: 'inbox/b.md', text: 'beta note' }
    let second: Promise<Reply | null> = Promise.resolve(null)
    // beta's write is prepared before alpha's makes the folder, as when both are sent at once, then performed after it
    // The wait for its prepare is bounded, since a provider may hold that prepare until the folder is made
    before.set(labelOf('luoshu.write', mine), async () => {
      second = ask('beta', 'luoshu.write', theirs)
      await Promise.race([when(`prepared ${labelOf('luoshu.write', theirs)}`), tick(300)])
    })
    before.set(labelOf('luoshu.write', theirs), () => when(`performed ${labelOf('luoshu.write', mine)}`))
    expect((await ask('alpha', 'luoshu.write', mine))?.ok).toBe(true)
    expect(await second).toMatchObject(notGranted)
    expect(await names(at('Inbox'))).toEqual(['a.md'])
    expect(await ask('alpha', 'luoshu.read', { path: 'Inbox/a.md' })).toMatchObject({ ok: true, result: { text: 'alpha note', path: 'Inbox/a.md' } })
  })

  it('writes both notes when the plugin holds every spelling, sent together into a new folder spelled in two cases', async () => {
    const { at, ask, before, when } = await world({ alpha: ['**'] })
    const mine = { path: 'Inbox/a.md', text: 'one' }
    const theirs = { path: 'inbox/b.md', text: 'two' }
    let second: Promise<Reply | null> = Promise.resolve(null)
    before.set(labelOf('luoshu.write', mine), async () => {
      second = ask('alpha', 'luoshu.write', theirs)
      await Promise.race([when(`prepared ${labelOf('luoshu.write', theirs)}`), tick(300)])
    })
    before.set(labelOf('luoshu.write', theirs), () => when(`performed ${labelOf('luoshu.write', mine)}`))
    expect((await ask('alpha', 'luoshu.write', mine))?.ok).toBe(true)
    expect((await second)?.ok).toBe(true)
    expect(await names(at('Inbox'))).toEqual(['a.md', 'b.md'])
    expect(await ask('alpha', 'luoshu.read', { path: 'Inbox/b.md' })).toMatchObject({ ok: true, result: { text: 'two', path: 'Inbox/b.md' } })
  })

  it('writes every note sent together into new folders spelled in several cases by a plugin holding every spelling', async () => {
    const { ask } = await world({ alpha: ['**'] })
    for (const paths of [['Inbox/a.md', 'inbox/b.md'], ['Area/Sub/a.md', 'area/sub/b.md', 'AREA/SUB/c.md']]) {
      const replies = await Promise.all(paths.map(at => ask('alpha', 'luoshu.write', { path: at, text: 'x' })))
      expect(replies.map(reply => reply?.ok)).toEqual(paths.map(() => true))
    }
  })

  it('reads a note whose folder another program renamed in case after prepare for a plugin holding both spellings', async () => {
    const { at, ask, before } = await world({ alpha: ['**'] })
    await mkdir(at('plain'))
    await writeFile(at('plain', 'b.md'), 'note b')
    before.set(labelOf('luoshu.read', { path: 'plain/b.md' }), () => renamed(at('plain'), at('Plain')))
    expect(await ask('alpha', 'luoshu.read', { path: 'plain/b.md' })).toMatchObject({ ok: true, result: { text: 'note b', path: 'Plain/b.md' } })
  })

  it('refuses a read of a note whose folder another program renamed in case after prepare to a plugin granted the old case only', async () => {
    const { at, ask, before } = await world({ alpha: ['plain/**'] })
    await mkdir(at('plain'))
    await writeFile(at('plain', 'b.md'), 'note b')
    before.set(labelOf('luoshu.read', { path: 'plain/b.md' }), () => renamed(at('plain'), at('Plain')))
    expect(await ask('alpha', 'luoshu.read', { path: 'plain/b.md' })).toMatchObject(notGranted)
  })
})

// Folders NTFS keeps apart whose paths give one key. Elsewhere the pairs are one name or the junction can't be made
describe.runIf(process.platform === 'win32')('a folder swapped for a junction to a sibling of the same key after the gate answered', () => {
  const pairs: [granted: string, sibling: string][] = [
    ['stra\u00dfe', 'strasse'],
    ['caf\u00e9', 'cafe\u0301'],
    ['pub', 'pub\u200d'],
    ['kelvin', '\u212aelvin'],
  ]

  it.each(pairs)('refuses a read, a write and both ends of a move under %s swapped for a junction to %s', async (granted, sibling) => {
    const { at, ask, before, swap, unswap } = await world({ alpha: [`${granted}/**`, 'plain/**'] })
    for (const dir of [granted, sibling, 'plain']) await mkdir(at(dir))
    await writeFile(at(granted, 'b.md'), 'granted b')
    await writeFile(at(sibling, 'b.md'), 'SIBLING SECRET')
    await writeFile(at(sibling, 'only-here.md'), 'SIBLING ONLY')
    await writeFile(at('plain', 'a.md'), 'plain a')
    // The gate refuses the sibling when asked about it
    expect(await ask('alpha', 'luoshu.read', { path: `${sibling}/b.md` })).toMatchObject(notGranted)
    const tries: [string, unknown][] = [
      ['luoshu.read', { path: `${granted}/b.md` }],
      ['luoshu.write', { path: `${granted}/planted.md`, text: 'PLANTED' }],
      ['luoshu.write', { path: `${granted}/new/deep/planted.md`, text: 'PLANTED' }],
      ['luoshu.move', { from: `${granted}/only-here.md`, to: 'plain/taken.md' }],
      ['luoshu.move', { from: 'plain/a.md', to: `${granted}/landed.md` }],
    ]
    for (const [action, args] of tries) {
      before.set(labelOf(action, args), swap(granted, sibling))
      const reply = await ask('alpha', action, args)
      await unswap(granted)
      expect({ action, args, reply }).toMatchObject({ reply: notGranted })
      expect(await names(at(sibling))).toEqual(['b.md', 'only-here.md'])
      expect(await names(at('plain'))).toEqual(['a.md'])
    }
    expect(await readFile(at(sibling, 'b.md'), 'utf8')).toBe('SIBLING SECRET')
  })
})
