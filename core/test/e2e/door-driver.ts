import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import type { StateStore } from '../../backend/boot/state.ts'
import { buildHost, buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeApproved, writeDoor, writeFolder } from '../plugins-manager-fakes.ts'
import { editorPage, launch, logged, temp, until, workersPage } from './helpers.ts'

// A fake door driven through door.handle, its only way to a plugin. The fake door, once door.handle is held, calls it
// with a body reporting what it did last, and the holder answers with the next command the test queued. Nothing calls
// into the door, whose record provides no action

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// The folder plugin holding door.handle that drives the fake door
export const HOLDER = 'holder'

// The holder's worker: each body the door sends is kept as a report with the caller and onBehalf the router delivered,
// and the answer is the next queued command, held up to a second while none waits and never taken for a call already
// given up. The queue and the reports sit on globalThis for the test
const holder = `
import { definePlugin } from '${sdk}'
const queue: unknown[] = []
const reports: unknown[] = []
let waiting: (() => void)[] = []
;(globalThis as Record<string, unknown>).door = {
  send(command: unknown) {
    queue.push(command)
    for (const wake of waiting.splice(0)) wake()
  },
  reports,
}
export default definePlugin({
  start(ctx) {
    ctx.provide('door.handle', async (call, args) => {
      const { body } = args as { body: string }
      reports.push({ caller: call.caller, onBehalf: call.onBehalf ?? null, ...JSON.parse(body) })
      if (queue.length === 0) {
        await new Promise<void>(resolve => {
          const wake = () => resolve()
          waiting.push(wake)
          setTimeout(() => {
            waiting = waiting.filter(one => one !== wake)
            resolve()
          }, 1000)
        })
      }
      const next = call.signal.aborted ? undefined : queue.shift()
      return { status: 200, body: JSON.stringify(next ?? {}) }
    })
  },
})
`

// A fake door's source: commands is an object literal of async functions (ctx, args), each answering a result or
// throwing a refusal. imports go at the top. Each report carries the door's incarnation, the command's number and its
// result or its refusal's code. A door.handle call that fails is tried again after 200 ms with the same report and the
// refusal's code added to its handleRefused, so the holder keeps every refusal of the role for the test to see
export const fakeDoor = (commands: string, imports = '') => `
import { definePlugin } from '${sdk}'
${imports}
const commands = ${commands}
const settled = work => work.then(result => ({ result }), error => ({ refused: error?.code ?? String(error) }))
export default definePlugin({
  start(ctx) {
    let report = { ready: true }
    let running = false
    const loop = async () => {
      if (running) return
      running = true
      while (ctx.has('door.handle')) {
        let answer
        try {
          answer = await ctx.call('door', 'handle', { body: JSON.stringify({ incarnation: ctx.incarnation, ...report }), headers: {} }, { onBehalf: '${HOLDER}#1' })
        } catch (error) {
          report = { ...report, handleRefused: [...(report.handleRefused ?? []), error?.code ?? String(error)] }
          await new Promise(resolve => setTimeout(resolve, 200))
          continue
        }
        const { n, name, args } = JSON.parse(answer.body)
        report = n === undefined ? {} : { n, ...(await settled(Promise.resolve().then(() => commands[name](ctx, args)))) }
      }
      running = false
    }
    ctx.onDeps(() => { void loop() })
    void loop()
  },
})
`

// An install folder holding the fake door built from source in place of the shipped one. node names the node modules
// it imports
export async function installDoor(source: string, node: readonly string[] = []): Promise<string> {
  const dir = await temp()
  const root = await temp()
  await writeFolder(root, { 'src/host.ts': source })
  const built = await buildHost(root, 'src/host.ts', node)
  await writeDoor(dir, built.text)
  return dir
}

// Writes the holder into dataDir's plugin folder, approved unsigned by its hash and holding door.handle
export async function writeHolder(store: StateStore, dataDir: string): Promise<void> {
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': holder })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const root = path.join(dataDir, 'plugins', HOLDER)
  const granted = [{ type: 'door.handle' as const }]
  await writeFolder(root, filesFor(workerManifest(HOLDER, { capabilities: granted }), { 'worker.js': built!.text }))
  await writeApproved(store, HOLDER, root, { granted })
}

// hetu on dataDir with the fake door installed, once the holder's worker runs
export async function startedWith(dataDir: string, install: string): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, worker: Worker }> {
  const app = await launch(dataDir, { HETU_INSTALL_DIR: install })
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: HOLDER }))
  const page = await workersPage(app, HOLDER)
  await until(() => page.workers().length === 1)
  return { app, editor, dataDir, worker: page.workers()[0] as Worker }
}

export type Report = {
  incarnation: number, n?: number, result?: unknown, refused?: string, handleRefused?: string[], caller: unknown, onBehalf: string | null
}

type Door = { send(command: unknown): void, reports: Report[] }

let sent = 0

// Queues a command for the fake door and gives back its number
export async function send(worker: Worker, name: string, args: unknown = {}): Promise<number> {
  const n = ++sent
  await worker.evaluate(([n, name, args]) => (globalThis as unknown as { door: Door }).door.send({ n, name, args }), [n, name, args] as const)
  return n
}

// Every report the holder has kept
export const reports = (worker: Worker) => worker.evaluate(() => (globalThis as unknown as { door: Door }).door.reports)

// Queues a command and waits for the fake door's report of it
export async function command(worker: Worker, name: string, args: unknown = {}, ms?: number): Promise<Report> {
  const n = await send(worker, name, args)
  let found: Report | undefined
  await until(async () => {
    found = (await reports(worker)).find(report => report.n === n)
    return found !== undefined
  }, ms)
  return found!
}

// Every refusal of the door's door.handle calls the reports carried, by the door's incarnation
export const handleRefusals = async (worker: Worker) =>
  (await reports(worker)).flatMap(report => (report.handleRefused ?? []).map(code => ({ incarnation: report.incarnation, code })))

// A report's outcome alone
export const outcome = (report: Report) => report.refused === undefined ? { result: report.result } : { refused: report.refused }
