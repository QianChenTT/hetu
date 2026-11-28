import { API_VERSION } from '../../api/manifest.ts'
import { definePlugin } from '../../sdk/plugin.ts'

// The test plugin the drawer's cases drive, its worker the same code under the fake core and bundled into the driven
// build. It lists the notes at the top and in own/, reads only own/ and reads through ui.read the notes the human
// opened, so a note outside own/ reaches it only once the human opened it, and one in no folder it lists never. Its frame draws a pad to press in and talks through @hetu/sdk/frame
// as a shipped plugin's frame does

export const probeManifest = {
  id: 'probe', name: 'Probe', version: '1.0.0', api: `^${API_VERSION}`,
  entries: { worker: 'worker.js', frames: { pad: 'pad.html' } },
  views: { pad: { title: 'Probe', kind: 'view', frame: 'pad' } },
  capabilities: [
    { type: 'ui.view' },
    { type: 'luoshu.list', paths: ['*.md', 'own/**'] },
    { type: 'luoshu.read', paths: ['own/**'] },
    { type: 'ui.read', paths: ['**'] },
  ],
}

// The frame's page, its style from its own file as the frame's policy takes it
export const padPage = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="pad.css"></head><body><div id="pad">pad</div><script src="pad.js"></script></body></html>'
export const padStyle = 'html, body { margin: 0; height: 100% } #pad { height: 100%; min-height: 120px }'

// What a case asks of the worker, each answered through its own port
export type Ask =
  | { op: 'open', path: string }
  | { op: 'paths' }
  | { op: 'read', path: string }
  | { op: 'post', data: unknown }
  | { op: 'heard' }
export type Heard = { opened: number, views: string[], messages: unknown[] }

// A refusal as its code, so both sides answer plain data
const asked = async (run: () => Promise<unknown>) => {
  try {
    return await run()
  } catch (err) {
    return { refused: (err as { code?: string }).code ?? 'failed' }
  }
}

export function probe(expose: (ask: (ask: Ask) => Promise<unknown>) => void) {
  return definePlugin({
    start(ctx) {
      const heard: Heard = { opened: 0, views: [], messages: [] }
      ctx.editor.on('opened', () => void heard.opened++)
      ctx.ui.on('view.opened', event => void heard.views.push(event.instance))
      ctx.ui.on('view.message', event => void heard.messages.push(event.data))
      const instanceOf = async (path: string) => (await ctx.editor.instances()).find(each => each.path === path)?.instance
      expose(ask => asked(async () => {
        switch (ask.op) {
          case 'open': return await ctx.editor.open(ask.path) ?? null
          case 'paths': return (await ctx.editor.instances()).map(each => each.path).sort()
          case 'read': {
            const instance = await instanceOf(ask.path)
            return instance === undefined ? null : (await ctx.editor.read(instance)).text
          }
          case 'post': return await ctx.ui.views.post(heard.views[0]!, ask.data) ?? null
          case 'heard': return structuredClone(heard)
        }
      }))
    },
  })
}

// In the driven build's worker, where a test reaches it through the workers page
export default probe(ask => {
  (globalThis as unknown as { probeWorker: unknown }).probeWorker = { ask }
})
