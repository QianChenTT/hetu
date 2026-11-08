import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore, type Switches } from '../../backend/boot/state.ts'
import { filesFor, hostManifest, writeInstall, type Files, type Listing } from '../loader-fakes.ts'
import { cleanup, editorPage, launch, logged, records, repo, temp, tick, until } from './helpers.ts'

afterEach(cleanup)

// The host halves the build put in the install
async function shipped(id: string): Promise<Files> {
  const root = path.join(repo, 'core', 'dist', 'plugins', id)
  return {
    'hetu-plugin.json': await readFile(path.join(root, 'hetu-plugin.json'), 'utf8'),
    'dist/host.js': await readFile(path.join(root, 'dist', 'host.js'), 'utf8'),
  }
}

// An install holding the shipped log and gate, with a plugin replaced, or left out where over names null
async function install(over: Record<string, Listing | null> = {}): Promise<string> {
  const dir = await temp()
  const plugins: Record<string, Listing | null> = { log: { files: await shipped('log') }, gate: { files: await shipped('gate') }, ...over }
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

describe('the gate and the log on', () => {
  it('decides a window\'s call on its grants, and the log writes its record', async () => {
    const { dataDir, page } = await started()
    expect(await read(page)).toBe('unavailable')
    // ** leaves dot files out of the editor's grant
    expect(await read(page, '.scratch.md')).toBe('not-granted')
    const history = await ask(page, 'log.history')
    expect(history.ok).toBe(true)
    expect((history.result as { segment: number }[])[0]).toMatchObject({ segment: 1 })
    await until(async () => (await records(dataDir)).some(record =>
      record.event === 'audit.call' && record.action === 'log.history' && record.code === null && record.gate === 'on'
      && String(record.caller).startsWith('window/editor#')))
    expect(await page.locator('#banner li').allTextContents()).not.toContain('gate: on')
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

  it('refuses them while the log is down, since nothing would record them, and lets them through with the log off too', async () => {
    const down = await started({ install: { log: null }, switches: { off: ['gate'] } })
    expect(await read(down.page)).toBe('policy-down')
    const off = await started({ switches: { off: ['gate', 'log'] } })
    expect(await read(off.page)).toBe('unavailable')
  })

  it('refuses them once the log stops acknowledging past auditStallMs, which marks it failed', async () => {
    // A log that takes its handle and never writes a record
    const stalls = `${starts}export const log = { attach() {} }\n`
    const { dataDir, page } = await started({
      install: { log: host('log', stalls) },
      switches: { off: ['gate'], limits: { all: {}, plugins: { log: { auditStallMs: 1500 } } } },
    })
    expect(await read(page)).toBe('unavailable')
    await tick(1600)
    expect(await read(page)).toBe('policy-down')
    expect(await logged(dataDir, 'plugin.failed', { plugin: 'log', reason: 'stalled' })).toBe(true)
    await until(() => logged(dataDir, 'audit.dropped', { why: 'log-down' }))
    await banner(page, 'log: failed')
  })
})

describe('the log down with the gate on', () => {
  it('leaves the gate deciding and says so in the banner', async () => {
    const { page } = await started({ install: { log: { files: await shipped('log'), hash: '0'.repeat(64) } } })
    expect(await read(page)).toBe('unavailable')
    expect(await read(page, '.scratch.md')).toBe('not-granted')
    await banner(page, 'log: tampered')
  })
})
