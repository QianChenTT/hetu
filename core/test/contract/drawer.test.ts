import { describe, vi } from 'vitest'
import { fakeCore, FakeDrawer } from '../../sdk/testing/index.ts'
import { drawerCases, type MakeDrawer, notes } from './drawer.cases.ts'
import { type Ask, probe, probeManifest } from './drawer-probe.ts'

// FakeDrawer on the drawer's cases, the probe's worker under the fake core and its frame played by the fake's own
// FakeFrame. Date is a fake clock the press credit reads, moved on for time passing. The real drawer runs the same
// cases on the driven build in tier0/drawer.real.test.ts
const fake: MakeDrawer = async context => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const drawer = new FakeDrawer()
  const core = fakeCore({ manifest: probeManifest, drawer, notes })
  context.onTestFinished(async () => {
    await core.close()
    vi.useRealTimers()
  })
  let ask: ((ask: Ask) => Promise<unknown>) | null = null
  await core.start(probe(given => {
    ask = given
  }))
  const frame = drawer.mountFrame(drawer.instances().find(each => each.view === 'pad')!.instance)
  const wait = async (ms: number) => void vi.setSystemTime(Date.now() + ms)
  return {
    press: async (where, holdMs = 0) => {
      if (where === 'elsewhere') return drawer.pressedElsewhere()
      frame.pressed()
      await wait(holdMs)
      frame.released()
    },
    enter: async () => void frame.keyed(),
    frameOpen: async path => void frame.open(path),
    framePost: async data => void frame.post(data),
    frameReceived: async () => [...frame.received],
    dragToken: async path => frame.dragToken(path),
    ask: given => ask!(given),
    wait,
  }
}

describe('FakeDrawer', () => drawerCases(fake))
