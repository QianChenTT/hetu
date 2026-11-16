import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { RelayLimits } from '../api/rate.ts'
import { listenToMain, startChild } from '../backend/runtime/utility-child.ts'
import { definePlugin } from '../sdk/plugin.ts'

// The utility half's end of its channel inside the process, as Electron hands it over
class FakePortMain extends EventEmitter {
  posted: string[] = []
  postMessage(text: string): void {
    this.posted.push(text)
  }

  start(): void {}

  gets(text: string): void {
    this.emit('message', { data: text, ports: [] })
  }
}

// The child's parent port, which only main writes to
class FakeParent extends EventEmitter {
  gets(data: unknown, ports: unknown[] = []): void {
    this.emit('message', { data, ports })
  }
}

const limits: RelayLimits = { messagesPerSecond: 200, floodFactor: 10, floodMs: 5000, bytesPerSecond: 4096, resultBytes: 1024 }
const init = JSON.stringify({ v: 1, kind: 'init', id: 'http', incarnation: 1, api: 2, deps: {}, lastStop: null, previousVersion: null })
const code = Buffer.from('the bytes the loader hashed').toString('base64')

function child(module: unknown = { default: definePlugin({ start() {} }) }) {
  const imported: string[] = []
  const exits: number[] = []
  const deps = {
    importer: async (url: string) => {
      imported.push(url)
      if (module instanceof Error) throw module
      return module
    },
    exit: (code: number) => {
      exits.push(code)
    },
  }
  return { deps, imported, exits }
}

describe('the utility process\'s bootstrap', () => {
  it('imports the bytes it was handed as one data: module and runs its plugin on the port it was handed', async () => {
    const { deps, imported, exits } = child()
    const port = new FakePortMain()
    await startChild({ data: { v: 1, kind: 'start', code, limits }, ports: [port] }, deps)
    expect(imported).toEqual([`data:text/javascript;base64,${code}`])
    expect(exits).toEqual([])
    port.gets(init)
    await vi.waitFor(() => expect(port.posted).toContain('{"v":1,"kind":"ready"}'))
  })

  it.each([
    ['no port', { v: 1, kind: 'start', code, limits }, []],
    ['two ports', { v: 1, kind: 'start', code, limits }, [new FakePortMain(), new FakePortMain()]],
    ['another kind', { v: 1, kind: 'run', code, limits }, [new FakePortMain()]],
    ['another version', { v: 2, kind: 'start', code, limits }, [new FakePortMain()]],
    ['code that isn\'t text', { v: 1, kind: 'start', code: 7, limits }, [new FakePortMain()]],
    ['limits that aren\'t whole positive numbers', { v: 1, kind: 'start', code, limits: { ...limits, bytesPerSecond: 0 } }, [new FakePortMain()]],
    ['nothing at all', null, [new FakePortMain()]],
  ])('exits with 1 and imports nothing for a start with %s', async (_name, data, ports) => {
    const { deps, imported, exits } = child()
    await startChild({ data, ports }, deps)
    expect(imported).toEqual([])
    expect(exits).toEqual([1])
  })

  it('hands the limits main sends after the start to the running transport, a raise as well as a lowering', async () => {
    const { deps } = child()
    const parent = new FakeParent()
    const set: RelayLimits[] = []
    listenToMain(parent, deps, async () => (limits: RelayLimits) => void set.push(limits))
    parent.gets({ v: 1, kind: 'start', code, limits }, [new FakePortMain()])
    // It keeps listening after the start
    expect(parent.listeners('message')).toHaveLength(1)
    await Promise.resolve()
    const lowered = { ...limits, messagesPerSecond: 20 }
    const raised = { ...limits, messagesPerSecond: 400 }
    parent.gets({ v: 1, kind: 'limits', limits: lowered })
    parent.gets({ v: 1, kind: 'limits', limits: raised })
    expect(set).toEqual([lowered, raised])
  })

  it('applies limits sent while the module still loads once it runs, the newest only', async () => {
    const { deps } = child()
    const parent = new FakeParent()
    const set: RelayLimits[] = []
    let release: (value: (limits: RelayLimits) => void) => void = () => {}
    listenToMain(parent, deps, () => new Promise(resolve => {
      release = resolve
    }))
    parent.gets({ v: 1, kind: 'start', code, limits }, [new FakePortMain()])
    parent.gets({ v: 1, kind: 'limits', limits: { ...limits, messagesPerSecond: 30 } })
    parent.gets({ v: 1, kind: 'limits', limits: { ...limits, messagesPerSecond: 20 } })
    expect(set).toEqual([])
    release(limits => void set.push(limits))
    await vi.waitFor(() => expect(set).toEqual([{ ...limits, messagesPerSecond: 20 }]))
  })

  it('starts once and ignores a second start, a limits message with a port and limits that aren\'t whole positive numbers', async () => {
    const { deps } = child()
    const parent = new FakeParent()
    const starts: unknown[] = []
    const set: RelayLimits[] = []
    listenToMain(parent, deps, async event => {
      starts.push(event.data)
      return (limits: RelayLimits) => void set.push(limits)
    })
    parent.gets({ v: 1, kind: 'start', code, limits }, [new FakePortMain()])
    parent.gets({ v: 1, kind: 'start', code, limits }, [new FakePortMain()])
    await Promise.resolve()
    parent.gets({ v: 1, kind: 'limits', limits }, [new FakePortMain()])
    parent.gets({ v: 1, kind: 'limits', limits: { ...limits, messagesPerSecond: 0 } })
    parent.gets({ v: 2, kind: 'limits', limits })
    parent.gets({ v: 1, kind: 'limit', limits })
    parent.gets(JSON.stringify({ v: 1, kind: 'limits', limits }))
    parent.gets(null)
    expect(starts).toHaveLength(1)
    expect(set).toEqual([])
  })

  it('exits with 1 when the module throws as it loads or has no plugin as its default export', async () => {
    for (const module of [new Error('broken'), { default: { kind: 'hetu-plugin' } }, {}, null]) {
      const { deps, exits } = child(module)
      await startChild({ data: { v: 1, kind: 'start', code, limits }, ports: [new FakePortMain()] }, deps)
      expect(exits).toEqual([1])
    }
  })
})
