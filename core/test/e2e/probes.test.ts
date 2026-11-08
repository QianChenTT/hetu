import type { ElectronApplication, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, counting, dataWith, launch, logged, until, workersPage } from './helpers.ts'

afterEach(cleanup)

// The lifecycle, so the probe stays up, with its port kept on self for the huge message probe
const lifecycle = `
self.onmessage = event => {
  const port = event.ports[0]
  self.onmessage = null
  self.hetuPort = port
  const send = message => port.postMessage(JSON.stringify(message))
  port.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.kind === 'init') send({ v: 1, kind: 'ready' })
    else if (message.kind === 'ping') send({ v: 1, kind: 'pong' })
    else if (message.kind === 'stop') send({ v: 1, kind: 'stopped' })
  }
}
`

// Tries each way out of a worker at load and keeps what happened in self.probe: allowed, or refused with the error's name
const probe = (network: string) => `${lifecycle}
const results = {}
self.probe = results
const tried = (name, run) => {
  try {
    const value = run()
    results[name] = 'allowed'
    return value
  } catch (err) {
    results[name] = 'refused:' + (err && err.name)
  }
}
const waited = (name, run) => {
  let made
  try {
    made = run()
  } catch (err) {
    results[name] = 'refused:' + (err && err.name)
    return Promise.resolve()
  }
  return Promise.resolve(made).then(() => { results[name] = 'allowed' }, err => { results[name] = 'refused:' + (err && err.name) })
}
const event = (name, make) => {
  const made = tried(name, make)
  if (made === undefined) return Promise.resolve()
  return new Promise(resolve => {
    made.onopen = () => { results[name] = 'opened'; resolve() }
    made.onerror = () => { results[name] = 'error event'; resolve() }
    setTimeout(resolve, 2000)
  })
}
results.origin = self.origin
results.globals = Object.getOwnPropertyNames(self)
  .filter(name => /Worker$|^RTC|WebTransport|WebSocket|BroadcastChannel|EventSource|^caches$|^indexedDB$/.test(name)).sort().join(',')
tried('eval', () => eval('1'))
tried('Function', () => new Function('return 1')())
tried('importScripts own', () => importScripts('hetu://workers/page.js'))
tried('importScripts network', () => importScripts('${network}x.js'))
const pending = [
  waited('wasm', () => WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))),
  waited('fetch own', () => fetch('hetu://workers/')),
  waited('fetch network', () => fetch('${network}')),
  waited('fetch data', () => fetch('data:text/plain,hi')),
  waited('indexedDB', () => new Promise((resolve, reject) => {
    const request = indexedDB.open('probe')
    request.onsuccess = resolve
    request.onerror = () => reject(request.error)
  })),
  waited('caches', () => caches.open('probe')),
  event('WebSocket', () => new WebSocket('${network.replace('http', 'ws')}')),
  event('EventSource', () => new EventSource('${network}')),
  waited('WebTransport', () => new WebTransport('${network.replace('http', 'https')}').ready),
  waited('WebSocketStream', () => new WebSocketStream('${network.replace('http', 'ws')}').opened),
]
const channel = tried('BroadcastChannel', () => new BroadcastChannel('hetu-probe'))
if (channel) {
  results.heard = []
  channel.onmessage = message => results.heard.push(message.data)
  setTimeout(() => channel.postMessage(self.name), 500)
}
Promise.allSettled(pending).then(() => setTimeout(() => { results.done = true }, 1000))
`

async function probes(app: ElectronApplication, count: number): Promise<Map<string, Worker>> {
  const page = await workersPage(app)
  await until(() => page.workers().length === count)
  const byName = new Map<string, Worker>()
  for (const worker of page.workers()) byName.set(await worker.evaluate(() => self.name), worker)
  return byName
}

type Results = Record<string, unknown>
const results = (worker: Worker) => worker.evaluate(() => (self as unknown as { probe: Results }).probe)

describe('the probes in a worker', () => {
  it('leaves a worker no way out, no eval and no new global, while WebAssembly works', async () => {
    const network = await counting()
    const dataDir = await dataWith({ 'probe-a': probe(network.url), 'probe-b': probe(network.url) })
    const app = await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'probe-b' }))
    const workers = await probes(app, 2)
    const a = workers.get('probe-a')!
    const b = workers.get('probe-b')!
    await until(async () => (await results(a)).done === true && (await results(b)).done === true, 10_000)
    const seen = await results(a)
    console.log(JSON.stringify(seen, null, 2))
    expect(seen.origin).toBe('null')
    expect(seen.globals).not.toMatch(/(^|,)(Shared)?Worker(,|$)/)
    expect(seen.eval).toMatch(/^refused/)
    expect(seen.Function).toMatch(/^refused/)
    expect(seen.wasm).toBe('allowed')
    expect(seen['importScripts network']).toMatch(/^refused/)
    for (const name of ['fetch own', 'fetch network', 'fetch data', 'indexedDB', 'caches']) expect(seen[name], name).toMatch(/^refused/)
    for (const name of ['WebSocket', 'EventSource']) expect(seen[name], name).not.toBe('opened')
    expect(seen.WebTransport).toMatch(/^refused/)
    expect(seen.WebSocketStream).toMatch(/^refused/)
    // Each data: worker has its own opaque origin, so a broadcast reaches no other plugin
    expect(seen.heard ?? []).not.toContain('probe-b')
    expect((await results(b)).heard ?? []).not.toContain('probe-a')
    expect(network.hits()).toBe(0)
  })

  it('keeps Worker away from a plugin that declares its own globalThis at the top of its code', async () => {
    // Playwright can't evaluate in a worker that shadows globalThis, so each plugin tries to start a nested worker,
    // which Playwright would list
    const tries = (declared: string) => `${declared}\n${lifecycle}\nif (typeof Worker === 'function') new Worker('data:text/javascript,1')`
    const dataDir = await dataWith({ lexical: tries('const globalThis = self'), declared: tries('function globalThis() {}') })
    const app = await launch(dataDir)
    await until(async () => await logged(dataDir, 'plugin.started', { plugin: 'lexical' }) && await logged(dataDir, 'plugin.started', { plugin: 'declared' }))
    const page = await workersPage(app)
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(page.workers()).toHaveLength(2)
  })

  it('starts a worker whose script fits a data: URL and fails one past the cap, about 1.5 MiB of code', async () => {
    // The page base64s the prelude and the code into one data: URL, which Chromium caps at 2 MiB
    const padded = (bytes: number) => `${lifecycle}/*${'x'.repeat(bytes)}*/`
    const dataDir = await dataWith({ fits: padded(1_450_000), past: padded(1_600_000) }, { readyMs: 3000 })
    await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'fits' }))
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'past', reason: 'start-timeout' }))
  })

  it('keeps main free of one huge message: the relay cuts off what main can\'t read cheaply and weighs the rest', async () => {
    const dataDir = await dataWith({ objects: lifecycle, nested: lifecycle, past: lifecycle, heaviest: lifecycle })
    const app = await launch(dataDir)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'heaviest' }))
    const workers = await probes(app, 4)
    const stalls: Record<string, number> = {}
    // Before the relay a million small objects stalled main 390 ms, and before it weighed, 16 MiB of nesting 827 ms
    const sends: [string, string][] = [
      ['objects', 'a million small objects, not text'], ['nested', '16 MiB of nesting'], ['past', '64 MiB of text'],
      ['heaviest', '600,000 empty objects, the heaviest JSON within the cap'],
    ]
    for (const [plugin, name] of sends) {
      await app.evaluate(() => {
        const scope = globalThis as unknown as { lag: number, last: number, timer: NodeJS.Timeout }
        clearInterval(scope.timer)
        scope.lag = 0
        scope.last = performance.now()
        scope.timer = setInterval(() => {
          const now = performance.now()
          scope.lag = Math.max(scope.lag, now - scope.last - 10)
          scope.last = now
        }, 10)
      })
      await workers.get(plugin)!.evaluate(which => {
        const half = 8 * 1024 * 1024
        const message = which.startsWith('16 MiB') ? '['.repeat(half) + ']'.repeat(half)
          : which.startsWith('64 MiB') ? JSON.stringify('x'.repeat(64 * 1024 * 1024))
          : which.startsWith('600,000') ? JSON.stringify(Array.from({ length: 600_000 }, () => ({})))
          : Array.from({ length: 1_000_000 }, (_, i) => ({ i, name: 'n' }))
        ;(self as unknown as { hetuPort: MessagePort }).hetuPort.postMessage(message)
      }, name)
      await new Promise(resolve => setTimeout(resolve, 3000))
      stalls[name] = Math.round(await app.evaluate(() => (globalThis as unknown as { lag: number }).lag))
    }
    console.log(JSON.stringify({ 'longest stall of main in ms': stalls }))
    for (const plugin of ['objects', 'nested', 'past']) {
      expect(await logged(dataDir, 'plugin.crashed', { plugin, reason: 'malformed' }), plugin).toBe(true)
    }
    // The heaviest message the relay passes reaches main, which reads it and the carrier drops it as no envelope
    expect(await logged(dataDir, 'plugin.crashed', { plugin: 'heaviest' })).toBe(false)
    for (const [name, ms] of Object.entries(stalls)) expect(ms, name).toBeLessThan(150)
  })
})
