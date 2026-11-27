import { expect, it, type TestContext } from 'vitest'
import { OPEN_GRACE_MS } from '../../api/ui-limits.ts'
import type { Ask, Heard } from './drawer-probe.ts'

// The drawer as the probe plugin meets it: what its frame asks, what its worker asks and hears, each answer read
// through the plugin's own port. The probe lists the notes at the top and in own/, reads own/ and reads the others
// through ui.read, so a.md, c.md and z.md reach it only once the human opened them and hidden/x.md, which it neither
// lists nor reads, never. A side starts with notes, the probe running and its frame loaded
export const notes = { 'Welcome.md': 'welcome', 'a.md': 'alpha', 'c.md': 'gamma', 'z.md': 'zeta', 'own/b.md': 'beta', 'hidden/x.md': 'hidden' }

export type DrawerSide = {
  // The human pressed in the probe's frame, holding the press holdMs before the release, or anywhere else on the page
  press(where: 'frame' | 'elsewhere', holdMs?: number): Promise<void>
  // The human pressed Enter wherever focus is
  enter(): Promise<void>
  // What the frame's script does through @hetu/sdk/frame
  frameOpen(path: string): Promise<void>
  framePost(data: unknown): Promise<void>
  frameReceived(): Promise<unknown[]>
  dragToken(path: string): Promise<string | null>
  // What the worker asks through its port, a refusal as { refused: code }
  ask(ask: Ask): Promise<unknown>
  // Time passing for the press credit: a fake clock moved on, or a real wait
  wait(ms: number): Promise<void>
}
export type MakeDrawer = (context: TestContext) => Promise<DrawerSide>

const paths = (side: DrawerSide) => side.ask({ op: 'paths' }) as Promise<string[]>
const heardOf = (side: DrawerSide) => side.ask({ op: 'heard' }) as Promise<Heard>
const refused = (code: string) => ({ refused: code })

// Polls until read answers what is wanted, then checks it once more so a miss names what it last read
async function until<T>(read: () => Promise<T>, wanted: T): Promise<void> {
  // performance's clock, since a fake side moves Date
  for (const end = performance.now() + 10_000; performance.now() < end; await new Promise(resolve => setTimeout(resolve, 50))) {
    if (JSON.stringify(await read()) === JSON.stringify(wanted)) return
  }
  expect(await read()).toEqual(wanted)
}

// What reached the probe once the steps before had their turn: a fresh press and an open of z.md, asked after them
// on the same port, must reach it too, so an earlier open that reached nothing was taken and not still on its way
async function reached(side: DrawerSide, wanted: string[]): Promise<void> {
  await side.press('frame')
  await side.frameOpen('z.md')
  await until(() => paths(side), [...wanted, 'z.md'].sort())
}

export function drawerCases(make: MakeDrawer): void {
  // X1: the open a frame asks right after the human's press is theirs, so ui.read reaches the note
  it('counts the frame\'s open right after a press in it as the human\'s, the note then reached through ui.read, and nothing at the start', async context => {
    const side = await make(context)
    expect(await paths(side)).toEqual([])
    expect(await side.ask({ op: 'read', path: 'Welcome.md' })).toBeNull()
    await side.press('frame')
    await side.frameOpen('a.md')
    await until(() => paths(side), ['a.md'])
    expect(await side.ask({ op: 'read', path: 'a.md' })).toBe('alpha')
    expect((await heardOf(side)).opened).toBe(1)
    await reached(side, ['a.md'])
  })

  // X1: with no press the open is the plugin's own, in the background where its luoshu.read reaches and nowhere else
  it('opens a frame\'s open with no press as the plugin\'s own, only where its luoshu.read reaches', async context => {
    const side = await make(context)
    await side.frameOpen('a.md')
    await side.frameOpen('own/b.md')
    await reached(side, ['own/b.md'])
  })

  // X1: the worker's editor.open is never the human's and leaves the press to the frame
  it('takes the worker\'s editor.open as the plugin\'s own, refusing a note it only lists and spending no press', async context => {
    const side = await make(context)
    expect(await side.ask({ op: 'open', path: 'a.md' })).toEqual(refused('not-granted'))
    await side.press('frame')
    expect(await side.ask({ op: 'open', path: 'own/b.md' })).toBeNull()
    await side.frameOpen('a.md')
    await until(() => paths(side), ['a.md', 'own/b.md'])
    await side.press('frame')
    expect(await side.ask({ op: 'open', path: 'c.md' })).toEqual(refused('not-granted'))
    await reached(side, ['a.md', 'own/b.md'])
  })

  it('counts no human open of a note the plugin neither lists nor reads', async context => {
    const side = await make(context)
    await side.press('frame')
    await side.frameOpen('hidden/x.md')
    await reached(side, [])
  })

  it('counts one open for each press', async context => {
    const side = await make(context)
    await side.press('frame')
    await side.frameOpen('a.md')
    await side.frameOpen('c.md')
    await reached(side, ['a.md'])
  })

  it(`counts no open past ${OPEN_GRACE_MS} ms after the press, and a held press from its release`, async context => {
    // D-740's grace, shared by both sides through core/api
    expect(OPEN_GRACE_MS).toBe(500)
    const side = await make(context)
    await side.press('frame')
    await side.wait(OPEN_GRACE_MS + 200)
    await side.frameOpen('a.md')
    await reached(side, [])
    await side.press('frame', OPEN_GRACE_MS + 300)
    await side.frameOpen('c.md')
    await until(() => paths(side), ['c.md', 'z.md'])
  })

  it('counts no open after a later press outside the frame', async context => {
    const side = await make(context)
    await side.press('frame')
    await side.press('elsewhere')
    await side.frameOpen('a.md')
    await reached(side, [])
  })

  it('counts Enter as a press only in the frame holding focus from a press', async context => {
    const side = await make(context)
    await side.press('frame')
    await side.wait(OPEN_GRACE_MS + 200)
    await side.enter()
    await side.frameOpen('a.md')
    await until(() => paths(side), ['a.md'])
    await side.press('elsewhere')
    await side.enter()
    await side.frameOpen('c.md')
    await reached(side, ['a.md'])
  })

  it('carries the frame\'s posts to the worker and the worker\'s posts to the frame, in order', async context => {
    const side = await make(context)
    expect((await heardOf(side)).views).toHaveLength(1)
    await side.framePost({ n: 1 })
    await side.framePost(['two'])
    expect(await side.ask({ op: 'post', data: { back: 1 } })).toBeNull()
    await until(async () => (await heardOf(side)).messages, [{ n: 1 }, ['two']])
    await until(() => side.frameReceived(), [{ back: 1 }])
  })

  it('gives the frame a drag token for a note its luoshu.read reaches and none for one it only lists', async context => {
    const side = await make(context)
    expect(await side.dragToken('own/b.md')).toMatch(/^[0-9a-f]{32}$/)
    expect(await side.dragToken('a.md')).toBeNull()
  })
}
