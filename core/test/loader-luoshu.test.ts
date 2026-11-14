import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateStore } from '../backend/boot/state.ts'
import type { Opening } from '../api/slots.ts'
import { cleanup, coreInstall, filesFor, harness, hostManifest, reasonOf, stateOf, until } from './loader-fakes.ts'

afterEach(cleanup)

const install = () => ({ ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) } })

function role(throws = false) {
  const opened: Opening[] = []
  return { opened, open(opening: Opening) {
    opened.push(opening)
    if (throws) throw new Error('can\'t open')
  } }
}

describe('the luoshu\'s folder', () => {
  it('goes to the luoshu with hetu\'s data and install folders once it is ready, null with none picked', async () => {
    const luoshu = role()
    const made = await harness({ install: install(), behave: { luoshu: { exports: { luoshu } } } })
    await made.loader.start()
    await until(() => stateOf(made.loader, 'luoshu') === 'ready')
    expect(luoshu.opened).toEqual([{ folder: null, dataDir: made.dataDir, installDir: made.installDir }])
  })

  // A remove goes to the bin the runtime gave. History reads the same folder and gets no way to delete anything
  it('hands the luoshu the bin the runtime gave the loader, and history the folders alone', async () => {
    const luoshu = role()
    const history = role()
    const trash = async () => {}
    const made = await harness({
      install: { ...install(), history: { files: filesFor(hostManifest('history', { requires: ['luoshu'] })) } },
      behave: { luoshu: { exports: { luoshu } }, history: { exports: { history } } },
      loader: { trash },
    })
    await made.loader.start()
    await until(() => stateOf(made.loader, 'history') === 'ready')
    expect(luoshu.opened).toEqual([{ folder: null, dataDir: made.dataDir, installDir: made.installDir, trash }])
    expect(history.opened).toEqual([{ folder: null, dataDir: made.dataDir, installDir: made.installDir }])
  })

  it('is the state\'s at ready and the new one each time luoshu.set applies', async () => {
    const luoshu = role()
    let first = ''
    const made = await harness({
      install: install(),
      behave: { luoshu: { exports: { luoshu } } },
      before: async ({ dataDir }) => {
        first = path.join(dataDir, '..', 'notes')
        await new StateStore(dataDir).writeLuoshu({ folder: first })
      },
    })
    await made.loader.start()
    await until(() => stateOf(made.loader, 'luoshu') === 'ready')
    const second = path.join(made.base, 'other notes')
    await made.loader.apply({ kind: 'luoshu.set', folder: second })
    expect(luoshu.opened.map(opening => opening.folder)).toEqual([first, second])
  })

  it('marks the luoshu failed when its open throws, and when its module gives no luoshu role', async () => {
    const throwing = await harness({ install: install(), behave: { luoshu: { exports: { luoshu: role(true) } } } })
    await throwing.loader.start()
    await until(() => stateOf(throwing.loader, 'luoshu') === 'failed')
    expect(reasonOf(throwing.loader, 'luoshu')).toBe('state-changed')
    const none = await harness({ install: install(), behave: { luoshu: { exports: {} } } })
    await none.loader.start()
    await until(() => stateOf(none.loader, 'luoshu') === 'failed')
    expect(reasonOf(none.loader, 'luoshu')).toBe('no-role')
  })
})
