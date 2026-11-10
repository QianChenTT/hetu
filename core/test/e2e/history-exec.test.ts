import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore, type Switches } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../loader-fakes.ts'
import { cleanup, editorPage, exists, launch, logged, records, temp, until, workersPage } from './helpers.ts'

// History and exec as the install ships them, called by a folder plugin's worker and by the editor window

afterEach(cleanup)

const git = promisify(execFile)
const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// A worker that keeps its ctx where a test can reach it
const fixture = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    (globalThis as Record<string, unknown>).ctx = ctx
  },
})
`

const node = process.execPath
const say = (text: string) => [node, '-e', `process.stdout.write(${JSON.stringify(text)})`]

type Outcome = { ok: boolean, result?: unknown, code?: string }

async function started(setup: { notes?: Record<string, string>, plugins: Record<string, Capability[]>, switches?: Partial<Switches> }) {
  const folder = await temp()
  for (const [name, text] of Object.entries(setup.notes ?? {})) await writeFile(path.join(folder, name), text)
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: [], ...setup.switches })
  await store.writeLuoshu({ folder })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': fixture })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  for (const [id, granted] of Object.entries(setup.plugins)) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, { capabilities: granted }), { 'worker.js': built!.text }))
    await store.writePlugin(id, await entryFor(root, { granted, class: 4 }))
  }
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  for (const id of ['luoshu', 'history', 'exec', ...Object.keys(setup.plugins)]) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  return { app, editor, dataDir, folder }
}

async function pluginWorker(app: ElectronApplication, id: string): Promise<Worker> {
  const page = await workersPage(app, id)
  await until(() => page.workers().length === 1)
  return page.workers()[0] as Worker
}

// One of ctx's typed calls from the plugin's worker, as its result or the code it was refused with
const call = (worker: Worker, action: string, args: unknown) => worker.evaluate(async ([action, args]) => {
  const [space, verb] = action.split('.')
  const ctx = (globalThis as unknown as { ctx: Record<string, Record<string, (args: unknown) => Promise<unknown>>> }).ctx
  try {
    return { ok: true, result: await ctx[space][verb](args) }
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code }
  }
}, [action, args] as const) as Promise<Outcome>

let next = 9000
// A call through the editor window's bridge
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    const reply = message as { kind?: string, id?: number }
    if (reply.kind === 'reply' && reply.id === id) resolve(reply)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [next++, action, args] as const) as Promise<{ ok: boolean, result?: unknown, refusal?: { code: string } }>

describe('history in the install', () => {
  it('commits a note for a plugin holding history commit, the editor window reads its log and the old text, and a program planted in the notes folder\'s git config never runs', async () => {
    const keeper: Capability[] = [{ type: 'history', access: 'commit', paths: ['**'] }]
    const { app, editor, folder, dataDir } = await started({ notes: { 'a.md': 'first' }, plugins: { keeper } })
    // A-11: the notes folder is a repo whose config names a program for git to run on every status and add
    const marker = path.join(await temp(), 'fired.txt')
    const plant = path.join(path.dirname(marker), 'plant.cjs')
    await writeFile(plant, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'fired')\n`)
    const slashes = (file: string) => file.split(path.sep).join('/')
    await git('git', ['init', '-q'], { cwd: folder })
    await git('git', ['config', 'core.fsmonitor', `'${slashes(node)}' '${slashes(plant)}'`], { cwd: folder })

    const worker = await pluginWorker(app, 'keeper')
    const made = await call(worker, 'history.commit', { paths: ['a.md'], message: 'Keep a' })
    expect(made.ok).toBe(true)
    const { commit } = made.result as { commit: string }
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    await writeFile(path.join(folder, 'a.md'), 'second')

    const log = await ask(editor, 'history.log', { path: 'a.md' })
    expect((log.result as { commits: { commit: string, committer: string }[] }).commits.map(entry => [entry.commit, entry.committer])).toEqual([[commit, 'keeper']])
    expect((await ask(editor, 'history.read', { path: 'a.md', commit })).result).toMatchObject({ text: 'first' })
    expect((await ask(editor, 'history.commit', { paths: ['a.md'], message: 'm' })).refusal?.code).toBe('not-granted')
    expect(await exists(marker)).toBe(false)

    // The plant is real: plain git in the folder runs it
    await git('git', ['status'], { cwd: folder })
    expect(await readFile(marker, 'utf8')).toBe('fired')
    expect(await exists(path.join(dataDir, 'host', 'history'))).toBe(true)
  })
})

describe('exec in the install', () => {
  it('with the gate off runs the exact command a plugin listed and refuses one it didn\'t, recording both', async () => {
    const listed = say('listed')
    const runner: Capability[] = [{ type: 'exec', commands: [listed], env: [] }]
    const { app, dataDir } = await started({ plugins: { runner }, switches: { off: ['gate'] } })
    const worker = await pluginWorker(app, 'runner')
    expect(await call(worker, 'exec.run', { command: listed })).toEqual({ ok: true, result: { code: 0, signal: null, stdout: 'listed', stderr: '', truncated: false } })
    expect(await call(worker, 'exec.run', { command: say('unlisted') })).toEqual({ ok: false, code: 'not-granted' })
    await until(async () => (await records(dataDir)).filter(record => record.action === 'exec.run').length >= 2)
    const runs = (await records(dataDir)).filter(record => record.action === 'exec.run')
    expect(runs.map(record => [record.command, record.code, record.gate])).toEqual([
      [JSON.stringify(listed), null, 'off'],
      [JSON.stringify(say('unlisted')), 'not-granted', 'off'],
    ])
  })
})
