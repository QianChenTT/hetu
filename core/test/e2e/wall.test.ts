import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, hostManifest, workerManifest, writeFolder, writeInstall } from '../loader-fakes.ts'
import { cleanup, exited, launch, logged, temp, until, workersPage } from './helpers.ts'

afterEach(cleanup)

// The luoshu's host half as one ES module, which can import only Node's built-ins: its plugin and its provider role
const host = `
export default Object.freeze({ kind: 'hetu-plugin', spec: Object.freeze({ start() {} }) })
export const provider = {
  async prepare(call) {
    return { scope: { paths: [call.args.path] } }
  },
  async perform(call, prepared) {
    return { text: 'hello from the host half: ' + prepared.scope.paths[0], version: 'v1' }
  },
}
`

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

// The install holds the luoshu, and the gate and the log switched off, which lets calls through until they are built
async function prepared(): Promise<{ dataDir: string, installDir: string }> {
  const installDir = await temp()
  await writeInstall(installDir, {
    luoshu: { files: filesFor(hostManifest('luoshu'), { 'host.js': host }) },
    gate: { files: filesFor(hostManifest('gate')) },
    log: { files: filesFor(hostManifest('log')) },
  })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': hello })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: ['gate', 'log'] })
  const root = path.join(dataDir, 'plugins', 'hello')
  await writeFolder(root, filesFor(workerManifest('hello', { requires: ['luoshu'], capabilities: read }), { 'worker.js': built.text }))
  await store.writePlugin('hello', await entryFor(root, { granted: read }))
  return { dataDir, installDir }
}

describe('one call across the wall', () => {
  it('has a sandboxed worker read a note through a host half\'s provider and get its answer', async () => {
    const { dataDir, installDir } = await prepared()
    const app = await launch(dataDir, { HETU_INSTALL_DIR: installDir })
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'luoshu' }))
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'hello' }))
    const page = await workersPage(app, 'hello')
    await until(() => page.workers().length === 1)
    let answer: unknown
    await until(async () => {
      answer = await page.workers()[0].evaluate(() => (globalThis as { answer?: unknown }).answer)
      return answer !== undefined
    })
    expect(answer).toEqual({ ok: true, value: { text: 'hello from the host half: notes/a.md', version: 'v1' } })
    // main froze its built-ins before the host half loaded, and runs and quits in order with them frozen
    expect(await app.evaluate(() => [Object.isFrozen(Array.prototype), Object.isFrozen(Set.prototype)])).toEqual([true, true])
    const done = exited(app)
    await app.close()
    expect(await done).toBe(0)
    expect(await logged(dataDir, 'core.stopping')).toBe(true)
  })
})
