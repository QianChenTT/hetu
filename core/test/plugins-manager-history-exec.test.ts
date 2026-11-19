import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateStore } from '../backend/boot/state.ts'
import { cleanup, entryFor, fakeExec, fakeHistory, fakeLuoshu, filesFor, harness, workerManifest } from './plugins-manager-fakes.ts'

afterEach(cleanup)

const status = { type: 'exec' as const, commands: [['git', 'status']], env: ['HOME'] }
const push = { type: 'exec' as const, commands: [['git', 'push'], ['git', 'fetch']], env: ['HOME', 'SSH_AUTH_SOCK'] }
const read = { type: 'luoshu.read' as const, paths: ['**'] }
const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const worker = (id: string, capabilities: object[]) => filesFor(workerManifest(id, { capabilities }))

describe('history\'s folder', () => {
  it('goes to history with hetu\'s data and install folders once the core starts, null with none picked', async () => {
    const history = fakeHistory()
    const made = await harness({ modules: { history } })
    await made.pluginsManager.start()
    expect(history.started).toBe(1)
    expect(history.opened).toEqual([{ folder: null, dataDir: made.dataDir, installDir: made.installDir }])
  })

  it('is the state\'s at start and the new one each time luoshu.pick applies, as the luoshu\'s is', async () => {
    const history = fakeHistory()
    let first = ''
    const made = await harness({
      modules: { history },
      before: async ({ dataDir }) => {
        first = path.join(dataDir, '..', 'notes')
        await new StateStore(dataDir).writeLuoshu({ folder: first })
      },
    })
    await made.pluginsManager.start()
    const second = path.join(made.base, 'other notes')
    await made.pluginsManager.apply({ kind: 'luoshu.pick', folder: second })
    expect(history.opened.map(opening => opening.folder)).toEqual([first, second])
  })

  it('marks history failed when its open throws, with a fault and nothing stopped, until the next pick goes through', async () => {
    const history = fakeHistory()
    history.throws = true
    const made = await harness({ modules: { history } })
    await made.pluginsManager.start()
    expect(made.modules.state('history')).toBe('failed')
    expect(made.modules.reason('history')).toBe('state-changed')
    expect(made.modules.provider('history')).toBeNull()
    expect(made.link.events('fault')).toContainEqual({ plugin: 'history', step: 'open' })
    expect(made.pluginsManager.stopped()).toBeNull()
    history.throws = false
    await made.pluginsManager.apply({ kind: 'luoshu.pick', folder: path.join(made.base, 'notes') })
    expect(made.modules.state('history')).toBe('on')
    expect(made.modules.provider('history')).toBe(history.provider)
  })

  // History with no git to run answers unavailable and hetu runs on
  it('marks history failed when its start throws, its provider answering none', async () => {
    const history = fakeHistory()
    history.fails = true
    const made = await harness({ modules: { history } })
    await made.pluginsManager.start()
    expect(made.modules.state('history')).toBe('failed')
    expect(made.modules.reason('history')).toBe('start-failed')
    expect(made.modules.provider('history')).toBeNull()
    expect(made.link.events('fault')).toContainEqual({ plugin: 'history', step: 'start' })
    expect(made.pluginsManager.stopped()).toBeNull()
  })

  it('serves nothing while the luoshu is switched off, since history reads the luoshu\'s folder', async () => {
    const history = fakeHistory()
    const luoshu = fakeLuoshu()
    const made = await harness({
      modules: { history, luoshu },
      before: async ({ dataDir }) => {
        const store = new StateStore(dataDir)
        await store.writeSwitches({ ...(await store.load()).state.switches, off: ['luoshu'] })
      },
    })
    await made.pluginsManager.start()
    expect(made.modules.state('luoshu')).toBe('off')
    expect(made.modules.provider('history')).toBeNull()
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: 'luoshu' })
    expect(made.modules.provider('history')).toBe(history.provider)
  })
})

describe('exec\'s view of the grants', () => {
  async function started(exec = fakeExec()) {
    const made = await harness({
      folder: { git: worker('git', [status, push, read]), search: worker('search', [read]) },
      entries: { git: signed({ granted: [status, push, read] }), search: signed({ granted: [read] }) },
      modules: { exec },
    })
    await made.pluginsManager.start()
    return { ...made, exec }
  }

  it('goes to exec once the core starts and with each bump: each plugin\'s exec items and nothing else it holds, the any command list and the folders', async () => {
    const { exec, dataDir, installDir } = await started()
    expect(exec.started).toBe(1)
    const view = exec.views.at(-1)!
    expect(view.plugins).toEqual({
      git: [{ commands: [['git', 'status']], env: ['HOME'] }, { commands: [['git', 'push'], ['git', 'fetch']], env: ['HOME', 'SSH_AUTH_SOCK'] }],
    })
    expect(view.any).toEqual([])
    expect(view.opening).toEqual({ folder: null, dataDir, installDir })
    // Read-only, with no prototype for a plugin id to find something on
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.plugins.git[0].commands[0])).toBe(true)
    expect(Object.getPrototypeOf(view.plugins)).toBeNull()
  })

  it('is renewed with every applied change: the any command switch, the notes folder and a plugin switched off', async () => {
    const made = await started()
    await made.pluginsManager.apply({ kind: 'exec.anyCommand', plugin: 'git', on: true })
    expect(made.exec.views.at(-1)!.any).toEqual(['git'])
    const folder = path.join(made.base, 'notes')
    await made.pluginsManager.apply({ kind: 'luoshu.pick', folder })
    expect(made.exec.views.at(-1)!.opening.folder).toBe(folder)
    expect(made.exec.views.at(-1)!.any).toEqual(['git'])
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'git' })
    expect(made.exec.views.at(-1)!.plugins).toEqual({})
    expect(made.exec.views.length).toBeGreaterThanOrEqual(4)
  })

  // Exec keeps its own list with the gate off, so an item the human switched off leaves that list too. Otherwise the
  // command would run again exactly when the gate isn't there to refuse it
  it('drops an exec item the human switched off and takes it back when switched on again', async () => {
    const made = await started()
    await made.pluginsManager.apply({ kind: 'item.off', plugin: 'git', capability: status })
    expect(made.exec.views.at(-1)!.plugins.git.map(item => item.commands)).toEqual([[['git', 'push'], ['git', 'fetch']]])
    await made.pluginsManager.apply({ kind: 'item.off', plugin: 'git', capability: push })
    expect(made.exec.views.at(-1)!.plugins).toEqual({})
    await made.pluginsManager.apply({ kind: 'item.on', plugin: 'git', capability: status })
    expect(made.exec.views.at(-1)!.plugins.git.map(item => item.commands)).toEqual([[['git', 'status']]])
  })

  it('marks exec failed when it throws on a view, with a fault and nothing stopped, until a view goes through', async () => {
    const exec = fakeExec()
    exec.throws = true
    const made = await started(exec)
    expect(made.modules.state('exec')).toBe('failed')
    expect(made.modules.reason('exec')).toBe('state-changed')
    expect(made.modules.provider('exec')).toBeNull()
    expect(made.link.events('fault')).toContainEqual({ plugin: 'exec', step: 'stateChanged' })
    expect(made.pluginsManager.stopped()).toBeNull()
    exec.throws = false
    await made.pluginsManager.apply({ kind: 'exec.anyCommand', plugin: 'git', on: true })
    expect(made.modules.state('exec')).toBe('on')
    expect(made.exec.views.at(-1)!.any).toEqual(['git'])
  })

  // A plugin added later under the same id must ask again, so nothing the human let the old one do carries over
  it('forgets the any command switch, dev mode and raised limits of a plugin it removes', async () => {
    const made = await started()
    await made.pluginsManager.apply({ kind: 'exec.anyCommand', plugin: 'git', on: true })
    await made.pluginsManager.apply({ kind: 'devMode', plugin: 'git', on: true })
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'callsInFlight', value: 128, plugin: 'git' })
    await made.pluginsManager.apply({ kind: 'exec.anyCommand', plugin: 'search', on: true })
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'git' })
    const { switches } = (await made.store.load()).state
    expect(switches.execAnyCommand).toEqual(['search'])
    expect(switches.devMode).toEqual([])
    expect(Object.keys(switches.limits.plugins)).toEqual([])
    expect(made.exec.views.at(-1)!.any).toEqual(['search'])
  })

  it('marks exec failed when it throws on a later view', async () => {
    const made = await started()
    made.exec.throws = true
    await made.pluginsManager.apply({ kind: 'exec.anyCommand', plugin: 'git', on: true })
    expect(made.modules.state('exec')).toBe('failed')
    expect(made.modules.reason('exec')).toBe('state-changed')
  })

  it('hands exec no view while switched off and the newest once switched on again', async () => {
    const made = await started()
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'exec' })
    expect(made.exec.closed).toBe(1)
    const seen = made.exec.views.length
    await made.pluginsManager.apply({ kind: 'exec.anyCommand', plugin: 'git', on: true })
    expect(made.exec.views).toHaveLength(seen)
    expect(made.modules.provider('exec')).toBeNull()
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: 'exec' })
    expect(made.exec.started).toBe(2)
    expect(made.exec.views.at(-1)!.any).toEqual(['git'])
  })
})
