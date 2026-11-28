import { describe } from 'vitest'
import { fakeCore, FakeDrawer } from '../../sdk/testing/index.ts'
import { drawerCases, type MakeDrawer, notes } from './drawer.cases.ts'
import { type Ask, probe, probeManifest } from './drawer-probe.ts'

// FakeDrawer on the drawer's cases, the probe's worker under the fake core and its frame played by the fake's own
// FakeFrame. The real drawer runs the same cases on the driven build in tier0/drawer.real.test.ts
const fake: MakeDrawer = async context => {
  const drawer = new FakeDrawer()
  const core = fakeCore({ manifest: probeManifest, drawer, notes })
  context.onTestFinished(() => core.close())
  let ask: ((ask: Ask) => Promise<unknown>) | null = null
  await core.start(probe(given => {
    ask = given
  }))
  const frame = drawer.mountFrame(drawer.instances().find(each => each.view === 'pad')!.instance)
  return {
    press: async where => (where === 'frame' ? frame.pressed() : drawer.pressedElsewhere()),
    enter: async () => frame.keyed(),
    frameOpen: async path => void frame.open(path),
    framePost: async data => void frame.post(data),
    frameReceived: async () => [...frame.received],
    dragToken: async path => frame.dragToken(path),
    ask: given => ask!(given),
    settle: () => new Promise(resolve => setTimeout(resolve, 10)),
  }
}

describe('FakeDrawer', () => drawerCases(fake))
