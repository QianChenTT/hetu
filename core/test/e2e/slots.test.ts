import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore, type Switches } from '../../backend/boot/state.ts'
import { filesFor, hostManifest, writeInstall, type Files, type Listing } from '../loader-fakes.ts'
import { cleanup, editorPage, launch, logged, records, repo, temp, until } from './helpers.ts'

afterEach(cleanup)

// The host halves the build put in the install
async function shipped(id: string): Promise<Files> {
  const root = path.join(repo, 'core', 'dist', 'plugins', id)
  return {
    'hetu-plugin.json': await readFile(path.join(root, 'hetu-plugin.json'), 'utf8'),
    'dist/host.js': await readFile(path.join(root, 'dist', 'host.js'), 'utf8'),
  }
}

// An install holding the shipped gate, with a plugin replaced, or left out where over names null
async function install(over: Record<string, Listing | null> = {}): Promise<string> {
  const dir = await temp()
  const plugins: Record<string, Listing | null> = { gate: { files: await shipped('gate') }, ...over }
  await writeInstall(dir, Object.fromEntries(Object.entries(plugins).filter((entry): entry is [string, Listing] => entry[1] !== null)))
  return dir
}

// A host half written as the loader imports one: the plugin as its default export and its roles beside it
const host = (id: string, module: string): Listing => ({ files: filesFor(hostManifest(id), { 'host.js': module }) })
const starts = 'export default { kind: \'hetu-plugin\', spec: { start() {} } }\n'
const gateRole = (stateChanged: string) =>
  `export const gate = { decide() { return { allow: true, view: 0 } }, canRead() { return true }, verbs() { return [] }, stateChanged() { ${stateChanged} } }\n`

async function data(switches: Partial<Switches> = {}): Promise<string> {
  const dataDir = await temp()
  await new StateStore(dataDir).writeSwitches({ ...defaultSwitches(), ...switches })
  return dataDir
}

async function started(options: { install?: Record<string, Listing | null>, switches?: Partial<Switches> } = {}) {
  const dataDir = await data(options.switches)
  const app = await launch(dataDir, { HETU_INSTALL_DIR: await install(options.install) })
  const page = await editorPage(app)
  await until(async () => (await records(dataDir)).some(record => record.event === 'core.ready'))
  return { dataDir, app, page }
}

type Reply = { ok: boolean, result?: unknown, refusal?: { code: string } }
let next = 1000

// A call from the editor through the shell's bridge, as the shell makes one
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    const reply = message as { kind?: string, id?: number }
    if (reply.kind === 'reply' && reply.id === id) resolve(reply)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [next++, action, args] as const) as Promise<Reply>

const codeOf = (reply: Reply) => (reply.ok ? 'ok' : reply.refusal?.code)
// No luoshu provider is built yet, so a read the gate lets through answers unavailable at the route, after the gate
const read = async (page: Page, file = 'notes/a.md') => codeOf(await ask(page, 'luoshu.read', { path: file }))

const banner = async (page: Page, line: string) => {
  await until(async () => (await page.locator('#banner li').allTextContents()).includes(line))
}

describe('the gate on and the core\'s log', () => {
  it('decides a window\'s call on its grants, and the core writes its record and serves the log to the window', async () => {
    const { dataDir, page } = await started()
    expect(await read(page)).toBe('unavailable')
    // ** leaves dot files out of the editor's grant
    expect(await read(page, '.scratch.md')).toBe('not-granted')
    await until(async () => (await records(dataDir)).some(record =>
      record.event === 'audit.call' && record.action === 'luoshu.read' && record.code === 'unavailable' && record.gate === 'on'
      && String(record.caller).startsWith('window/editor#')))
    const history = await ask(page, 'log.history')
    expect(history.ok).toBe(true)
    expect((history.result as { segment: number }[])[0]).toMatchObject({ segment: 1 })
    expect(await ask(page, 'log.verify')).toMatchObject({ ok: true, result: { ok: true } })
    const lines = await page.locator('#banner li').allTextContents()
    expect(lines).not.toContain('gate: on')
    expect(lines.some(line => line.startsWith('log:'))).toBe(false)
  })
})

describe('the gate down', () => {
  it.each([
    ['absent from the install', { gate: null }, 'gate: absent'],
    ['failing its hash check', { gate: { files: {}, hash: '0'.repeat(64) } }, 'gate: tampered'],
  ] as const)('refuses calls with power while %s, and the banner says so', async (_name, over, line) => {
    const files = over.gate === null ? null : { files: await shipped('gate'), hash: over.gate.hash }
    const { page } = await started({ install: { gate: files } })
    expect(await read(page)).toBe('policy-down')
    await banner(page, line)
  })

  it.each([
    ['its module throws', 'throw new Error(\'the gate module threw\')\n', 'start-failed'],
    ['its stateChanged throws', `${starts}${gateRole('throw new Error(\'no\')')}`, 'state-changed'],
  ])('is marked failed when %s, refusing calls with power', async (_name, module, reason) => {
    const { dataDir, page } = await started({ install: { gate: host('gate', module) } })
    expect(await logged(dataDir, 'plugin.failed', { plugin: 'gate', reason })).toBe(true)
    expect(await read(page)).toBe('policy-down')
    await banner(page, 'gate: failed')
  })

  it('is marked failed when it hangs at start, once readyMs runs out, and refuses calls with power', async () => {
    const hangs = 'export default { kind: \'hetu-plugin\', spec: { start() { return new Promise(() => {}) } } }\n'
    const { dataDir, page } = await started({
      install: { gate: host('gate', `${hangs}${gateRole('')}`) },
      switches: { limits: { all: {}, plugins: { gate: { readyMs: 1500 } } } },
    })
    await until(() => logged(dataDir, 'plugin.failed', { plugin: 'gate', reason: 'start-timeout' }))
    expect(await read(page)).toBe('policy-down')
  })
})

describe('the gate off by the human', () => {
  it('lets calls with power through, still recorded while the log runs', async () => {
    const { dataDir, page } = await started({ switches: { off: ['gate'] } })
    expect(await read(page)).toBe('unavailable')
    await until(async () => (await records(dataDir)).some(record => record.event === 'audit.call' && record.action === 'luoshu.read' && record.gate === 'off'))
    await banner(page, 'gate: off')
  })

  // Recording off writes no core.ready, so the banner says when the start is over
  it('lets them through unrecorded once the human turned recording off too', async () => {
    const dataDir = await data({ off: ['gate'], recordNothing: true })
    const app = await launch(dataDir, { HETU_INSTALL_DIR: await install() })
    const page = await editorPage(app)
    await banner(page, 'gate: off')
    await banner(page, 'recording off')
    expect(await read(page)).toBe('unavailable')
    expect((await records(dataDir)).some(record => record.event === 'audit.call')).toBe(false)
  })
})
