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

function channel() {
  const core = new FakePortMain()
  const plugin = new FakePortMain()
  const runtime = electronRuntime(() => ({ port1: core as unknown as MessagePortMain, port2: plugin as unknown as MessagePortMain }))
  return { runtime, core, plugin }
}

describe('the Electron runtime', () => {
  it('hands the carrier a port whose message listener gets the data, as a Node port gives it', () => {
    const { runtime, core, plugin } = channel()
    const ends = runtime.channel()
    expect(ends.plugin).toBe(plugin)
    const got: unknown[] = []
    ends.core.on('message', value => got.push(value))
    core.emit('message', { data: { v: 1, kind: 'ready' }, ports: [] })
    expect(got).toEqual([{ v: 1, kind: 'ready' }])
  })

  it('reads a message carrying ports as one it can\'t read and closes each port, so a half holds no channel but its own', () => {
    const { runtime, core } = channel()
    const ends = runtime.channel()
    const got: unknown[] = []
    const unreadable: unknown[] = []
    ends.core.on('message', value => got.push(value))
    ends.core.on('messageerror', value => unreadable.push(value))
    const passed = new FakePortMain()
    core.emit('message', { data: { v: 1, kind: 'ready' }, ports: [passed] })
    expect(got).toEqual([])
    expect(unreadable).toEqual([undefined])
    expect(passed.closed).toBe(true)
  })

  it('posts, starts, closes and reports close on the port it wraps', () => {
    const { runtime, core } = channel()
    const ends = runtime.channel()
    let closed = 0
    ends.core.on('close', () => closed++)
    ends.core.start()
    ends.core.postMessage({ v: 1, kind: 'ping' })
    expect(core.started).toBe(true)
    expect(core.posted).toEqual([{ v: 1, kind: 'ping' }])
    ends.core.close()
    expect(core.closed).toBe(true)
    expect(closed).toBe(1)
  })

  it('refuses to start a worker or a host half until the core can run them', async () => {
    const { runtime } = channel()
    expect(() => runtime.startWorker({ id: 'search', incarnation: 1, code: Buffer.from(''), port: null })).toThrow()
    await expect(runtime.startHost({ id: 'log', incarnation: 1, root: '', files: [], entry: 'host.js', link: { post() {}, listen() {} } }))
      .rejects.toThrow()
    expect(() => runtime.terminate('search', 1)).not.toThrow()
  })
})
