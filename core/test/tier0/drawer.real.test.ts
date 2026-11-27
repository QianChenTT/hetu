import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Frame, Page, Worker } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { drawerCases, type DrawerSide, notes } from '../contract/drawer.cases.ts'
import { padPage, padStyle, probeManifest } from '../contract/drawer-probe.ts'
import { filesFor, writeFolder } from '../plugins-manager-fakes.ts'
import { heard, mark } from './input.ts'
import { type Instance, start, until } from './instance.ts'

// The real drawer on the drawer's cases: the driven build with the shipped explorer and the probe written approved
// beside it. Presses and Enter go through main's input route. Each answer is read where the probe meets it: its
// worker's port through the workers page and its frame's SDK through the frame, never the editor page's DOM

let probeFolder = ''
beforeAll(async () => {
  probeFolder = await mkdtemp(path.join(os.tmpdir(), 'hetu-probe-'))
  const contract = path.join(import.meta.dirname, '..', 'contract')
  const built = await buildPlugin(contract, { entries: { 'worker.js': 'drawer-probe.ts', 'pad.js': 'drawer-probe-frame.ts' }, workers: ['worker.js'], write: false })
  const text = (name: string) => built.find(output => output.path === name)!.text
  await writeFolder(probeFolder, filesFor(probeManifest, { 'worker.js': text('worker.js'), 'pad.js': text('pad.js'), 'pad.css': padStyle, 'pad.html': padPage }))
})
afterAll(() => rm(probeFolder, { recursive: true, force: true }))

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// The Enter presses main pushed to the editor page on hetu:press, counted from when this ran
const watchKeyPushes = (app: ElectronApplication) => app.evaluate(({ webContents }) => {
  const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
  const scope = globalThis as unknown as { keyPushes: number }
  scope.keyPushes = 0
  const send = contents.send.bind(contents)
  contents.send = (channel: string, ...args: unknown[]) => {
    if (channel === 'hetu:press' && (args[0] as { key?: boolean } | undefined)?.key === true) scope.keyPushes++
    send(channel, ...args)
  }
})
const keyPushes = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { keyPushes: number }).keyPushes)

async function started(context: TestContext): Promise<{ instance: Instance, editor: Page, side: DrawerSide }> {
  const instance = await start(context, { profile: { name: 'drawer', plugins: ['file-explorer'] }, notes, tests: { probe: probeFolder } })
  const editor = await instance.editor()
  let frame: Frame | undefined
  await until(async () => {
    frame = editor.frames().find(each => each.url().startsWith('hetu://probe.views/'))
    return frame !== undefined && await frame.evaluate(() => 'probeFrame' in globalThis).catch(() => false)
  }, 'the probe\'s frame connected')
  const element = editor.locator('iframe.hetu-frame[src^="hetu://probe.views/"]')
  await until(async () => ((await element.boundingBox())?.width ?? 0) > 0, 'the probe\'s frame laid out')
  let worker: Worker | undefined
  await until(async () => {
    worker = instance.app.windows().find(page => page.url() === 'hetu://workers/?for=probe')?.workers()[0]
    return worker !== undefined && await worker.evaluate(() => 'probeWorker' in globalThis).catch(() => false)
  }, 'the probe\'s worker started')
  await watchKeyPushes(instance.app)
  const inFrame = (code: string) => frame!.evaluate(`globalThis.probeFrame.${code}`)
  const side: DrawerSide = {
    press: async (where, holdMs = 0) => void await instance.click(where === 'frame' ? frame!.locator('#pad') : editor.locator('#title'), { holdMs }),
    // Waits until main took the key and, with focus in the probe's frame, pushed it to the page, then for the push to
    // land there. Its landing isn't seen from outside the page, so that last wait is a fixed 100 ms
    enter: async () => {
      const focused = (await instance.focus()).main.find(window => window.url === 'hetu://editor/')?.focusedFrame ?? ''
      const [since, pushed] = [await mark(instance.app), await keyPushes(instance.app)]
      expect(await instance.frameKeys(['Enter'])).toEqual([])
      const enters = (await heard(instance.app, since, { kind: 'key' })).filter(input => input.key === 'Enter' && input.type === 'keyDown')
      expect(enters.map(input => input.prevented)).toEqual([false])
      if (focused.startsWith('hetu://probe.views/')) await until(async () => (await keyPushes(instance.app)) === pushed + 1, 'main\'s push of Enter')
      await sleep(100)
    },
    frameOpen: path => inFrame(`view.open(${JSON.stringify(path)})`) as Promise<void>,
    framePost: data => inFrame(`view.post(${JSON.stringify(data)})`) as Promise<void>,
    frameReceived: () => inFrame('received') as Promise<unknown[]>,
    dragToken: path => inFrame(`view.dragToken(${JSON.stringify(path)})`) as Promise<string | null>,
    ask: given => worker!.evaluate(`globalThis.probeWorker.ask(${JSON.stringify(given)})`),
    wait: sleep,
  }
  return { instance, editor, side }
}

describe('the drawer on the driven build', () => {
  drawerCases(async context => (await started(context)).side)

  // X1's other half: the shipped explorer's own frame and payload, its row click the human's open, which the probe's
  // ui.read then reaches
  it('counts a click on the shipped explorer\'s row as the human\'s open, reached through another plugin\'s ui.read', async context => {
    const { instance, editor, side } = await started(context)
    const explorer = editor.frames().find(each => each.url().includes('file-explorer.views'))!
    const row = explorer.locator('[role=treeitem]', { hasText: /^c/ })
    await until(async () => await row.count() === 1, 'the c row')
    await instance.click(row)
    await until(async () => JSON.stringify(await side.ask({ op: 'paths' })) === '["c.md"]', 'c.md reaching the probe')
    expect(await side.ask({ op: 'read', path: 'c.md' })).toBe('gamma')
  })
})
