import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore, type Switches } from '../../backend/boot/state.ts'
import { baseEnv } from '../../lib/clean-env.ts'
import { command, fakeDoor, handleRefusals, installDoor, reports, send, startedWith, writeHolder } from './door-driver.ts'
import { cleanup, logged, pageAt, records, temp, until } from './helpers.ts'

// The utility place's proof: a fake door in the door's utility process, driven through door.handle by a folder plugin
// holding it, since nothing calls into the door

afterEach(cleanup)

// The fake door's commands: what it was told and what it finds from inside, its own caller as the core names it, a
// hang, a flood and a load. The flood runs its clock fast so the SDK's pacing lets every message through at once, as a
// taken-over half could. The load keeps 8 calls to core.self in flight for 6 s
const commands = `{
  hello: async ctx => ({
    self: await ctx.call('core', 'self', {}),
    dataDir: ctx.dataDir,
    envNames: Object.keys(process.env).sort(),
    envText: Object.values(process.env).join('\\n'),
    cwd: process.cwd(),
    cwdEntries: readdirSync(process.cwd()).length,
    pid: process.pid,
  }),
  hang: () => {
    setTimeout(() => { for (;;) {} }, 50)
    return 'hanging'
  },
  flood: ctx => {
    let now = 0
    performance.now = () => (now += 10_000)
    for (let i = 0; i < 20_000; i++) void ctx.call('core', 'self', {}).catch(() => {})
    return 'flooding'
  },
  load: async ctx => {
    const end = Date.now() + 6000
    let answered = 0
    const refused = []
    const one = async () => {
      while (Date.now() < end) {
        try {
          await ctx.call('core', 'self', {})
          answered++
        } catch (error) {
          refused.push(error.code)
          return
        }
      }
    }
    await Promise.all(Array.from({ length: 8 }, one))
    return { answered, refused }
  },
}`

// What a child on macOS has from outside main's environment: Chromium's launcher passes every child its Mach port
// validation policy, and CoreFoundation sets the user's text encoding from the uid when it is unset
const notFromMain = process.platform === 'darwin' ? ['MACH_PORT_RENDEZVOUS_PEER_VALDATION', '__CF_USER_TEXT_ENCODING'] : []

type Facts = { self: unknown, dataDir: string | null, envNames: string[], envText: string, cwd: string, cwdEntries: number, pid: number }

// A data folder with the holder approved, and the door's heartbeat and rate lowered so a hang shows within a test. more
// holds more of the door's limits and switches more of the switches
async function data(more: Record<string, number> = {}, switches: Partial<Switches> = {}): Promise<string> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({
    ...defaultSwitches(),
    limits: { all: {}, plugins: { 'mcp-http-handler': { heartbeatMs: 300, heartbeatMisses: 2, messagesPerSecond: 10, floodMs: 1000, ...more } } },
    ...switches,
  })
  await writeHolder(store, dataDir)
  return dataDir
}

const started = async (more: Record<string, number> = {}, switches: Partial<Switches> = {}) =>
  startedWith(await data(more, switches), await installDoor(fakeDoor(commands, `import { readdirSync } from 'node:fs'`), ['fs']))

const hello = async (worker: Parameters<typeof command>[0]) => (await command(worker, 'hello')).result as Facts

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A call from the editor through the shell's bridge
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    if ((message as { id?: unknown }).id === id) resolve(message)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [9000 + Math.floor(Math.random() * 1000), action, args] as const) as Promise<{ ok: boolean, result?: unknown }>

describe('a utility half', () => {
  it('answers core.self as the core names it, the door\'s host half, and is told no data folder and none of main\'s environment', async () => {
    const { worker, dataDir } = await started()
    expect(await logged(dataDir, 'plugin.started', { plugin: 'mcp-http-handler' })).toBe(true)
    const facts = await hello(worker)
    expect(facts.self).toEqual({ kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 })
    expect(facts.dataDir).toBe(null)
    expect(facts.envNames).toEqual([...Object.keys(baseEnv()), ...notFromMain].sort())
    expect(facts.envText).not.toContain(dataDir)
    expect(facts.cwdEntries).toBe(0)
    expect(facts.cwd.startsWith(dataDir)).toBe(false)
    expect(facts.pid).not.toBe(process.pid)
    // Every door.handle call the door made was delivered, none refused and tried again
    expect(await handleRefusals(worker)).toEqual([])
  })

  it('is killed once hung and reads crashed, and hetu runs on', async () => {
    const { worker, editor, dataDir } = await started()
    const { pid } = await hello(worker)
    expect((await command(worker, 'hang')).result).toBe('hanging')
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'mcp-http-handler', reason: 'unresponsive' }))
    await until(() => !alive(pid))
    expect((await ask(editor, 'core.status')).ok).toBe(true)
  })

  // A flood cap of 20 in a second, which the burst of the flood command crosses at once. A half over its rate loses its
  // pongs, but everything main hears from it counts as alive, so it is never read as hung while it floods and only the
  // cap ends it
  it('has its way closed for a flood, reads crashed and starts again on core.restart from the trusted window alone', async () => {
    const { app, worker, editor, dataDir } = await started({ floodFactor: 2 })
    const { pid } = await hello(worker)
    await send(worker, 'flood')
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'mcp-http-handler', reason: 'flood' }))
    await until(() => !alive(pid))
    expect((await ask(editor, 'core.status')).ok).toBe(true)
    expect(await ask(editor, 'core.restart', { plugin: 'mcp-http-handler' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect((await ask(editor, 'app.openSecurity')).ok).toBe(true)
    const trusted = await pageAt(app, 'hetu://trusted/')
    // Past the trusted window's input delay, inside which a request counts for nothing
    await new Promise(resolve => setTimeout(resolve, 2000))
    expect((await ask(trusted, 'core.restart', { plugin: 'mcp-http-handler' })).ok).toBe(true)
    await until(async () => (await records(dataDir)).filter(record => record.event === 'plugin.started' && record.plugin === 'mcp-http-handler').length === 2)
    // The door started again reaches the holder as its second incarnation
    await until(async () => (await reports(worker)).some(report => report.incarnation === 2))
  })

  // Lowered from 50 to 10 a second through the trusted window while the door keeps 8 calls in flight for 6 s. Paced at
  // the old rate the half would send about 45 a second and lose what main drops past 10, so calls would time out. Main
  // hears it all the same, so a dropped pong never kills it
  it('paces itself to a rate the human lowers while it runs and is never cut off for it', async () => {
    const { app, editor, worker, dataDir } = await started({ heartbeatMs: 2000, messagesPerSecond: 50 }, { confirmOff: true })
    const { pid } = await hello(worker)
    expect((await ask(editor, 'app.openSecurity')).ok).toBe(true)
    const trusted = await pageAt(app, 'hetu://trusted/')
    // Past the trusted window's input delay, inside which a request counts for nothing
    await new Promise(resolve => setTimeout(resolve, 2000))
    const change = { kind: 'limit.set', constant: 'messagesPerSecond', value: 10, plugin: 'mcp-http-handler' }
    expect(await ask(trusted, 'security.request', { change })).toMatchObject({ ok: true, result: { applied: true } })
    const load = (await command(worker, 'load', {}, 45_000)).result as { answered: number, refused: string[] }
    expect(load.refused).toEqual([])
    expect(load.answered).toBeGreaterThan(0)
    expect(await logged(dataDir, 'plugin.crashed', { plugin: 'mcp-http-handler' })).toBe(false)
    expect(alive(pid)).toBe(true)
    expect(await handleRefusals(worker)).toEqual([])
  })
})
