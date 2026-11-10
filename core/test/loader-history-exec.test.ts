import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecView, Opening } from '../api/slots.ts'
import { StateStore } from '../backend/boot/state.ts'
import { cleanup, coreInstall, entryFor, filesFor, harness, hostManifest, reasonOf, stateOf, until, workerManifest } from './loader-fakes.ts'

afterEach(cleanup)

const install = () => ({
  ...coreInstall(),
  luoshu: { files: filesFor(hostManifest('luoshu')) },
  history: { files: filesFor(hostManifest('history', { requires: ['luoshu'] })) },
  exec: { files: filesFor(hostManifest('exec')) },
})

function historyRole(throws = false) {
  const opened: Opening[] = []
  return { opened, open(opening: Opening) {
    opened.push(opening)
    if (throws) throw new Error('can\'t open')
  } }
}

function execRole(throws = false) {
  const seen: ExecView[] = []
  return { seen, stateChanged(view: ExecView) {
    seen.push(view)
    if (throws) throw new Error('can\'t read')
  } }
}

const status = { type: 'exec' as const, commands: [['git', 'status']], env: ['HOME'] }
const push = { type: 'exec' as const, commands: [['git', 'push'], ['git', 'fetch']], env: ['HOME', 'SSH_AUTH_SOCK'] }
const read = { type: 'luoshu.read' as const, paths: ['**'] }
const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const worker = (id: string, capabilities: object[]) => filesFor(workerManifest(id, { capabilities }))

describe('history\'s folder', () => {
  it('goes to history with hetu\'s data and install folders once it is ready, null with none picked', async () => {
    const history = historyRole()
    const made = await harness({ install: install(), behave: { history: { exports: { history } } } })
    await made.loader.start()
    await until(() => stateOf(made.loader, 'history') === 'ready')
    expect(history.opened).toEqual([{ folder: null, dataDir: made.dataDir, installDir: made.installDir }])
  })

  it('is the state\'s at ready and the new one each time luoshu.set applies, as the luoshu\'s is', async () => {
    const history = historyRole()
    let first = ''
    const made = await harness({
      install: install(),
      behave: { history: { exports: { history } } },
      before: async ({ dataDir }) => {
        first = path.join(dataDir, '..', 'notes')
        await new StateStore(dataDir).writeLuoshu({ folder: first })
      },
    })
    await made.loader.start()
    await until(() => stateOf(made.loader, 'history') === 'ready')
    const second = path.join(made.base, 'other notes')
    await made.loader.apply({ kind: 'luoshu.set', folder: second })
    expect(history.opened.map(opening => opening.folder)).toEqual([first, second])
  })

  it('marks history failed when its open throws, and when its module gives no history role', async () => {
    const throwing = await harness({ install: install(), behave: { history: { exports: { history: historyRole(true) } } } })
    await throwing.loader.start()
    await until(() => stateOf(throwing.loader, 'history') === 'failed')
    expect(reasonOf(throwing.loader, 'history')).toBe('state-changed')
    const none = await harness({ install: install(), behave: { history: { exports: {} } } })
    await none.loader.start()
    await until(() => stateOf(none.loader, 'history') === 'failed')
    expect(reasonOf(none.loader, 'history')).toBe('no-role')
  })

  it('waits while the luoshu is switched off, since history requires it', async () => {
    const history = historyRole()
    const made = await harness({
      install: install(),
      behave: { history: { exports: { history } } },
      before: async ({ dataDir }) => {
        const store = new StateStore(dataDir)
        await store.writeSwitches({ ...(await store.load()).state.switches, off: ['luoshu'] })
      },
    })
    await made.loader.start()
    await made.loader.settled()
    expect(stateOf(made.loader, 'luoshu')).toBe('off')
    expect(stateOf(made.loader, 'history')).toBe('waiting')
    expect(history.opened).toEqual([])
  })
})

describe('exec\'s view of the grants', () => {
  async function started(exec = execRole()) {
    const made = await harness({
      install: install(),
      folder: { git: worker('git', [status, push, read]), search: worker('search', [read]) },
      entries: { git: signed({ granted: [status, push, read] }), search: signed({ granted: [read] }) },
      behave: { exec: { exports: { exec } } },
    })
    await made.loader.start()
    await until(() => stateOf(made.loader, 'exec') === 'ready')
    return { ...made, exec }
  }

  it('goes to exec once it is ready: each plugin\'s exec items and nothing else it holds, the any command list and the folders', async () => {
    const { exec, dataDir, installDir } = await started()
    expect(exec.seen).toHaveLength(1)
    const view = exec.seen[0]
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
    await made.loader.apply({ kind: 'exec.anyCommand', plugin: 'git', on: true })
    expect(made.exec.seen.at(-1)!.any).toEqual(['git'])
    const folder = path.join(made.base, 'notes')
    await made.loader.apply({ kind: 'luoshu.set', folder })
    expect(made.exec.seen.at(-1)!.opening.folder).toBe(folder)
    expect(made.exec.seen.at(-1)!.any).toEqual(['git'])
    await made.loader.apply({ kind: 'plugin.off', plugin: 'git' })
    expect(made.exec.seen.at(-1)!.plugins).toEqual({})
    expect(made.exec.seen.length).toBeGreaterThanOrEqual(4)
  })

  // Exec keeps its own list with the gate off, so an item the human switched off leaves that list too. Otherwise the
  // command would run again exactly when the gate isn't there to refuse it
  it('drops an exec item the human switched off and takes it back when switched on again', async () => {
    const made = await started()
    await made.loader.apply({ kind: 'item.off', plugin: 'git', capability: status })
    expect(made.exec.seen.at(-1)!.plugins.git.map(item => item.commands)).toEqual([[['git', 'push'], ['git', 'fetch']]])
    await made.loader.apply({ kind: 'item.off', plugin: 'git', capability: push })
    expect(made.exec.seen.at(-1)!.plugins).toEqual({})
    await made.loader.apply({ kind: 'item.on', plugin: 'git', capability: status })
    expect(made.exec.seen.at(-1)!.plugins.git.map(item => item.commands)).toEqual([[['git', 'status']]])
  })

  it('marks exec failed when it throws on a view, and when its module gives no exec role', async () => {
    const throwing = await harness({ install: install(), behave: { exec: { exports: { exec: execRole(true) } } } })
    await throwing.loader.start()
    await until(() => stateOf(throwing.loader, 'exec') === 'failed')
    expect(reasonOf(throwing.loader, 'exec')).toBe('state-changed')
    const none = await harness({ install: install(), behave: { exec: { exports: {} } } })
    await none.loader.start()
    await until(() => stateOf(none.loader, 'exec') === 'failed')
    expect(reasonOf(none.loader, 'exec')).toBe('no-role')
  })

  // A plugin added later under the same id must ask again, so nothing the human let the old one do carries over
  it('forgets the any command switch, dev mode and raised limits of a plugin it removes', async () => {
    const made = await started()
    await made.loader.apply({ kind: 'exec.anyCommand', plugin: 'git', on: true })
    await made.loader.apply({ kind: 'devMode', plugin: 'git', on: true })
    await made.loader.apply({ kind: 'limit.set', constant: 'callsInFlight', value: 128, plugin: 'git' })
    await made.loader.apply({ kind: 'exec.anyCommand', plugin: 'search', on: true })
    await made.loader.apply({ kind: 'plugin.remove', plugin: 'git' })
    const { switches } = (await made.store.load()).state
    expect(switches.execAnyCommand).toEqual(['search'])
    expect(switches.devMode).toEqual([])
    expect(Object.keys(switches.limits.plugins)).toEqual([])
    expect(made.exec.seen.at(-1)!.any).toEqual(['search'])
  })

  it('marks exec failed when it throws on a later view', async () => {
    const exec = execRole()
    const made = await started(exec)
    exec.stateChanged = () => { throw new Error('can\'t read') }
    await made.loader.apply({ kind: 'exec.anyCommand', plugin: 'git', on: true })
    expect(stateOf(made.loader, 'exec')).toBe('failed')
    expect(reasonOf(made.loader, 'exec')).toBe('state-changed')
  })
})
