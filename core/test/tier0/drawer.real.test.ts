import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frame, Worker } from 'playwright'
import { afterAll, beforeAll, describe } from 'vitest'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { drawerCases, type MakeDrawer, notes } from '../contract/drawer.cases.ts'
import { padPage, padStyle, probeManifest } from '../contract/drawer-probe.ts'
import { filesFor, writeFolder } from '../plugins-manager-fakes.ts'
import { start, until } from './instance.ts'

// The real drawer on the drawer's cases: the driven build with the shipped explorer and the probe written approved
// beside it. Presses and Enter go through main's input route. Each answer is read where the probe meets it: its
// worker's port through the workers page and its frame's SDK through the frame, never the editor page's DOM

let probeFolder = ''
beforeAll(async () => {
  probeFolder = await mkdtemp(path.join(os.tmpdir(), 'hetu-probe-'))
  const contract = path.join(import.meta.dirname, '..', 'contract')
  const built = await buildPlugin(contract, { entries: { 'worker.js': 'drawer-probe.ts', 'pad.js': 'drawer-probe-frame.ts' }, workers: ['worker.js'], write: false })
  const text = (name: string) => built.find(output => output.path === name)!.text
  await writeFolder(probeFolder, filesFor(probeManifest, { 'worker.js': text('worker.js'), 'pad.js': text('pad.js'), 'pad.html': padPage, 'pad.css': padStyle }))
})
afterAll(() => rm(probeFolder, { recursive: true, force: true }))

const real: MakeDrawer = async context => {
  const instance = await start(context, { profile: { name: 'drawer', plugins: ['file-explorer'] }, notes, tests: { probe: probeFolder } })
  const editor = await instance.editor()
  let frame: Frame | undefined
  await until(async () => {
    frame = editor.frames().find(each => each.url().startsWith('hetu://probe.views/'))
    return frame !== undefined && await frame.evaluate(() => 'probe' in globalThis).catch(() => false)
  }, 'the probe\'s frame connected')
  const element = editor.locator('iframe.hetu-frame[src^="hetu://probe.views/"]')
  await until(async () => ((await element.boundingBox())?.width ?? 0) > 0, 'the probe\'s frame laid out')
  let worker: Worker | undefined
  await until(async () => {
    worker = instance.app.windows().find(page => page.url() === 'hetu://workers/?for=probe')?.workers()[0]
    return worker !== undefined && await worker.evaluate(() => 'probe' in globalThis).catch(() => false)
  }, 'the probe\'s worker started')
  type Probe = { view: { open(path: string): void, post(data: unknown): void, dragToken(path: string): Promise<string | null> }, received: unknown[] }
  const probe = () => (globalThis as unknown as { probe: Probe }).probe
  return {
    press: async where => void await instance.click(where === 'frame' ? frame!.locator('#pad') : editor.locator('#title')),
    enter: async () => void await instance.frameKeys(['Enter']),
    frameOpen: path => frame!.evaluate(`(${probe})().view.open(${JSON.stringify(path)})`),
    framePost: data => frame!.evaluate(`(${probe})().view.post(${JSON.stringify(data)})`),
    frameReceived: () => frame!.evaluate(`(${probe})().received`),
    dragToken: path => frame!.evaluate(`(${probe})().view.dragToken(${JSON.stringify(path)})`),
    ask: given => worker!.evaluate(`globalThis.probe.ask(${JSON.stringify(given)})`),
    settle: () => new Promise(resolve => setTimeout(resolve, 800)),
  }
}

describe('the drawer on the driven build', () => drawerCases(real))
