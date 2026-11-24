import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, launch, logged, temp, tick, until, workersPage } from './helpers.ts'

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// A plugin whose worker hands its ctx to the test
const fixture = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    ;(globalThis as Record<string, unknown>).ctx = ctx
  },
})
`

type Ctx = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
const drive = <T>(worker: Worker, work: (scope: { ctx: Ctx }) => Promise<T>) => worker.evaluate(`(${work.toString()})(globalThis)`) as Promise<T>

async function started(notes: Record<string, string>) {
  const folder = await temp()
  for (const [name, text] of Object.entries(notes)) await writeFile(path.join(folder, name), text)
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': fixture })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const granted: Capability[] = [{ type: 'ui.view' }, { type: 'luoshu.read', paths: ['**'] }, { type: 'luoshu.write', paths: ['**'] }]
  const root = path.join(dataDir, 'plugins', 'mover')
  await writeFolder(root, filesFor(workerManifest('mover', { capabilities: granted }), { 'worker.js': built.text }))
  // Approved with each item's first use confirmed, so its writes ask nothing
  await writeApproved(store, 'mover', root, { granted, class: 4, confirmed: granted })
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'core.ready'))
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'mover' }))
  const page = await workersPage(app, 'mover')
  await until(() => page.workers().length === 1)
  return { editor, folder, worker: page.workers()[0] as Worker }
}

describe('an open note hetu moved or removed', () => {
  it('says so on the note bar, keeps the unsaved text as a draft and never saves to the path it left', async () => {
    const { editor, folder, worker } = await started({ 'a.md': 'alpha' })
    await drive(worker, async scope => scope.ctx.editor.open('a.md'))
    await until(async () => (await editor.locator('#title').innerText()) === 'a.md')
    await editor.locator('.editor:not([hidden]) .cm-content').click()
    await editor.keyboard.press('End')
    await editor.keyboard.type(' typed')
    await until(async () => (await editor.locator('#title').innerText()) === 'a.md (unsaved)')
    await drive(worker, async scope => scope.ctx.luoshu.move({ from: 'a.md', to: 'b.md' }))
    const bar = editor.locator('#note-text')
    await until(async () => (await bar.innerText()) === 'This note was moved or deleted, so this tab can\'t save it. Your text is kept as a draft')
    await editor.keyboard.press('ControlOrMeta+s')
    await tick(500)
    expect((await readdir(folder)).sort()).toEqual(['b.md'])
    expect(await readFile(path.join(folder, 'b.md'), 'utf8')).toBe('alpha')
    expect(await editor.locator('.editor:not([hidden]) .cm-content').innerText()).toBe('alpha typed')
  })
})
