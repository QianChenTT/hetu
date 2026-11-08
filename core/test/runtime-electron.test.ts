import { EventEmitter } from 'node:events'
import type { MessagePortMain } from 'electron'
import { describe, expect, it } from 'vitest'
import { electronRuntime } from '../backend/runtime/electron.ts'

// Electron's MessagePortMain as the runtime sees it: message hands over an event with data and ports
class FakePortMain extends EventEmitter {
  posted: unknown[] = []
  started = false
  closed = false

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  start(): void {
    this.started = true
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }
}

let seen: unknown[][] = []
let frozen = 0
const hosts = {
  freeze: () => {
    frozen++
  },
  importer: async () => ({ default: { kind: 'hetu-plugin', spec: { start() {} } }, provider: { prepare: async () => ({ scope: {} }), perform: async () => ({}) } }),
}

function channel() {
  seen = []
  const workers = { start: (start: unknown) => seen.push(['start', start]), terminate: (id: string, n: number) => seen.push(['terminate', id, n]) }
  const core = new FakePortMain()
  const plugin = new FakePortMain()
  const runtime = electronRuntime(() => ({ port1: core as unknown as MessagePortMain, port2: plugin as unknown as MessagePortMain }), workers, (_plugin, name) => (name === 'resultBytes' ? 100 : 1), hosts)
  return { runtime, core, plugin }
}

describe('the Electron runtime', () => {
  it('hands the carrier a port whose message listener gets the data, as a Node port gives it', () => {
    const { runtime, core, plugin } = channel()
    const ends = runtime.channel('search')
    expect(ends.plugin).toBe(plugin)
    const got: unknown[] = []
    ends.core.on('message', value => got.push(value))
    core.emit('message', { data: '{"v":1,"kind":"ready"}', ports: [] })
    expect(got).toEqual([{ v: 1, kind: 'ready' }])
  })

  it('reads a message carrying ports as one it can\'t read and closes each port, so a half holds no channel but its own', () => {
    const { runtime, core } = channel()
    const ends = runtime.channel('search')
    const got: unknown[] = []
    const unreadable: unknown[] = []
    ends.core.on('message', value => got.push(value))
    ends.core.on('messageerror', value => unreadable.push(value))
    const passed = new FakePortMain()
    core.emit('message', { data: '{"v":1,"kind":"ready"}', ports: [passed] })
    expect(got).toEqual([])
    expect(unreadable).toEqual([undefined])
    expect(passed.closed).toBe(true)
  })

  it('reads only text within the plugin\'s cap that parses, since the relay sends nothing else', () => {
    const { runtime, core } = channel()
    const ends = runtime.channel('search')
    const got: unknown[] = []
    const unreadable: unknown[] = []
    ends.core.on('message', value => got.push(value))
    ends.core.on('messageerror', value => unreadable.push(value))
    // resultBytes is 100 here, so the cap is 100 and the envelope's room
    const room = 64 * 1024
    for (const data of [{ v: 1 }, 5, '{not json', `"${'x'.repeat(100 + room - 1)}"`]) core.emit('message', { data, ports: [] })
    expect(got).toEqual([])
    expect(unreadable).toHaveLength(4)
    core.emit('message', { data: `"${'x'.repeat(100 + room - 2)}"`, ports: [] })
    expect(got).toHaveLength(1)
  })

  it('posts, starts, closes and reports close on the port it wraps', () => {
    const { runtime, core } = channel()
    const ends = runtime.channel('search')
    let closed = 0
    ends.core.on('close', () => closed++)
    ends.core.start()
    ends.core.postMessage({ v: 1, kind: 'ping' })
    expect(core.started).toBe(true)
    expect(core.posted).toEqual(['{"v":1,"kind":"ping"}'])
    ends.core.close()
    expect(core.closed).toBe(true)
    expect(closed).toBe(1)
  })

  it('starts and ends workers through the hidden renderer and loads a host half from its verified bytes', async () => {
    const { runtime, plugin } = channel()
    const start = { id: 'search', incarnation: 1, code: Buffer.from('// search'), port: plugin }
    runtime.startWorker(start)
    runtime.terminate('search', 1)
    expect(seen).toEqual([['start', start], ['terminate', 'search', 1]])
    frozen = 0
    const host = { id: 'luoshu', incarnation: 1, root: '', files: [{ path: 'host.js', bytes: Buffer.from('') }], entry: 'host.js', link: { post() {}, listen() {} } }
    expect(Object.keys(await runtime.startHost(host))).toEqual(['provider'])
    await runtime.startHost({ ...host, id: 'gate' })
    // The built-ins freeze once, before the first host half
    expect(frozen).toBe(1)
  })
})
