import { describe, expect, it } from 'vitest'
import { frameChannel, type FrameScope } from '../sdk/frame.ts'

function scope() {
  const parent = {}
  let listener: ((event: { source: unknown, data: unknown, ports: readonly MessagePort[] }) => void) | null = null
  const made: FrameScope = {
    parent,
    addEventListener: (_type, next) => {
      listener = next
    },
    removeEventListener: () => {
      listener = null
    },
  }
  return { made, parent, send: (event: { source: unknown, data: unknown, ports: readonly MessagePort[] }) => listener?.(event), heard: () => listener !== null }
}

describe('a frame\'s side of its view', () => {
  it('takes the first port its parent sends and talks over it in JSON text', async () => {
    const { made, parent, send, heard } = scope()
    const channel = frameChannel(made)
    const { port1, port2 } = new MessageChannel()
    send({ source: {}, data: { v: 1, kind: 'view' }, ports: [port1] })
    expect(heard()).toBe(true)
    send({ source: parent, data: { v: 1, kind: 'view' }, ports: [port1] })
    const view = await channel
    expect(heard()).toBe(false)
    const got: unknown[] = []
    view.on(data => got.push(data))
    port2.postMessage(JSON.stringify({ cards: 2 }))
    port2.postMessage({ not: 'text' })
    const sent = new Promise(resolve => {
      port2.onmessage = event => resolve(event.data)
    })
    view.post({ moved: 'a' })
    expect(await sent).toBe(JSON.stringify({ moved: 'a' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(got).toEqual([{ cards: 2 }])
    port1.close()
    port2.close()
  })

  it('ignores a message from its parent that is no view port', () => {
    const { made, parent, send, heard } = scope()
    void frameChannel(made)
    send({ source: parent, data: { v: 1, kind: 'port' }, ports: [] })
    send({ source: parent, data: { v: 1, kind: 'view' }, ports: [] })
    expect(heard()).toBe(true)
  })
})
