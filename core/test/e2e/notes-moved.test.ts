import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, exited, launch, logged, openByHand, temp, until, workersPage, writeOpener } from './helpers.ts'

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

// Before anything else runs in main: hetu takes no focus and no window takes a click from the person at the machine.
// Playwright's clicks reach the page without the OS
async function quiet(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app, BrowserWindow }) => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    for (const window of BrowserWindow.getAllWindows()) window.setIgnoreMouseEvents(true)
    app.on('browser-window-created', (_event, window) => window.setIgnoreMouseEvents(true))
  })
}

async function launched(dataDir: string) {
  const app = await launch(dataDir)
  await quiet(app)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'core.ready'))
  return { app, editor }
}

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
  await writeOpener(dataDir)
  const { app, editor } = await launched(dataDir)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'mover' }))
  const page = await workersPage(app, 'mover')
  await until(() => page.workers().length === 1)
  return { app, editor, folder, dataDir, worker: page.workers()[0] as Worker }
}

const shown = (editor: Awaited<ReturnType<typeof editorPage>>) => editor.locator('.editor:not([hidden]) .cm-content')
const title = (editor: Awaited<ReturnType<typeof editorPage>>) => editor.locator('#title').innerText()

// Opened by hand from a row, as the human opens a note, with text typed after what it holds
async function typed(editor: Awaited<ReturnType<typeof editorPage>>, name: string, text: string): Promise<void> {
  await openByHand(editor, name)
  await shown(editor).click()
  await editor.keyboard.press('ControlOrMeta+End')
  await editor.keyboard.type(text)
  await until(async () => (await title(editor)) === `${name} (unsaved)`)
}

describe('an open note hetu moved', () => {
  it('follows the note to its new path with the unsaved text and saves there', async () => {
    const { editor, folder, worker } = await started({ 'a.md': 'alpha' })
    await typed(editor, 'a.md', ' typed')
    await drive(worker, async scope => scope.ctx.luoshu.move({ from: 'a.md', to: 'b.md' }))
    await until(async () => (await title(editor)) === 'b.md (unsaved)')
    expect(await editor.locator('#note-bar').isVisible()).toBe(false)
    await editor.keyboard.press('ControlOrMeta+s')
    await until(async () => (await readFile(path.join(folder, 'b.md'), 'utf8')) === 'alpha typed')
    expect((await readdir(folder)).sort()).toEqual(['b.md'])
    expect(await title(editor)).toBe('b.md')
  })

  it('offers the unsaved text at the new path after a quit', async () => {
    const { app, editor, dataDir, worker } = await started({ 'a.md': 'alpha' })
    await typed(editor, 'a.md', ' typed')
    await drive(worker, async scope => scope.ctx.luoshu.move({ from: 'a.md', to: 'b.md' }))
    await until(async () => (await title(editor)) === 'b.md (unsaved)')
    const done = exited(app)
    await editor.keyboard.press('ControlOrMeta+q')
    expect(await done).toBe(0)
    const again = await launched(dataDir)
    await openByHand(again.editor, 'b.md')
    await until(async () => (await again.editor.locator('#note-text').innerText()).includes('A draft of this note'))
    await again.editor.getByRole('button', { name: 'Restore' }).click()
    await until(async () => (await shown(again.editor).innerText()) === 'alpha typed')
  })
})
