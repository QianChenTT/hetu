import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, launch, logged, temp, tick, until, workersPage } from './helpers.ts'

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// A plugin that hands its ctx to the test and keeps each note the editor tells it opened. An opener draws a row per
// note in its view, each carrying its note as a file tree's rows do
const fixture = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const scope = globalThis as Record<string, unknown>
    scope.ctx = ctx
    const heard: string[] = []
    scope.heard = heard
    ctx.editor.on('opened', event => heard.push((event as { instance: string }).instance))
    ctx.ui.on('view.opened', event => {
      void ctx.ui.views.draw(event.instance, {
        kind: 'box', id: 'root',
        children: ['a.md', 'b.md'].map(name => ({ kind: 'button', id: name.replace('.', '-'), text: 'Row ' + name, drag: { type: 'note', value: name } })),
      }).catch(() => {})
    })
  },
})
`

type Scope = { ctx: { editor: Record<string, (...args: unknown[]) => Promise<unknown>> }, heard: string[] }
const drive = <T>(worker: Worker, work: (scope: Scope) => Promise<T> | T) => worker.evaluate(`(${work.toString()})(globalThis)`) as Promise<T>

async function pluginWorker(app: ElectronApplication, id: string): Promise<Worker> {
  const page = await workersPage(app, id)
  await until(() => page.workers().length === 1)
  return page.workers()[0] as Worker
}

async function started(plugins: Record<string, { granted: Capability[], views?: object }>) {
  const folder = await temp()
  await writeFile(path.join(folder, 'a.md'), 'alpha')
  await writeFile(path.join(folder, 'b.md'), 'beta')
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': fixture })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  for (const [id, plugin] of Object.entries(plugins)) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, { capabilities: plugin.granted, ...(plugin.views === undefined ? {} : { views: plugin.views }) }), { 'worker.js': built.text }))
    await writeApproved(store, id, root, { granted: plugin.granted })
  }
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'core.ready'))
  for (const id of Object.keys(plugins)) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  return { app, editor }
}

describe('the human\'s open', () => {
  // A plugin that reads notes through ui.read alone hears of a note only once the human opened it: from a node carrying
  // the note, never from another plugin's editor.open
  it('reaches a ui.read plugin through a row carrying its note, never through a plugin\'s editor.open', async () => {
    const { app, editor } = await started({
      opener: { granted: [{ type: 'ui.view' }, { type: 'luoshu.list', paths: ['**'] }, { type: 'luoshu.read', paths: ['b.md'] }], views: { rows: { title: 'Rows', kind: 'view' } } },
      marks: { granted: [{ type: 'ui.read', paths: ['**'] }] },
    })
    const opener = await pluginWorker(app, 'opener')
    const marks = await pluginWorker(app, 'marks')
    const row = (name: string) => editor.locator('#editors .hetu-button', { hasText: 'Row ' + name })
    await until(async () => (await row('a.md').count()) === 1)
    await drive(opener, scope => scope.ctx.editor.open('b.md'))
    await until(async () => (await drive(opener, scope => scope.heard.length)) === 1)
    await tick(500)
    expect(await drive(marks, scope => scope.heard)).toEqual([])
    expect(await drive(marks, scope => scope.ctx.editor.instances())).toEqual([])
    await row('a.md').click()
    await until(async () => (await editor.locator('#title').innerText()).startsWith('a.md'))
    await until(async () => (await drive(marks, scope => scope.heard.length)) === 1)
    const seen = await drive(marks, scope => scope.ctx.editor.instances()) as { path: string }[]
    expect(seen.map(each => each.path)).toEqual(['a.md'])
  })
})
