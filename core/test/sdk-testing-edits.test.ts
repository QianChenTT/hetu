import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type PluginContext } from '../sdk/plugin.ts'
import { type FakeCore, fakeCore, FakeDrawer } from '../sdk/testing/index.ts'

// The fake drawer's edits, held to the rules hetu's drawer holds a plugin's edits to

const cores: FakeCore[] = []
afterEach(async () => {
  for (const made of cores.splice(0)) await made.close()
})

const manifest = {
  id: 'editor',
  name: 'Editor',
  version: '1.0.0',
  api: '^3',
  entries: { worker: 'dist/worker.js' },
  capabilities: [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'ui.edit', paths: ['notes/**'] }, { type: 'ui.command' }],
}

async function started(heard: unknown[] = []) {
  const drawer = new FakeDrawer()
  const made = fakeCore({ manifest, drawer })
  cores.push(made)
  let given: PluginContext | null = null
  await made.start(definePlugin({
    async start(ctx) {
      given = ctx
      ctx.editor.on('changed', event => heard.push(event))
      await ctx.editor.bind([{ key: 'Mod-b', command: 'bold' }])
    },
  }))
  return { drawer, ctx: given as unknown as PluginContext }
}

describe("the fake drawer's edits", () => {
  it("tells the plugin its own edit as the note's next change, as hetu's drawer does", async () => {
    const heard: unknown[] = []
    const { drawer, ctx } = await started(heard)
    const instance = drawer.openNote('notes/a.md', 'hello')
    await ctx.editor.edit(instance, 0, [5, [0, '!']])
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(heard).toEqual([expect.objectContaining({ topic: 'editor.changed', instance, version: 1, changes: [5, [0, '!']] })])
  })

  it("places the cursor only for an edit answering the human's key, once, inside the range it changed", async () => {
    const { drawer, ctx } = await started()
    const instance = drawer.openNote('notes/a.md', '**ab**')
    await expect(ctx.editor.edit(instance, 0, [4, [2, '**']], { anchor: 6, head: 6 })).rejects.toMatchObject({ code: 'not-granted' })
    drawer.command('bold', instance, [{ anchor: 4, head: 4 }])
    await new Promise(resolve => setTimeout(resolve, 5))
    await expect(ctx.editor.edit(instance, 0, [4, [2, '**']], { anchor: 1, head: 1 })).rejects.toMatchObject({ code: 'invalid' })
    drawer.command('bold', instance, [{ anchor: 4, head: 4 }])
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(await ctx.editor.edit(instance, 0, [4, [2, '**']], { anchor: 6, head: 6 })).toEqual({ version: 1 })
    expect(drawer.selection(instance)).toEqual({ anchor: 6, head: 6 })
    await expect(ctx.editor.edit(instance, 1, [4, [2, '**']], { anchor: 6, head: 6 })).rejects.toMatchObject({ code: 'not-granted' })
  })
})
