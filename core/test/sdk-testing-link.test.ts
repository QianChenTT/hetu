import { afterEach, describe, expect, it } from 'vitest'
import type { Mark } from '../api/editor.ts'
import { API_VERSION } from '../api/manifest.ts'
import { definePlugin, type PluginContext } from '../sdk/plugin.ts'
import { type FakeCore, fakeCore, FakeDrawer } from '../sdk/testing/index.ts'

// The fake drawer's link clicks, held to the rules hetu's drawer tells a link click by

const cores: FakeCore[] = []
afterEach(async () => {
  for (const made of cores.splice(0)) await made.close()
})

const link = (from: number, to: number, id: string): Mark => ({ kind: 'link', from, to, id })
const decorating = [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'ui.decoration' }, { type: 'ui.edit', paths: ['notes/**'] }, { type: 'ui.command' }]

async function started(capabilities: object[] = decorating) {
  const drawer = new FakeDrawer()
  const made = fakeCore({ manifest: { id: 'links', name: 'Links', version: '1.0.0', api: `^${API_VERSION}`, entries: { worker: 'dist/worker.js' }, capabilities }, drawer })
  cores.push(made)
  const heard: unknown[] = []
  let given: PluginContext | null = null
  await made.start(definePlugin({
    async start(ctx) {
      given = ctx
      ctx.editor.on('link', event => heard.push(event))
      if (capabilities.some(item => (item as { type: string }).type === 'ui.command')) await ctx.editor.bind([{ key: 'Mod-b', command: 'bold' }])
    },
  }))
  const heardNow = async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
    return heard
  }
  return { drawer, ctx: given as unknown as PluginContext, heardNow }
}

describe("the fake drawer's link clicks", () => {
  it("tells the plugin a click on its link by id or place with the note's version and the id", async () => {
    const { drawer, ctx, heardNow } = await started()
    const instance = drawer.openNote('notes/a.md', 'see the note')
    await ctx.editor.decorate(instance, 0, 's', [link(4, 7, 'theNote')])
    drawer.type(instance, { from: 12, insert: '!' })
    expect(drawer.clickLink(instance, 'theNote')).toBe(true)
    expect(drawer.clickLink(instance, 6)).toBe(true)
    expect(drawer.clickLink(instance, 7)).toBe(false)
    expect(drawer.clickLink(instance, 'another')).toBe(false)
    expect(await heardNow()).toEqual([
      { v: 1, kind: 'event', topic: 'editor.link', instance, version: 1, id: 'theNote' },
      { v: 1, kind: 'event', topic: 'editor.link', instance, version: 1, id: 'theNote' },
    ])
  })

  it('moves a link with the text the human types and drops one whose text went, as hetu\'s drawer does', async () => {
    const { drawer, ctx, heardNow } = await started()
    const instance = drawer.openNote('notes/a.md', 'see the note')
    await ctx.editor.decorate(instance, 0, 's', [link(4, 7, 'moved'), link(8, 12, 'gone'), { kind: 'mark', from: 0, to: 3, style: 'em' }])
    drawer.type(instance, { from: 0, insert: 'ab ' })
    expect(drawer.clickLink(instance, 6)).toBe(false)
    expect(drawer.clickLink(instance, 7)).toBe(true)
    drawer.type(instance, { from: 11, to: 15 })
    expect(drawer.clickLink(instance, 'gone')).toBe(false)
    expect(drawer.marks.get(`${instance} s`)).toEqual([link(7, 10, 'moved'), { kind: 'mark', from: 0, to: 3, style: 'em' }])
    expect((await heardNow()).map(event => (event as { version: number, id: string }))).toEqual([expect.objectContaining({ version: 1, id: 'moved' })])
  })

  it('tells the innermost of two links and none on a tie, across sets', async () => {
    const { drawer, ctx, heardNow } = await started()
    const instance = drawer.openNote('notes/a.md', 'see the note')
    await ctx.editor.decorate(instance, 0, 'outer', [link(0, 12, 'outer')])
    await ctx.editor.decorate(instance, 0, 'inner', [link(4, 7, 'inner'), link(8, 12, 'left'), link(8, 12, 'right')])
    expect(drawer.clickLink(instance, 5)).toBe(true)
    expect(drawer.clickLink(instance, 'outer')).toBe(true)
    expect(drawer.clickLink(instance, 9)).toBe(false)
    expect(drawer.clickLink(instance, 'left')).toBe(false)
    expect((await heardNow()).map(event => (event as { id: string }).id)).toEqual(['inner', 'outer'])
  })

  it('tells nothing of a link past the text, on a note the plugin doesn\'t read or without ui.decoration', async () => {
    const { drawer, ctx, heardNow } = await started()
    const instance = drawer.openNote('notes/a.md', 'see the note')
    await ctx.editor.decorate(instance, 0, 's', [link(4, 99, 'past')])
    expect(drawer.clickLink(instance, 'past')).toBe(false)
    const other = drawer.openNote('elsewhere/b.md', 'see the note')
    drawer.marks.set(`${other} s`, [link(4, 7, 'unread')])
    expect(drawer.clickLink(other, 'unread')).toBe(false)
    const bare = await started([{ type: 'luoshu.read', paths: ['notes/**'] }])
    const note = bare.drawer.openNote('notes/a.md', 'see the note')
    bare.drawer.marks.set(`${note} s`, [link(4, 7, 'undecorated')])
    expect(bare.drawer.clickLink(note, 'undecorated')).toBe(false)
    expect(await heardNow()).toEqual([])
    expect(await bare.heardNow()).toEqual([])
  })

  it("closes the window an edit may place the cursor in answer to the human's key", async () => {
    const { drawer, ctx } = await started()
    const instance = drawer.openNote('notes/a.md', '**ab**')
    await ctx.editor.decorate(instance, 0, 's', [link(2, 4, 'a')])
    drawer.command('bold', instance, [{ anchor: 4, head: 4 }])
    drawer.clickLink(instance, 'a')
    await new Promise(resolve => setTimeout(resolve, 5))
    await expect(ctx.editor.edit(instance, 0, [4, [2, '**']], { anchor: 6, head: 6 })).rejects.toMatchObject({ code: 'not-granted' })
  })

  it('leaves that window open on a click on no link, which goes on as a plain one', async () => {
    const { drawer, ctx } = await started()
    const instance = drawer.openNote('notes/a.md', '**ab**')
    await ctx.editor.decorate(instance, 0, 's', [link(2, 4, 'a')])
    drawer.command('bold', instance, [{ anchor: 4, head: 4 }])
    expect(drawer.clickLink(instance, 0)).toBe(false)
    expect(drawer.clickLink(instance, 'missing')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(await ctx.editor.edit(instance, 0, [4, [2, '**']], { anchor: 6, head: 6 })).toEqual({ version: 1 })
  })
})
