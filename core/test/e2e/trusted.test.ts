import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore, type Plugin, type Switches } from '../../backend/boot/state.ts'
import { entryFor, filesFor, firstPartyEntry, hashOf, hostManifest, workerManifest, writeFolder, writeInstall } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, exited, launch, logged, pageAt, records, temp, tick, until, visibleWindows } from './helpers.ts'

afterEach(cleanup)

// The input delay and a little more, so a click after it lands
const PAST_DELAY = 1300

// An install holding no plugin. The gate and the other core modules ship inside the core
async function install(): Promise<string> {
  const dir = await temp()
  await writeInstall(dir, {})
  return dir
}

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

// A core module that fails stops nothing, so only the log and the install list stop hetu. A list naming a core module
// doesn't check out, as no install hetu's installer writes holds one
describe('an install list that doesn\'t check out', () => {
  async function broken(): Promise<string> {
    const dir = await temp()
    await writeInstall(dir, { gate: { files: filesFor(hostManifest('gate')) } })
    return dir
  }

  it('stops hetu with only the trusted window open and sends the human to the installer', async () => {
    const dataDir = await data()
    const app = await start(dataDir, await broken())
    const page = await trustedPage(app)
    await showing(page, 'hetu stopped: its install list doesn’t check out')
    await showing(page, 'Repair hetu with its installer to get its files back')
    expect(await visibleWindows(app)).toEqual(['hetu://trusted/'])
    // The record lands a moment after the window shows, later on a slow machine
    await until(() => logged(dataDir, 'core.stopped', { control: 'install' }))
    expect(await logged(dataDir, 'core.ready')).toBe(false)
  })

  it('quits, the one choice it offers', async () => {
    const dataDir = await data()
    const app = await start(dataDir, await broken())
    const page = await trustedPage(app)
    await showing(page, 'hetu stopped')
    expect(await page.getByRole('button', { name: 'Start with it switched off' }).count()).toBe(0)
    await tick(PAST_DELAY)
    const done = exited(app)
    await page.getByRole('button', { name: 'Quit' }).click()
    expect(await done).toBe(0)
  })
})

// The core's log is the one security control left whose failure stops hetu. Its folder swapped for a file makes every
// write fail. logFailMs lowered makes it count as failed soon
describe('the core\'s log failing while hetu runs', () => {
  const folder = (dataDir: string) => path.join(dataDir, 'events')
  // Windows refuses to rename a folder while a file in it is open, which the log's own append or a scanner holds for
  // a moment, so a refused rename is tried again for up to 10 s
  async function moved(from: string, to: string): Promise<void> {
    for (let tries = 0; ; tries++) {
      try {
        return await rename(from, to)
      } catch (err) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '') || tries >= 50) throw err
        await tick(200)
      }
    }
  }
  async function breakLog(dataDir: string): Promise<void> {
    await moved(folder(dataDir), `${folder(dataDir)}-away`)
    await writeFile(folder(dataDir), '')
  }
  async function mendLog(dataDir: string): Promise<void> {
    await rm(folder(dataDir), { force: true, maxRetries: 5, retryDelay: 100 })
    await moved(`${folder(dataDir)}-away`, folder(dataDir))
  }
  const readied = async (dataDir: string) => (await records(dataDir)).filter(record => record.event === 'core.ready').length

  it('quits with an error to start again, then stops in the stopped mode when it fails in the next run', async () => {
    const dataDir = await data({ switches: { limits: { all: { logFailMs: 1000 }, plugins: {} } } })
    const installDir = await install()
    const app = await start(dataDir, installDir)
    const editor = await editorPage(app)
    await until(async () => await readied(dataDir) === 1)
    const done = exited(app)
    await breakLog(dataDir)
    // An applied change writes a record that can't land
    await ask(editor, 'security.request', { change: { kind: 'confirmOff', on: false } })
    expect(await done).toBe(1)
    expect(await readFile(path.join(dataDir, 'failed-once'), 'utf8')).toBe('log')
    await mendLog(dataDir)

    const again = await start(dataDir, installDir)
    const second = await editorPage(again)
    await until(async () => await readied(dataDir) === 2)
    await breakLog(dataDir)
    await ask(second, 'security.request', { change: { kind: 'confirmOff', on: false } })
    const page = await trustedPage(again)
    await showing(page, 'hetu already started again once after a failure')
    await until(async () => (await visibleWindows(again)).length === 1)
  })

  // Restart hetu goes the way Try again goes, through app.relaunch
  it('keeps the restart marker through Restart hetu and clears it on a clean Quit', async () => {
    const dataDir = await data({ before: async dir => writeFile(path.join(dir, 'failed-once'), 'log') })
    const installDir = await install()
    for (const [button, kept] of [['Restart hetu', true], ['Quit', false]] as const) {
      const app = await start(dataDir, installDir)
      const editor = await editorPage(app)
      await tick(PAST_DELAY)
      await editor.getByRole('button', { name: 'Plugins and security' }).click()
      const page = await trustedPage(app)
      await tick(PAST_DELAY)
      const done = exited(app)
      await page.getByRole('button', { name: button, exact: true }).click()
      expect(await done).toBe(0)
      expect(await readFile(path.join(dataDir, 'failed-once'), 'utf8').then(() => true, () => false), button).toBe(kept)
    }
  })
})

describe('a prompt a plugin\'s call raises', () => {
  // asker's plugin.call to target asks at its first use, since asker reads notes and target has network, the pair the
  // grant risk classifier makes ask. Both hold class 4 already, so the pass at start raises no notice of a move.
  // asker calls target.hello as soon as it is ready
  const workers = {
    target: { code: lifecycle(), manifest: { provides: { actions: { hello: {} } } }, entry: { granted: [{ type: 'net.fetch', hosts: ['example.com'] }], class: 4 } },
    // It requires target, so it starts once target is ready to be called
    asker: {
      manifest: { requires: ['target'] },
      code: lifecycle('send({ v: 1, kind: \'call\', id: 1, action: \'target.hello\', args: {} })'),
      entry: {
        granted: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'plugin.call', targets: ['target'] }],
        firstUse: [{ type: 'plugin.call', targets: ['target'] }], class: 4,
      },
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
    await showing(page, 'Let asker use plugin.call to "target"')
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

describe('the switches and limits', () => {
  it('sets a limit and a switch from their sections, each waiting for its Confirm', async () => {
    const dataDir = await data()
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await showing(page, 'readyMs · fixed 10000')
    expect(await page.locator('section.install').innerText()).toContain('On macOS, programs running as you can change hetu’s install')
    await tick(PAST_DELAY)
    await page.getByLabel('New value for readyMs').fill('20000')
    await page.locator('.limit', { hasText: 'readyMs ·' }).getByRole('button', { name: 'Set' }).click()
    await showing(page, 'Set readyMs to 20000 for every plugin')
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await showing(page, 'readyMs · fixed 10000 · all: 20000')
    expect((await new StateStore(dataDir).load()).state.switches.limits.all).toEqual({ readyMs: 20000 })

    await page.locator('p', { hasText: 'Confirm off for this window: off' }).getByRole('button', { name: 'Switch on' }).click()
    await showing(page, 'Apply changes made in this window without a Confirm')
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await showing(page, 'Confirm off for this window: on')

    await page.getByLabel('New value for readyMs').fill('ten')
    await page.locator('.limit', { hasText: 'readyMs ·' }).getByRole('button', { name: 'Set' }).click()
    await showing(page, 'Type a whole number from 1 up')
  })

  it('switches the gate off only once the human typed its id and confirmed after the delay, the banner saying so', async () => {
    const dataDir = await data()
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await showing(page, 'gate · ships with hetu')
    await tick(PAST_DELAY)
    await page.locator('.plugin', { hasText: 'gate · ships with hetu' }).getByRole('button', { name: 'Switch off' }).click()
    await showing(page, 'Switch gate off')
    const confirm = page.getByRole('button', { name: 'Confirm' })
    await tick(PAST_DELAY)
    expect(await confirm.isDisabled()).toBe(true)
    await page.getByLabel('Type gate to confirm').fill('gat')
    expect(await confirm.isDisabled()).toBe(true)
    await page.getByLabel('Type gate to confirm').fill('gate')
    expect(await confirm.isDisabled()).toBe(false)
    await confirm.click()
    await until(() => logged(dataDir, 'security.confirm', { kind: 'plugin.off', target: 'gate' }))
    // The record lands before the change applies
    await until(async () => (await new StateStore(dataDir).load()).state.switches.off.includes('gate'))
    await until(async () => (await editor.locator('#banner li').allTextContents()).includes('gate: off'))
  })
})

describe('the agent list', () => {
  it('lists each agent of mcp by its label in quotes with its items, revokes one at once with no Confirm and shows it revoked', async () => {
    const mcp = filesFor(workerManifest('mcp', { capabilities: [{ type: 'luoshu.read', paths: ['**'] }] }), { 'worker.js': lifecycle() })
    const installDir = await temp()
    await writeInstall(installDir, { mcp: { files: mcp, firstParty: true } })
    const inbox = { type: 'luoshu.read' as const, paths: ['inbox/**'] }
    const dataDir = await data({
      before: async dir => {
        const root = path.join(dir, 'plugins', 'mcp')
        await writeFolder(root, mcp)
        await new StateStore(dir).writePlugin('mcp', firstPartyEntry(await hashOf(root), {
          granted: [{ type: 'luoshu.read', paths: ['**'] }], class: 1,
          agents: [{ agent: 'https://claude.ai/oauth/claude-code-client-metadata#3', capability: inbox }, { agent: 'client#10', capability: inbox }],
          revoked: ['client#2'],
        }))
      },
    })
    const app = await start(dataDir, installDir)
    const editor = await editorPage(app)
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await showing(page, '"https://claude.ai/oauth/claude-code-client-metadata#3" · luoshu.read on "inbox/**"')
    const agents = page.locator('section.agents')
    expect(await agents.innerText()).toContain('Its name and whether its token is live are mcp-http-handler’s to know, not this list’s')
    expect(await agents.innerText()).toContain('"client#2" · revoked, its tokens end once mcp-http-handler hears')
    expect(await agents.locator('p.agent', { hasText: '"client#2"' }).getByRole('button').count()).toBe(0)
    await tick(PAST_DELAY)
    await agents.locator('p.agent', { hasText: 'claude-code-client-metadata#3' }).getByRole('button', { name: 'Revoke' }).click()
    await showing(page, '"https://claude.ai/oauth/claude-code-client-metadata#3" · revoked, its tokens end once mcp-http-handler hears')
    // Applied at once, nothing waits for a Confirm
    expect(await page.locator('section.request').count()).toBe(0)
    const entry = (await new StateStore(dataDir).load()).state.plugins.mcp
    expect(entry.agents).toEqual([{ agent: 'client#10', capability: inbox }])
    expect(entry.revoked).toEqual(['client#2', 'https://claude.ai/oauth/claude-code-client-metadata#3'])
    expect(await logged(dataDir, 'security.applied', { kind: 'identity.revoke', target: 'https://claude.ai/oauth/claude-code-client-metadata#3', by: 'narrows' })).toBe(true)
  })

  it('draws each label in a fixed-width face that wraps, so a client id of 255 characters keeps its number in view and I reads apart from l', async () => {
    const mcp = filesFor(workerManifest('mcp', { capabilities: [{ type: 'luoshu.read', paths: ['**'] }] }), { 'worker.js': lifecycle() })
    const installDir = await temp()
    await writeInstall(installDir, { mcp: { files: mcp, firstParty: true } })
    const inbox = { type: 'luoshu.read' as const, paths: ['inbox/**'] }
    const prefix = 'https://claude.ai/oauth/'
    const long = `${prefix}${'x'.repeat(255 - prefix.length)}#7`
    const dataDir = await data({
      before: async dir => {
        const root = path.join(dir, 'plugins', 'mcp')
        await writeFolder(root, mcp)
        await new StateStore(dir).writePlugin('mcp', firstPartyEntry(await hashOf(root), {
          granted: [{ type: 'luoshu.read', paths: ['**'] }], class: 1,
          agents: [{ agent: long, capability: inbox }, { agent: 'client#1', capability: inbox }, { agent: 'cIient#1', capability: inbox }],
        }))
      },
    })
    const app = await start(dataDir, installDir)
    const editor = await editorPage(app)
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await showing(page, '"cIient#1" · luoshu.read on "inbox/**"')
    // The rows the page drew, then a request's heading built as the page builds one, since no agent can ask in the built
    // app until the door mints labels
    const measured = await page.evaluate(label => {
      const heading = document.createElement('h1')
      const span = document.createElement('span')
      span.className = 'label'
      span.textContent = JSON.stringify(label)
      heading.append('Give the agent ', span, ' what it asks for through mcp')
      const request = document.createElement('section')
      request.className = 'request'
      request.append(heading)
      document.body.append(request)
      const width = document.documentElement.clientWidth
      const all = [...document.querySelectorAll('section.agents p.agent'), heading].map(line => {
        const drawn = line.querySelector('.label')!
        const text = drawn.firstChild!
        // The box of the label's last two characters, the end of its number
        const end = document.createRange()
        end.setStart(text, text.textContent!.length - 2)
        end.setEnd(text, text.textContent!.length)
        const style = getComputedStyle(drawn)
        return {
          label: drawn.textContent, font: style.fontFamily, wrap: style.overflowWrap, fits: line.scrollWidth <= line.clientWidth,
          right: Math.ceil(end.getBoundingClientRect().right), height: Math.round(line.getBoundingClientRect().height),
        }
      })
      const rows = all.slice(0, -1)
      const asked = all.at(-1)!
      // The face the label is drawn in: every character as wide as every other, so the system had a fixed-width one
      const pen = document.createElement('canvas').getContext('2d')!
      pen.font = `${getComputedStyle(span).fontSize} ${getComputedStyle(span).fontFamily}`
      const widths = Object.fromEntries(['I', 'l', '1', 'i', 'm', 'W'].map(glyph => [glyph, pen.measureText(glyph).width]))
      request.remove()
      return { width, scroll: document.documentElement.scrollWidth, rows, asked, widths }
    }, long)
    console.log(JSON.stringify(measured))
    expect(measured.scroll).toBeLessThanOrEqual(measured.width)
    for (const drawn of [...measured.rows, measured.asked]) {
      expect(drawn.font).toContain('monospace')
      expect(drawn.wrap).toBe('anywhere')
      expect(drawn.fits).toBe(true)
      expect(drawn.right).toBeLessThanOrEqual(measured.width)
    }
    expect(measured.rows.map(row => row.label)).toEqual([JSON.stringify(long), '"client#1"', '"cIient#1"'])
    expect(new Set(Object.values(measured.widths)).size).toBe(1)
  })
})

describe('a plugin’s class', () => {
  // target holds network. writer reads and can call target, so together they could send notes out: class 4, and the
  // plugin.call that brings the network in asks at its first use
  const workers = {
    target: { code: lifecycle(), manifest: { provides: { actions: { hello: {} } } }, entry: { granted: [{ type: 'net.fetch', hosts: ['example.com'] }], class: 3 } },
  } satisfies Record<string, Worker>

  it('shows on the approval and the plugin list, and the item that closes a read plus network pair asks at its first use', async () => {
    const dataDir = await data({
      workers,
      before: async dir => {
        const root = path.join(dir, 'plugins', 'writer')
        const capabilities = [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'plugin.call', targets: ['target'] }]
        await writeFolder(root, filesFor(workerManifest('writer', { requires: ['target'], capabilities }), {
          'worker.js': lifecycle('send({ v: 1, kind: \'call\', id: 1, action: \'target.hello\', args: {} })'),
        }))
        // An approval writes no signer until plugin provenance, so this build is trusted as the human would trust one
        await new StateStore(dir).writeSwitches({ ...defaultSwitches(), allowUnsigned: [await hashOf(root)] })
      },
    })
    const app = await start(dataDir, await install())
    const editor = await editorPage(app)
    // The grant risk classifier is a core module, on from the start
    await until(() => logged(dataDir, 'core.ready', { 'grant-risk-classifier': 'on' }))
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await trustedPage(app)
    await showing(page, 'writer · plugin folder · sandboxed · found (new) · class unknown, counted as 4')
    await tick(PAST_DELAY)
    await page.locator('.plugin', { hasText: 'writer ·' }).getByRole('button', { name: 'Approve' }).click()
    await showing(page, 'Class 4, Powerful: it can read notes and reach the network, so it could send notes out')
    await showing(page, 'Through plugin.call it is connected to: net.fetch to "example.com"')
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await showing(page, 'class 4')
    const notice = editor.getByRole('button', { name: 'The plugin "writer" asks to use something for the first time' })
    await notice.waitFor()
    const entry = (await new StateStore(dataDir).load()).state.plugins.writer
    expect(entry).toMatchObject({ class: 4, firstUse: [{ type: 'plugin.call', targets: ['target'] }] })
  })
})

// The roadmap's first proof end to end: a plugin's worker reaches no security or window lifecycle action
describe('a plugin', () => {
  it('reaches no security.* or window lifecycle action, each refused not-granted and recorded', async () => {
    const actions = ['security.request', 'security.confirm', 'security.cancel', 'app.openSecurity', 'security.list', 'core.stop', 'core.restart', 'app.quit', 'app.relaunch']
    const calls = actions.map((action, i) => `send({ v: 1, kind: 'call', id: ${i + 1}, action: '${action}', args: ${action === 'security.request' ? "{ change: { kind: 'plugin.off', plugin: 'gate' } }" : action.startsWith('core.') && action !== 'app.quit' && action !== 'app.relaunch' ? "{ plugin: 'reacher' }" : action === 'security.confirm' || action === 'security.cancel' ? "{ requestId: 'r1' }" : '{}'} })`).join('\n')
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
