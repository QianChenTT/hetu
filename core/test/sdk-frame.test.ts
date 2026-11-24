import { describe, expect, it } from 'vitest'
import { connect, type FrameScope } from '../sdk/frame.ts'

type Sent = { source: unknown, data: unknown, ports: readonly MessagePort[] }

function scope() {
  const parent = {}
  let listener: ((event: Sent) => void) | null = null
  const made: FrameScope = {
    parent,
    addEventListener: (_type, next) => {
      listener = next
    },
    removeEventListener: () => {
      listener = null
    },
  }
  return { made, parent, send: (event: Sent) => listener?.(event), heard: () => listener !== null }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10))

// A frame connected over a fresh channel, the drawer's end of it handed back
async function connected(variables?: unknown) {
  const { made, parent, send } = scope()
  const view = connect(made)
  const { port1, port2 } = new MessageChannel()
  send({ source: parent, data: { v: 1, kind: 'view', ...(variables === undefined ? {} : { variables }) }, ports: [port2] })
  return { view: await view, drawer: port1, close: () => [port1, port2].forEach(port => port.close()) }
}

describe('a frame\'s side of its view', () => {
  it('takes the first port its parent sends and talks over it in JSON text', async () => {
    const { made, parent, send, heard } = scope()
    const pending = connect(made)
    const { port1, port2 } = new MessageChannel()
    send({ source: {}, data: { v: 1, kind: 'view' }, ports: [port1] })
    expect(heard()).toBe(true)
    send({ source: parent, data: { v: 1, kind: 'view' }, ports: [port1] })
    const view = await pending
    expect(heard()).toBe(false)
    const got: unknown[] = []
    view.onMessage(data => got.push(data))
    port2.postMessage(JSON.stringify({ cards: 2 }))
    port2.postMessage('not json')
    const sent = new Promise(resolve => {
      port2.onmessage = event => resolve(event.data)
    })
    view.post({ moved: 'a' })
    expect(await sent).toBe(JSON.stringify({ moved: 'a' }))
    await settle()
    expect(got).toEqual([{ cards: 2 }])
    port1.close()
    port2.close()
  })

  it('ignores a message from its parent that is no view port', () => {
    const { made, parent, send, heard } = scope()
    void connect(made)
    send({ source: parent, data: { v: 1, kind: 'port' }, ports: [] })
    send({ source: parent, data: { v: 1, kind: 'view' }, ports: [] })
    expect(heard()).toBe(true)
  })

  it('keeps what the worker sent before a handler was set and hands it to the first one, in order', async () => {
    const { view, drawer, close } = await connected()
    drawer.postMessage(JSON.stringify(1))
    drawer.postMessage(JSON.stringify(2))
    await settle()
    const got: unknown[] = []
    view.onMessage(data => got.push(data))
    drawer.postMessage(JSON.stringify(3))
    await settle()
    expect(got).toEqual([1, 2, 3])
    close()
  })

  it('starts with the theme its port came with and hears each change the drawer sends, never one in the worker\'s text', async () => {
    const { view, drawer, close } = await connected({ '--hetu-color-bg': '#101010', 'color-fg': '#fff', '--hetu-space': 4 })
    expect(view.theme()).toEqual({ '--hetu-color-bg': '#101010' })
    const themes: unknown[] = []
    const messages: unknown[] = []
    view.onTheme(theme => themes.push(theme))
    view.onMessage(data => messages.push(data))
    drawer.postMessage({ v: 1, kind: 'theme', variables: { '--hetu-color-bg': '#202020', '--hetu-radius': '4px' } })
    drawer.postMessage(JSON.stringify({ v: 1, kind: 'theme', variables: { '--hetu-color-bg': '#ff0000' } }))
    drawer.postMessage({ v: 1, kind: 'other' })
    await settle()
    expect(themes).toEqual([{ '--hetu-color-bg': '#202020', '--hetu-radius': '4px' }])
    expect(view.theme()).toEqual({ '--hetu-color-bg': '#202020', '--hetu-radius': '4px' })
    expect(messages).toEqual([{ v: 1, kind: 'theme', variables: { '--hetu-color-bg': '#ff0000' } }])
    close()
  })

  it('starts with no theme when its port came with none', async () => {
    const { view, close } = await connected()
    expect(view.theme()).toEqual({})
    close()
  })

  it('answers a second connect with the same view, listening once', async () => {
    const { made, parent, send } = scope()
    let listening = 0
    const counted: FrameScope = { ...made, addEventListener: (type, next) => { listening++; made.addEventListener(type, next) } }
    const first = connect(counted)
    const second = connect(counted)
    expect(second).toBe(first)
    expect(listening).toBe(1)
    const { port1, port2 } = new MessageChannel()
    send({ source: parent, data: { v: 1, kind: 'view' }, ports: [port2] })
    expect(await second).toBe(await first)
    port1.close()
    port2.close()
  })

  it('keeps the newest 100 messages from before the first handler, dropping the oldest', async () => {
    const { view, drawer, close } = await connected()
    for (let at = 0; at < 150; at++) drawer.postMessage(JSON.stringify(at))
    await settle()
    const got: unknown[] = []
    view.onMessage(data => got.push(data))
    expect(got).toEqual(Array.from({ length: 100 }, (_, at) => at + 50))
    close()
  })

  it('hands every kept message to a first handler that throws on one, then throws', async () => {
    const { view, drawer, close } = await connected()
    for (const at of [1, 2, 3]) drawer.postMessage(JSON.stringify(at))
    await settle()
    const got: unknown[] = []
    expect(() => view.onMessage(data => {
      got.push(data)
      if (data === 1) throw new Error('first')
    })).toThrow('first')
    expect(got).toEqual([1, 2, 3])
    close()
  })
})

describe('a frame asking hetu to open a note', () => {
  it('asks the drawer as an object on its port, never as JSON text a worker message could read as', async () => {
    const { view, drawer, close } = await connected()
    const asked = new Promise(resolve => {
      drawer.onmessage = event => resolve(event.data)
    })
    view.open('notes/a.md')
    expect(await asked).toEqual({ v: 1, kind: 'open', path: 'notes/a.md' })
    close()
  })
})
