import { expect, it, type TestContext } from 'vitest'
import { OPEN_GRACE_MS } from '../../api/ui-limits.ts'
import type { Ask, Heard } from './drawer-probe.ts'

// The drawer as the probe plugin meets it: what its frame asks, what its worker asks and hears, each answer read
// through the plugin's own port. The probe lists every note, reads own/ and reads the others through ui.read, so a.md
// and c.md reach it only once the human opened them. A side starts with notes, the probe running and its frame loaded
export const notes = { 'a.md': 'alpha', 'c.md': 'gamma', 'own/b.md': 'beta' }

export type DrawerSide = {
  // The human pressed in the probe's frame, or anywhere else on the page
  press(where: 'frame' | 'elsewhere'): Promise<void>
  // The human pressed Enter in the probe's frame, which holds focus from a press
  enter(): Promise<void>
  // What the frame's script does through @hetu/sdk/frame
  frameOpen(path: string): Promise<void>
  framePost(data: unknown): Promise<void>
  frameReceived(): Promise<unknown[]>
  dragToken(path: string): Promise<string | null>
  // What the worker asks through its port, a refusal as { refused: code }
  ask(ask: Ask): Promise<unknown>
  // Long enough for whatever the last step set going to land, or not
  settle(): Promise<void>
}
export type MakeDrawer = (context: TestContext) => Promise<DrawerSide>

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const paths = (side: DrawerSide) => side.ask({ op: 'paths' })
const refused = (code: string) => ({ refused: code })

export function drawerCases(make: MakeDrawer): void {
  // X1: the open a frame asks right after the human's press is theirs, so ui.read reaches the note
  it('counts the frame\'s open right after a press in it as the human\'s, the note then reached through ui.read', async context => {
    const side = await make(context)
    expect(await paths(side)).toEqual([])
    await side.press('frame')
    await side.frameOpen('a.md')
    await side.settle()
    expect(await paths(side)).toEqual(['a.md'])
    expect(await side.ask({ op: 'read', path: 'a.md' })).toBe('alpha')
    expect(((await side.ask({ op: 'heard' })) as Heard).opened).toBe(1)
  })

  // X1: with no press the open is the plugin's own, in the background where its luoshu.read reaches and nowhere else
  it('opens a frame\'s open with no press as the plugin\'s own, only where its luoshu.read reaches', async context => {
    const side = await make(context)
    await side.frameOpen('a.md')
    await side.frameOpen('own/b.md')
    await side.settle()
    expect(await paths(side)).toEqual(['own/b.md'])
  })

  // X1: the worker's editor.open is never the human's, a press in the frame just before or not
  it('takes the worker\'s editor.open as the plugin\'s own even right after a press, refusing a note it only lists', async context => {
    const side = await make(context)
    expect(await side.ask({ op: 'open', path: 'a.md' })).toEqual(refused('not-granted'))
    await side.press('frame')
    expect(await side.ask({ op: 'open', path: 'c.md' })).toEqual(refused('not-granted'))
    expect(await side.ask({ op: 'open', path: 'own/b.md' })).toBeNull()
    await side.settle()
    expect(await paths(side)).toEqual(['own/b.md'])
  })

  it('counts one open for each press', async context => {
    const side = await make(context)
    await side.press('frame')
    await side.frameOpen('a.md')
    await side.frameOpen('c.md')
    await side.settle()
    expect(await paths(side)).toEqual(['a.md'])
  })

  it(`counts no open past ${OPEN_GRACE_MS} ms after the press`, async context => {
    const side = await make(context)
    await side.press('frame')
    await sleep(OPEN_GRACE_MS + 200)
    await side.frameOpen('a.md')
    await side.settle()
    expect(await paths(side)).toEqual([])
  })

  it('counts no open after a later press outside the frame', async context => {
    const side = await make(context)
    await side.press('frame')
    await side.press('elsewhere')
    await side.frameOpen('a.md')
    await side.settle()
    expect(await paths(side)).toEqual([])
  })

  it('counts Enter in the frame holding focus as a press', async context => {
    const side = await make(context)
    await side.press('frame')
    await sleep(OPEN_GRACE_MS + 200)
    await side.enter()
    await side.frameOpen('a.md')
    await side.settle()
    expect(await paths(side)).toEqual(['a.md'])
  })

  it('carries the frame\'s posts to the worker and the worker\'s posts to the frame, in order', async context => {
    const side = await make(context)
    expect(((await side.ask({ op: 'heard' })) as Heard).views).toHaveLength(1)
    await side.framePost({ n: 1 })
    await side.framePost(['two'])
    expect(await side.ask({ op: 'post', data: { back: 1 } })).toBeNull()
    await side.settle()
    expect(((await side.ask({ op: 'heard' })) as Heard).messages).toEqual([{ n: 1 }, ['two']])
    expect(await side.frameReceived()).toEqual([{ back: 1 }])
  })

  it('gives the frame a drag token for a note its luoshu.read reaches and none for one it only lists', async context => {
    const side = await make(context)
    expect(await side.dragToken('own/b.md')).toMatch(/^[0-9a-f]{32}$/)
    expect(await side.dragToken('a.md')).toBeNull()
  })
}
