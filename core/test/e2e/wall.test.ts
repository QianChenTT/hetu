import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeInstall, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, exited, launch, logged, temp, until, workersPage } from './helpers.ts'

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// A sandboxed plugin built with the SDK: it reads a note through the luoshu once started and keeps the answer
const hello = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    void ctx.try(ctx.luoshu.read({ path: 'notes/a.md' })).then(answer => {
      ;(globalThis as { answer?: unknown }).answer = answer
    })
  },
})
`

const read = [{ type: 'luoshu.read' as const, paths: ['**'] }]

// The install holds no plugin, the luoshu module serves a notes folder holding notes/a.md and the gate is switched
// off, so what is under test is the wall and not a grant
async function prepared(): Promise<{ dataDir: string, installDir: string }> {
  const installDir = await temp()
  await writeInstall(installDir, {})
  const folder = await temp()
  await writeFolder(folder, { 'notes/a.md': 'hello from the luoshu' })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': hello })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: ['gate'] })
  await store.writeLuoshu({ folder })
  const root = path.join(dataDir, 'plugins', 'hello')
  await writeFolder(root, filesFor(workerManifest('hello', { requires: ['luoshu'], capabilities: read }), { 'worker.js': built.text }))
  await writeApproved(store, 'hello', root, { granted: read })
  return { dataDir, installDir }
}

describe('one call across the wall', () => {
  it('has a sandboxed worker read a note through the luoshu module in main and get its answer', async () => {
    const { dataDir, installDir } = await prepared()
    const app = await launch(dataDir, { HETU_INSTALL_DIR: installDir })
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'hello' }))
    const page = await workersPage(app, 'hello')
    await until(() => page.workers().length === 1)
    let answer: unknown
    await until(async () => {
      answer = await page.workers()[0].evaluate(() => (globalThis as { answer?: unknown }).answer)
      return answer !== undefined
    })
    expect(answer).toMatchObject({ ok: true, value: { text: 'hello from the luoshu', path: 'notes/a.md' } })
    // main froze its built-ins before the plugins manager started, and runs and quits in order with them frozen
    expect(await app.evaluate(() => [Object.isFrozen(Array.prototype), Object.isFrozen(Set.prototype)])).toEqual([true, true])
    const done = exited(app)
    await app.close()
    expect(await done).toBe(0)
    expect(await logged(dataDir, 'core.stopping')).toBe(true)
  })
})
