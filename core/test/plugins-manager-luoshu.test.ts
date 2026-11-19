import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateStore } from '../backend/boot/state.ts'
import { cleanup, fakeHistory, fakeLuoshu, harness } from './plugins-manager-fakes.ts'

afterEach(cleanup)

describe('the luoshu\'s folder', () => {
  it('goes to the luoshu with hetu\'s data and install folders once the core starts, null with none picked', async () => {
    const luoshu = fakeLuoshu()
    const made = await harness({ modules: { luoshu } })
    await made.pluginsManager.start()
    expect(made.modules.state('luoshu')).toBe('on')
    expect(luoshu.opened).toEqual([{ folder: null, dataDir: made.dataDir, installDir: made.installDir }])
  })

  // A remove goes to the bin the runtime gave. History reads the same folder and gets no way to delete anything
  it('hands the luoshu the bin the runtime gave the core, and history the folders alone', async () => {
    const luoshu = fakeLuoshu()
    const history = fakeHistory()
    const trash = async () => {}
    const made = await harness({ modules: { luoshu, history, trash } })
    await made.pluginsManager.start()
    expect(luoshu.opened).toEqual([{ folder: null, dataDir: made.dataDir, installDir: made.installDir, trash }])
    expect(history.opened).toEqual([{ folder: null, dataDir: made.dataDir, installDir: made.installDir }])
  })

  it('is the state\'s at start and the new one each time luoshu.pick applies', async () => {
    const luoshu = fakeLuoshu()
    let first = ''
    const made = await harness({
      modules: { luoshu },
      before: async ({ dataDir }) => {
        first = path.join(dataDir, '..', 'notes')
        await new StateStore(dataDir).writeLuoshu({ folder: first })
      },
    })
    await made.pluginsManager.start()
    const second = path.join(made.base, 'other notes')
    await made.pluginsManager.apply({ kind: 'luoshu.pick', folder: second })
    expect(luoshu.opened.map(opening => opening.folder)).toEqual([first, second])
  })

  it('marks the luoshu failed when its open throws, with a fault and nothing stopped, until a pick goes through', async () => {
    const luoshu = fakeLuoshu()
    luoshu.throws = true
    const made = await harness({ modules: { luoshu } })
    await made.pluginsManager.start()
    expect(made.modules.state('luoshu')).toBe('failed')
    expect(made.modules.reason('luoshu')).toBe('state-changed')
    expect(made.link.events('fault')).toContainEqual({ plugin: 'luoshu', step: 'open' })
    expect(made.pluginsManager.stopped()).toBeNull()
    luoshu.throws = false
    await made.pluginsManager.apply({ kind: 'luoshu.pick', folder: path.join(made.base, 'notes') })
    expect(made.modules.state('luoshu')).toBe('on')
  })

  it('hands nothing to a luoshu switched off and the folder once it is switched on again', async () => {
    const luoshu = fakeLuoshu()
    const made = await harness({ modules: { luoshu }, switches: { off: ['luoshu'] } })
    await made.pluginsManager.start()
    expect(made.modules.state('luoshu')).toBe('off')
    const folder = path.join(made.base, 'notes')
    await made.pluginsManager.apply({ kind: 'luoshu.pick', folder })
    expect(luoshu.opened).toEqual([])
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: 'luoshu' })
    expect(made.modules.state('luoshu')).toBe('on')
    expect(luoshu.opened.map(opening => opening.folder)).toEqual([folder])
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'luoshu' })
    expect(luoshu.closed).toBe(1)
  })
})
