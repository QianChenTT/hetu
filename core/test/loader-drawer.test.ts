import { afterEach, describe, expect, it } from 'vitest'
import type { CoreStatus } from '../api/actions.ts'
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
})
