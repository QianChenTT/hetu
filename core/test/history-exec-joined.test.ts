import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore, type Switches } from '../backend/boot/state.ts'
import { wireCore } from '../backend/wire.ts'
import { createExec } from '../../plugins/exec/src/exec.ts'
import { createGate } from '../../plugins/gate/src/gate.ts'
import { createHistory } from '../../plugins/history/src/history.ts'
import { createLuoshu } from '../../plugins/luoshu/src/luoshu.ts'
import { coreInstall, entryFor, FakeRuntime, filesFor, hostManifest, tempBase, until, workerManifest, writeFolder, writeInstall } from './loader-fakes.ts'

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

type Reply = { id?: number, ok?: boolean, result?: unknown, refusal?: { code: string } }
type Folder = { id: string, granted: Capability[] }

// A command exec runs: hetu's own node by its real path, writing what it is given
const node = process.execPath
const say = (text: string) => [node, '-e', `process.stdout.write(${JSON.stringify(text)})`]

// The joined core over a real boot with the gate, the luoshu, history and exec as they ship, the notes folder picked and
// folder plugins with entries in the state, each a fake worker whose calls go through the real carrier
async function joined(folders: Folder[], switches: Partial<Switches> = {}) {
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  const folder = path.join(base, 'notes')
  await mkdir(installDir, { recursive: true })
  await mkdir(folder, { recursive: true })
  await writeInstall(installDir, {
    ...coreInstall(),
    luoshu: { files: filesFor(hostManifest('luoshu')) },
    history: { files: filesFor(hostManifest('history', { requires: ['luoshu'] })) },
    exec: { files: filesFor(hostManifest('exec')) },
  })
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), ...switches })
  await store.writeLuoshu({ folder })
  for (const plugin of folders) {
    const root = path.join(dataDir, 'plugins', plugin.id)
    await writeFolder(root, filesFor(workerManifest(plugin.id, { capabilities: plugin.granted })))
    await store.writePlugin(plugin.id, await entryFor(root, { granted: plugin.granted, class: 4 }))
  }
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const luoshu = createLuoshu()
  const history = createHistory()
  const exec = createExec()
  await history.start(dataDir)
  await exec.start(dataDir)
  const runtime = new FakeRuntime()
  runtime.behave = {
    gate: { exports: { gate: createGate() } },
    luoshu: { exports: { provider: luoshu.provider, luoshu: luoshu.role } },
    history: { exports: { provider: history.provider, history: history.role } },
    exec: { exports: { provider: exec.provider, exec: exec.role } },
  }
  const { loader, carrier } = wireCore({ booted, installDir, runtime, confirmDelayMs: 0 })
  open.push(async () => {
    luoshu.close()
    history.close()
    exec.close()
    await loader.shutdown().catch(() => {})
    carrier.close()
    await carrier.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true })
  })
  await loader.start()
  await loader.settled()
  for (const plugin of folders) await until(() => loader.plugin(plugin.id)?.state === 'ready')

  const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
  const waiting = new Map<number, (reply: Reply) => void>()
  const receive = carrier.window<string>(sender => (sender === 'editor' ? editor : null))
  let next = 1
  const window = (action: string, args?: unknown) => new Promise<Reply>(resolve => {
    const id = next++
    waiting.set(id, resolve)
    receive('editor', { v: 1, kind: 'call', id, action, args }, message => {
      const reply = message as Reply
      if (typeof reply.id !== 'number') return
      waiting.get(reply.id)?.(reply)
      waiting.delete(reply.id)
    })
  })
  // A call from a folder plugin's worker, its reply within the deadline a command needs
  const plugin = async (id: string, action: string, args: unknown) => (await runtime.half(id).ask(action, args, 15_000)) as Reply | null
  return { loader, carrier, dataDir, folder, window, plugin }
}

const exists = (file: string) => stat(file).then(() => true, () => false)

describe('exec through the joined core', () => {
  const listed = say('listed')
  const runner = { id: 'runner', granted: [{ type: 'exec', commands: [listed], env: [] }] as Capability[] }

  it('runs a listed command for the plugin that holds it and refuses one it doesn\'t list, gate on', async () => {
    const { plugin } = await joined([runner])
    expect((await plugin('runner', 'exec.run', { command: listed }))?.result).toEqual({ code: 0, signal: null, stdout: 'listed', stderr: '', truncated: false })
    expect((await plugin('runner', 'exec.run', { command: say('other') }))?.refusal?.code).toBe('not-granted')
  })

  // Decision 11: with the gate off exec's own check is what holds the list
  it('with the gate off still runs only the exact command listed, argument for argument', async () => {
    const { plugin, dataDir } = await joined([runner], { off: ['gate'] })
    const marker = path.join(path.dirname(dataDir), 'ran')
    const planted = [node, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`]
    expect((await plugin('runner', 'exec.run', { command: listed }))?.result).toMatchObject({ code: 0, stdout: 'listed' })
    for (const command of [planted, [...listed, 'extra'], listed.slice(0, 2), [listed.join(' ')]]) {
      expect((await plugin('runner', 'exec.run', { command }))?.refusal?.code).toBe('not-granted')
    }
    expect(await exists(marker)).toBe(false)
  })

  it('with the gate off refuses a plugin that holds no exec item at all', async () => {
    const { plugin } = await joined([runner, { id: 'reader', granted: [{ type: 'luoshu.read', paths: ['**'] }] }], { off: ['gate'] })
    expect((await plugin('reader', 'exec.run', { command: listed }))?.refusal?.code).toBe('not-granted')
  })

  it('lifts the list for a plugin the human let run any command, gate on and off, and for no other plugin', async () => {
    const other = { id: 'other', granted: [{ type: 'exec', commands: [say('mine')], env: [] }] as Capability[] }
    for (const off of [[], ['gate']] as Switches['off'][]) {
      const { plugin } = await joined([runner, other], { off, execAnyCommand: ['runner'] })
      expect((await plugin('runner', 'exec.run', { command: say('unlisted') }))?.result, `gate off: ${off.length > 0}`).toMatchObject({ code: 0, stdout: 'unlisted' })
      expect((await plugin('other', 'exec.run', { command: say('unlisted') }))?.refusal?.code).toBe('not-granted')
    }
  })

  it('refuses the editor window, which holds no exec', async () => {
    const { window } = await joined([runner], { off: ['gate'] })
    expect((await window('exec.run', { command: listed })).refusal?.code).toBe('not-granted')
  })
})

describe('history through the joined core', () => {
  const keeper = { id: 'keeper', granted: [{ type: 'history', access: 'commit', paths: ['**'] }] as Capability[] }
  const reader = { id: 'reader', granted: [{ type: 'history', access: 'read', paths: ['**'] }] as Capability[] }
  const narrow = { id: 'narrow', granted: [{ type: 'history', access: 'commit', paths: ['daily/**'] }] as Capability[] }

  it('commits for a plugin holding history commit, and the editor window reads the log and the note as it was', async () => {
    const { plugin, window, folder } = await joined([keeper])
    await writeFile(path.join(folder, 'a.md'), 'first')
    const made = (await plugin('keeper', 'history.commit', { paths: ['a.md'], message: 'Keep a' }))?.result as { commit: string }
    expect(made.commit).toMatch(/^[0-9a-f]{40}$/)
    await writeFile(path.join(folder, 'a.md'), 'second')
    const log = (await window('history.log', { path: 'a.md' })).result as { commits: { commit: string, message: string }[] }
    expect(log.commits.map(entry => [entry.commit, entry.message])).toEqual([[made.commit, 'Keep a']])
    expect((await window('history.read', { path: 'a.md', commit: made.commit })).result).toMatchObject({ text: 'first' })
  })

  it('refuses a commit to a plugin that holds only history read, and one outside the paths a commit item names', async () => {
    const { plugin, folder } = await joined([reader, narrow])
    await writeFile(path.join(folder, 'a.md'), 'text')
    expect((await plugin('reader', 'history.commit', { paths: ['a.md'], message: 'm' }))?.refusal?.code).toBe('not-granted')
    expect((await plugin('narrow', 'history.commit', { paths: ['a.md'], message: 'm' }))?.refusal?.code).toBe('not-granted')
    expect((await plugin('reader', 'history.log', { path: 'a.md' }))?.result).toEqual({ commits: [] })
  })

  it('refuses the editor window a commit, since it holds only history read', async () => {
    const { window, folder } = await joined([])
    await writeFile(path.join(folder, 'a.md'), 'text')
    expect((await window('history.commit', { paths: ['a.md'], message: 'm' })).refusal?.code).toBe('not-granted')
  })

  it('keeps its repo under the data folder and never writes into the notes folder', async () => {
    const { plugin, folder, dataDir } = await joined([keeper])
    await writeFile(path.join(folder, 'a.md'), 'text')
    expect((await plugin('keeper', 'history.commit', { paths: ['a.md'], message: 'm' }))?.result).toMatchObject({ commit: expect.any(String) })
    expect(await exists(path.join(folder, '.git'))).toBe(false)
    expect(await exists(path.join(dataDir, 'host', 'history'))).toBe(true)
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('text')
  })
})
