import { afterEach, describe, expect, it } from 'vitest'
import type { ActionResults, CoreStatus } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import { cleanup, coreInstall, entryFor, filesFor, harness, manifest, stateOf, workerManifest } from './loader-fakes.ts'

afterEach(cleanup)

const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const call = (caller: Caller, action: string, args?: unknown) => ({ callId: 'c1', caller, action, args, deadline: Date.now() + 30_000 })
const wrongHash = 'b'.repeat(64)

// hidden-marks as the build puts it in the install: a manifest with a page entry and the module's bundle
const hiddenMarks = () => ({ files: filesFor(manifest('hidden-marks', { entries: { page: 'dist/page.js' } }), { 'dist/page.js': '// hidden marks' }) })

describe('in-page plugins', () => {
  it('names an in-page install plugin in core.status while it is ready', async () => {
    const { loader } = await harness({ install: { ...coreInstall(), 'hidden-marks': hiddenMarks() } })
    await loader.start()
    expect(stateOf(loader, 'hidden-marks')).toBe('ready')
    expect(((await loader.serve(call(editor, 'core.status'))) as CoreStatus).page).toEqual(['hidden-marks'])
  })

  it('leaves it out once the human switched it off', async () => {
    const { loader } = await harness({ install: { ...coreInstall(), 'hidden-marks': hiddenMarks() }, switches: { off: ['hidden-marks'] } })
    await loader.start()
    expect(((await loader.serve(call(editor, 'core.status'))) as CoreStatus).page).toEqual([])
  })

  it('leaves it out when its bytes fail the install list', async () => {
    const { loader } = await harness({ install: { ...coreInstall(), 'hidden-marks': { ...hiddenMarks(), hash: wrongHash } } })
    await loader.start()
    expect(stateOf(loader, 'hidden-marks')).toBe('refused')
    expect(((await loader.serve(call(editor, 'core.status'))) as CoreStatus).page).toEqual([])
  })
})

describe('a worker with a port to the drawer', () => {
  it('is marked at its start only when the plugin holds a ui item', async () => {
    const { loader, runtime } = await harness({
      folder: { alpha: filesFor(workerManifest('alpha'), { 'worker.js': 'a' }), beta: filesFor(workerManifest('beta'), { 'worker.js': 'b' }) },
      entries: {
        alpha: root => entryFor(root, { granted: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }] }),
        beta: root => entryFor(root, { granted: [{ type: 'luoshu.read', paths: ['**'] }] }),
      },
    })
    await loader.start()
    expect(stateOf(loader, 'alpha')).toBe('ready')
    expect(stateOf(loader, 'beta')).toBe('ready')
    expect(runtime.drawers).toEqual(['alpha'])
  })

  it('hands it the verified files and frames, which serve its frames and icons, and none to a worker without a ui item', async () => {
    const views = { board: { title: 'Board', kind: 'view', frame: 'board' } }
    const { loader, runtime } = await harness({
      folder: {
        alpha: filesFor(workerManifest('alpha', { entries: { worker: 'worker.js', frames: { board: 'board.html' } }, views }), { 'worker.js': 'a', 'board.html': '<p>b</p>' }),
        beta: filesFor(workerManifest('beta'), { 'worker.js': 'b' }),
      },
      entries: {
        alpha: root => entryFor(root, { granted: [{ type: 'ui.view' }] }),
        beta: root => entryFor(root, { granted: [{ type: 'storage' }] }),
      },
    })
    await loader.start()
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
    const { loader } = await harness({
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
    await loader.start()
    const listed = (await loader.serve(call(editor, 'core.views'))) as ActionResults['core.views']
    expect(listed.plugins.sort((a, b) => a.plugin.localeCompare(b.plugin))).toEqual([
      { plugin: 'alpha', name: 'alpha', running: true, worker: true, views, theme: null },
      { plugin: 'beta', name: 'beta', running: true, worker: true, views: {}, theme },
      { plugin: 'delta', name: 'delta', running: false, worker: true, views, theme: null },
    ])
  })

  it('leaves out a plugin whose bytes fail their check', async () => {
    const { loader } = await harness({
      folder: { alpha: filesFor(workerManifest('alpha', { views }), { 'worker.js': 'a' }) },
      entries: { alpha: root => entryFor(root, { granted: [{ type: 'ui.view' }], contentHash: wrongHash }) },
    })
    await loader.start()
    expect(((await loader.serve(call(editor, 'core.views'))) as ActionResults['core.views']).plugins).toEqual([])
  })
})
