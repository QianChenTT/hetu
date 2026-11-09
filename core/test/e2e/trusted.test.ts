import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore, type Plugin, type Switches } from '../../backend/boot/state.ts'
import { entryFor, filesFor, hostManifest, workerManifest, writeFolder, writeInstall, type Files, type Listing } from '../loader-fakes.ts'
import { cleanup, editorPage, exists, exited, launch, logged, pageAt, repo, temp, tick, until, visibleWindows } from './helpers.ts'

afterEach(cleanup)

// The input delay and a little more, so a click after it lands
const PAST_DELAY = 1300

async function shipped(id: string): Promise<Files> {
  const root = path.join(repo, 'core', 'dist', 'plugins', id)
  return {
    'hetu-plugin.json': await readFile(path.join(root, 'hetu-plugin.json'), 'utf8'),
    'dist/host.js': await readFile(path.join(root, 'dist', 'host.js'), 'utf8'),
  }
}

async function install(gate?: Listing): Promise<string> {
  const dir = await temp()
  await writeInstall(dir, { gate: gate ?? { files: await shipped('gate') } })
  return dir
}

const host = (id: string, module: string): Listing => ({ files: filesFor(hostManifest(id), { 'host.js': module }) })
const starts = 'export default { kind: \'hetu-plugin\', spec: { start() {} } }\n'
const hangs = 'export default { kind: \'hetu-plugin\', spec: { start() { return new Promise(() => {}) } } }\n'
// A gate that allows everything and throws from stateChanged once it has seen more views than ok
const gateRole = (ok: number) => `let views = 0
export const gate = { decide() { return { allow: true, view: 0 } }, canRead() { return true }, verbs() { return [] },
  stateChanged() { views++; if (views > ${ok}) throw new Error('no') } }
`

// A worker speaking the lifecycle as text on the port its page hands it. after runs once it is ready
const lifecycle = (after = '') => `
self.onmessage = event => {
  const port = event.ports[0]
  self.onmessage = null
  const send = message => port.postMessage(JSON.stringify(message))
  port.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.kind === 'init') {
      send({ v: 1, kind: 'ready' })
      ${after}
    }
    else if (message.kind === 'ping') send({ v: 1, kind: 'pong' })
    else if (message.kind === 'stop') send({ v: 1, kind: 'stopped' })
  }
}
`

type Worker = { code: string, manifest?: object, entry?: Partial<Plugin> }

async function data(options: { switches?: Partial<Switches>, workers?: Record<string, Worker>, before?: (dataDir: string) => Promise<void> } = {}): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), ...options.switches })
  for (const [id, worker] of Object.entries(options.workers ?? {})) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, worker.manifest ?? {}), { 'worker.js': worker.code }))
    await store.writePlugin(id, await entryFor(root, worker.entry ?? {}))
  }
  await options.before?.(dataDir)
  return dataDir
}

// hetu from the source, never starting itself again, so a test starts each next run
const start = async (dataDir: string, installDir: string) => launch(dataDir, { HETU_INSTALL_DIR: installDir, HETU_NO_RELAUNCH: '1' })

async function trustedPage(app: ElectronApplication): Promise<Page> {
  const page = await pageAt(app, 'hetu://trusted/')
  await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
  return page
}

const text = (page: Page) => page.locator('#root').innerText()
const showing = (page: Page, line: string) => until(async () => (await text(page)).includes(line))

type Reply = { ok: boolean, result?: unknown, refusal?: { code: string } }
let next = 5000

// A call through a page's bridge, as its own code makes one
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    const reply = message as { kind?: string, id?: number }
    if (reply.kind === 'reply' && reply.id === id) resolve(reply)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [next++, action, args] as const) as Promise<Reply>

describe('a security control that fails at start', () => {
  it.each([
    ['fails its hash check', async () => ({ files: await shipped('gate'), hash: '0'.repeat(64) }), 'failed its hash check'],
    ['throws from its module', async () => host('gate', 'throw new Error(\'the gate module threw\')\n'), 'failed to start (start-failed)'],
    ['throws from its first stateChanged', async () => host('gate', `${starts}${gateRole(0)}`), 'failed to start (state-changed)'],
    ['gives no gate role', async () => host('gate', starts), 'failed to start (no-role)'],
  ])('stops hetu with only the trusted window open when the gate %s', async (_name, gate, line) => {
    const dataDir = await data()
    const app = await start(dataDir, await install(await gate()))
    const page = await trustedPage(app)
    await showing(page, `hetu stopped: the security plugin gate ${line}`)
    expect(await visibleWindows(app)).toEqual(['hetu://trusted/'])
    // The record lands a moment after the window shows, later on a slow machine
    await until(() => logged(dataDir, 'core.stopped', { control: 'gate' }))
    expect(await logged(dataDir, 'core.ready')).toBe(false)
  })

  it('stops hetu when the gate hangs at start, once readyMs runs out', async () => {
    const dataDir = await data({ switches: { limits: { all: {}, plugins: { gate: { readyMs: 1500 } } } } })
    const app = await start(dataDir, await install(host('gate', `${hangs}${gateRole(1)}`)))
    const page = await trustedPage(app)
    await showing(page, 'hetu stopped: the security plugin gate failed to start (start-timeout)')
  })
})

describe('the stopped mode\'s three choices', () => {
  const failing = () => install(host('gate', 'throw new Error(\'the gate module threw\')\n'))

  it('starts with the gate switched off once the human typed its id and confirmed after the delay', async () => {
    const dataDir = await data()
    const installDir = await failing()
    const app = await start(dataDir, installDir)
    const page = await trustedPage(app)
    await showing(page, 'hetu stopped')
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Start with it switched off' }).click()
    await showing(page, 'Switch gate off')
    const confirm = page.getByRole('button', { name: 'Confirm' })
    expect(await confirm.isDisabled()).toBe(true)
    await page.getByLabel('Type gate to confirm').fill('gate')
    // The request counts once it has been first in line for the delay
    await tick(PAST_DELAY)
    const done = exited(app)
    await confirm.click()
    expect(await done).toBe(0)
    expect(await logged(dataDir, 'security.confirm', { kind: 'plugin.off', target: 'gate' })).toBe(true)

    // The next run, as Restart hetu would start it, runs with the gate off and says so
    const again = await start(dataDir, installDir)
    const editor = await editorPage(again)
    await until(async () => (await editor.locator('#banner li').allTextContents()).includes('gate: off'))
  })

  it('quits', async () => {
    const dataDir = await data()
    const app = await start(dataDir, await failing())
    const page = await trustedPage(app)
    await showing(page, 'hetu stopped')
    await tick(PAST_DELAY)
    const done = exited(app)
    await page.getByRole('button', { name: 'Quit' }).click()
    expect(await done).toBe(0)
  })

  it('recovers a gate its start marker held, so the next run starts it', async () => {
    const dataDir = await data({ before: async dir => {
      await mkdir(path.join(dir, 'starting'), { recursive: true })
      await writeFile(path.join(dir, 'starting', 'gate'), '')
    } })
    const installDir = await install()
    const app = await start(dataDir, installDir)
    const page = await trustedPage(app)
    await showing(page, 'failed to start (marker)')
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Recover' }).click()
    await showing(page, 'Reset gate')
    await tick(PAST_DELAY)
    const done = exited(app)
    await page.getByRole('button', { name: 'Confirm' }).click()
    expect(await done).toBe(0)
    expect(await exists(path.join(dataDir, 'starting', 'gate'))).toBe(false)
    const again = await start(dataDir, installDir)
    await editorPage(again)
    await until(() => logged(dataDir, 'core.ready', { gate: 'on' }))
  })
})

describe('a security control that fails while hetu runs', () => {
  it('quits with an error to start again, then stops in the stopped mode when the same control fails in the next run', async () => {
    const dataDir = await data()
    const installDir = await install(host('gate', `${starts}${gateRole(1)}`))
    const app = await start(dataDir, installDir)
    const editor = await editorPage(app)
    await until(() => logged(dataDir, 'core.ready'))
    const done = exited(app)
    // Any applied change gives the gate a new StateView, which this gate throws on
    expect((await ask(editor, 'security.request', { change: { kind: 'confirmOff', on: false } })).ok).toBe(true)
    expect(await done).toBe(1)
    expect(await logged(dataDir, 'core.failed', { control: 'gate', reason: 'state-changed' })).toBe(true)
    expect(await readFile(path.join(dataDir, 'failed-once'), 'utf8')).toBe('gate')

    const again = await start(dataDir, installDir)
    const second = await editorPage(again)
    await ask(second, 'security.request', { change: { kind: 'confirmOff', on: false } })
    const page = await trustedPage(again)
    await showing(page, 'hetu already started again once after a failure')
    await until(async () => (await visibleWindows(again)).length === 1)
  })
})

describe('a prompt a plugin\'s call raises', () => {
  // asker's plugin.call to target asks at its first use. asker calls target.hello as soon as it is ready
  const workers = {
    target: { code: lifecycle(), manifest: { provides: { actions: { hello: {} } } } },
    // It requires target, so it starts once target is ready to be called
    asker: {
      manifest: { requires: ['target'] },
      code: lifecycle('send({ v: 1, kind: \'call\', id: 1, action: \'target.hello\', args: {} })'),
      entry: { granted: [{ type: 'plugin.call', targets: ['target'] }], firstUse: [{ type: 'plugin.call', targets: ['target'] }] },
    },
  } satisfies Record<string, Worker>

  it('waits as a notice, opens the trusted window only on a click past its delay, and a Confirm sent early confirms nothing', async () => {
    const dataDir = await data({ workers })
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    const notice = editor.getByRole('button', { name: 'The plugin "asker" asks to use something for the first time' })
    await notice.waitFor()
    // The call opened nothing, and a click as the notice appears opens nothing either
    await notice.click()
    await tick(500)
    expect(await visibleWindows(app)).toEqual(['hetu://editor/'])
    // No window but the trusted one confirms
    const status = (await ask(editor, 'core.status')).result as { pending: { id: string, kind: string }[] }
    const request = status.pending[0]
    expect(request.kind).toBe('item.on')
    expect((await ask(editor, 'security.confirm', { requestId: request.id })).refusal?.code).toBe('not-granted')

    await tick(PAST_DELAY)
    await notice.click()
    const page = await trustedPage(app)
    await showing(page, 'Let asker use plugin.call to target')
    // Inside the delay: the core refuses a Confirm whatever the page sends, and main drops a click on Cancel
    expect((await ask(page, 'security.confirm', { requestId: request.id })).refusal?.code).toBe('throttled')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await tick(200)
    expect((await ask(editor, 'core.status')).result).toMatchObject({ pending: [{ id: request.id }] })

    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await until(() => logged(dataDir, 'security.applied', { kind: 'item.on', target: 'asker' }))
    const entry = (await new StateStore(dataDir).load()).state.plugins.asker
    expect(entry.firstUse).toEqual([])
  })

  it('keeps the trusted page where it is when it tries to navigate', async () => {
    const dataDir = await data()
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await page.evaluate(() => { location.href = 'hetu://editor/' })
    await tick(300)
    expect(page.url()).toBe('hetu://trusted/')
  })
})

describe('the plugin list', () => {
  it('stops a hung worker for the human while another plugin floods', async () => {
    const dataDir = await data({
      switches: { limits: { all: { heartbeatMs: 300 }, plugins: {} } },
      workers: {
        hung: { code: lifecycle('setTimeout(() => { for (;;) {} }, 50)') },
        flood: { code: lifecycle('setInterval(() => { for (let i = 0; i < 5000; i++) send({ v: 1, kind: \'pong\' }) }, 0)') },
      },
    })
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    await until(() => logged(dataDir, 'plugin.unresponsive', { plugin: 'hung' }))
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await showing(page, 'hung · plugin folder · sandboxed · unresponsive')
    await tick(PAST_DELAY)
    await page.locator('.plugin', { hasText: 'hung ·' }).getByRole('button', { name: 'Stop' }).click()
    await until(() => logged(dataDir, 'plugin.stopped', { plugin: 'hung' }))
    await showing(page, 'hung · plugin folder · sandboxed · stopped (human)')
  })
})

// The roadmap's first proof end to end: a plugin's worker reaches no security or window lifecycle action
describe('a plugin', () => {
  it('reaches no security.* or window lifecycle action, each refused not-granted and recorded', async () => {
    const actions = ['security.request', 'security.confirm', 'security.cancel', 'security.open', 'security.list', 'core.stop', 'core.restart', 'core.quit', 'core.relaunch']
    const calls = actions.map((action, i) => `send({ v: 1, kind: 'call', id: ${i + 1}, action: '${action}', args: ${action === 'security.request' ? "{ change: { kind: 'plugin.off', plugin: 'gate' } }" : action.startsWith('core.') && action !== 'core.quit' && action !== 'core.relaunch' ? "{ plugin: 'reacher' }" : action === 'security.confirm' || action === 'security.cancel' ? "{ requestId: 'r1' }" : '{}'} })`).join('\n')
    const dataDir = await data({ workers: { reacher: { code: lifecycle(calls) } } })
    const app = await start(dataDir, await install())
    await editorPage(app)
    for (const action of actions) {
      await until(() => logged(dataDir, 'audit.call', { action, code: 'not-granted' }))
    }
    expect(await logged(dataDir, 'security.request')).toBe(false)
    expect(await visibleWindows(app)).toEqual(['hetu://editor/'])
  })
})
