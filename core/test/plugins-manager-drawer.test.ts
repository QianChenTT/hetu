import { afterEach, describe, expect, it } from 'vitest'
import type { ActionResults, CoreStatus } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import { cleanup, coreInstall, entryFor, filesFor, harness, stateOf, workerManifest } from './plugins-manager-fakes.ts'

afterEach(cleanup)

const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const call = (caller: Caller, action: string, args?: unknown) => ({ callId: 'c1', caller, root: caller, action, args, deadline: Date.now() + 30_000 })
const wrongHash = 'b'.repeat(64)

// Hidden marks runs as a worker behind the editor bridge, so the editor page applies no plugin's code itself
describe('core.status', () => {
  it('names no plugin for the editor page to apply', async () => {
    const { pluginsManager } = await harness({ install: coreInstall() })
    await pluginsManager.start()
    expect(Object.keys((await pluginsManager.serve(call(editor, 'core.status'))) as CoreStatus)).not.toContain('page')
  })
})

describe('a worker with a port to the drawer', () => {
  it('is marked at its start only when the plugin holds a ui item', async () => {
    const { pluginsManager, runtime } = await harness({
      folder: { alpha: filesFor(workerManifest('alpha'), { 'worker.js': 'a' }), beta: filesFor(workerManifest('beta'), { 'worker.js': 'b' }) },
      entries: {
        alpha: root => entryFor(root, { granted: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }] }),
        beta: root => entryFor(root, { granted: [{ type: 'luoshu.read', paths: ['**'] }] }),
      },
    })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, 'alpha')).toBe('ready')
    expect(stateOf(pluginsManager, 'beta')).toBe('ready')
    expect(runtime.drawers).toEqual(['alpha'])
  })

  it('hands it the verified files and frames, which serve its frames and icons, and none to a worker without a ui item', async () => {
    const views = { board: { title: 'Board', kind: 'view', frame: 'board' } }
    const { pluginsManager, runtime } = await harness({
      folder: {
        alpha: filesFor(workerManifest('alpha', { entries: { worker: 'worker.js', frames: { board: 'board.html' } }, views }), { 'worker.js': 'a', 'board.html': '<p>b</p>' }),
        beta: filesFor(workerManifest('beta'), { 'worker.js': 'b' }),
      },
      entries: {
        alpha: root => entryFor(root, { granted: [{ type: 'ui.view' }] }),
        beta: root => entryFor(root, { granted: [{ type: 'storage' }] }),
      },
    })
    await pluginsManager.start()
    const alpha = runtime.workerStarts.find(start => start.id === 'alpha')!
    expect(alpha.files?.map(file => file.path).sort()).toEqual(['board.html', 'hetu-plugin.json', 'worker.js'])
    expect(alpha.frames).toEqual({ board: 'board.html' })
    const beta = runtime.workerStarts.find(start => start.id === 'beta')!
    expect(beta.files ?? []).toEqual([])
  })
})

describe('core.views', () => {
  const views = { tree: { title: 'Notes', kind: 'view', size: { min: 160 } }, words: { title: 'Words', kind: 'item' } }
  const theme = { tokens: { 'color-bg': '#fafafa' } }

  it('lists each plugin that declares views or a theme, with whether it runs and has a worker', async () => {
    const { pluginsManager } = await harness({
      folder: {
        alpha: filesFor(workerManifest('alpha', { views }), { 'worker.js': 'a' }),
        beta: filesFor(workerManifest('beta', { theme }), { 'worker.js': 'b' }),
        gamma: filesFor(workerManifest('gamma'), { 'worker.js': 'c' }),
        delta: filesFor(workerManifest('delta', { views }), { 'worker.js': 'd' }),
      },
      entries: {
        alpha: root => entryFor(root, { granted: [{ type: 'ui.view' }] }),
        beta: root => entryFor(root, { granted: [] }),
        gamma: root => entryFor(root, { granted: [{ type: 'ui.view' }] }),
        delta: root => entryFor(root, { granted: [{ type: 'ui.view' }], enabled: false }),
      },
    })
    await pluginsManager.start()
    const listed = (await pluginsManager.serve(call(editor, 'core.views'))) as ActionResults['core.views']
    expect(listed.plugins.sort((a, b) => a.plugin.localeCompare(b.plugin))).toEqual([
      { plugin: 'alpha', name: 'alpha', running: true, worker: true, views, theme: null },
      { plugin: 'beta', name: 'beta', running: true, worker: true, views: {}, theme },
      { plugin: 'delta', name: 'delta', running: false, worker: true, views, theme: null },
    ])
  })

  it('leaves out a plugin whose bytes fail their check', async () => {
    const { pluginsManager } = await harness({
      folder: { alpha: filesFor(workerManifest('alpha', { views }), { 'worker.js': 'a' }) },
      entries: { alpha: root => entryFor(root, { granted: [{ type: 'ui.view' }], contentHash: wrongHash }) },
    })
    await pluginsManager.start()
    expect(((await pluginsManager.serve(call(editor, 'core.views'))) as ActionResults['core.views']).plugins).toEqual([])
  })
})
