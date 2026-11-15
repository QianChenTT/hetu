import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Delivered, type FakeCore, fakeCore, type StandIn } from '@hetu/sdk/testing'
import { refuseEveryToken, type TokenSeam } from '../src/checks.ts'
import { httpPlugin } from '../src/keeper.ts'

const manifest = path.join(import.meta.dirname, '..', 'hetu-plugin.json')
const cores: FakeCore[] = []
const holders: net.Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const core of cores.splice(0)) {
    await core.stop()
    await core.close()
  }
  for (const holder of holders.splice(0)) await new Promise(resolve => holder.close(resolve))
})

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  for (let waited = 0; !(await check()); waited += 10) {
    if (waited > ms) throw new Error('never held')
    await tick(10)
  }
}

// A port on 127.0.0.1 that was free a moment ago, so a test knows the door's port before it binds
async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve))
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

const canConnect = (port: number) => new Promise<boolean>(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})

type Reply = { status: number, headers: http.IncomingHttpHeaders, body: string }

// One POST /mcp on its own connection, the Host as named or the door's own
function post(port: number, options: { headers?: Record<string, string>, body?: string, host?: string, path?: string } = {}): Promise<Reply> {
  const body = options.body ?? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: options.path ?? '/mcp', agent: false, setHost: false,
      headers: { Host: options.host ?? `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...options.headers },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const goodToken: TokenSeam = async text => (text === 'Bearer good-token' ? { client: 'https://client.example/metadata' } : null)

// http on the fake core with mcp as a stand-in whose handle echoes what reached it, or no mcp at all. The port reaches
// http in its init, as the loader tells it the human's setting
async function started(options: { token?: TokenSeam, mcp?: 'ready' | 'starting' | 'unavailable' | 'none', port?: number | null, answer?: (call: Delivered) => unknown } = {}) {
  const port = options.port === undefined ? await freePort() : options.port
  const core = fakeCore({ manifest, ...(port === null ? {} : { port }) })
  cores.push(core)
  const mcp: StandIn | null = options.mcp === 'none' ? null : core.standIn('mcp', {
    actions: { handle: { from: ['http'] } },
    handle: options.answer ?? (call => ({ status: 200, body: JSON.stringify({ caller: call.caller, onBehalf: call.onBehalf ?? null, args: call.args }) })),
    state: options.mcp ?? 'ready',
  })
  const state = await core.start(httpPlugin({ token: options.token ?? goodToken }))
  return { core, mcp: mcp!, port: port ?? 0, state }
}

const unavailable = '{"error":"unavailable"}'

describe('http on the fake core', () => {
  it('reads ready and opens the door once mcp is there, a request reaching mcp.handle as http\'s host half on behalf of the token\'s client', async () => {
    const { mcp, port, state } = await started()
    expect(state).toEqual({ state: 'ready' })
    await until(() => canConnect(port))
    const reply = await post(port, {
      headers: { Authorization: 'Bearer good-token', 'Mcp-Session-Id': 's-1', 'X-On-Behalf': 'someone-else', Cookie: 'a=b' },
      body: 'not json {',
    })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({
      caller: { kind: 'plugin', id: 'http', half: 'host', incarnation: 1 },
      onBehalf: 'https://client.example/metadata',
      args: { body: 'not json {', headers: { 'mcp-session-id': 's-1' } },
    })
    expect(reply.headers['content-type']).toBe('application/json')
    expect(mcp.delivered).toHaveLength(1)
  })

  // The port is held for the whole run, so no other program can take it while mcp is away
  it('binds on start with no mcp in the install, reads ready and answers 503 with the fixed body', async () => {
    const { core, port, state } = await started({ mcp: 'none' })
    expect(state).toEqual({ state: 'ready' })
    expect(await canConnect(port)).toBe(true)
    const reply = await post(port, { headers: { Authorization: 'Bearer good-token' } })
    expect([reply.status, reply.body, reply.headers['content-type']]).toEqual([503, unavailable, 'application/json'])
    expect(core.coreCalls).toEqual([])
  })

  it('holds the port while mcp is away, starting or stopped, answering 503, and serves once it is ready, bound once', async () => {
    const port = await freePort()
    const listens = vi.spyOn(net.Server.prototype, 'listen')
    const { core, mcp } = await started({ mcp: 'unavailable', port })
    expect(await canConnect(port)).toBe(true)
    expect((await post(port, { headers: { Authorization: 'Bearer good-token' } })).status).toBe(503)
    core.setState('mcp', 'ready')
    await until(async () => (await post(port, { headers: { Authorization: 'Bearer good-token' } })).status === 200)
    core.setState('mcp', 'unavailable')
    await until(async () => (await post(port, { headers: { Authorization: 'Bearer good-token' } })).status === 503)
    expect(await canConnect(port)).toBe(true)
    core.setState('mcp', 'starting')
    await tick(50)
    expect((await post(port, { headers: { Authorization: 'Bearer good-token' } })).status).toBe(503)
    core.setState('mcp', 'ready')
    await until(async () => (await post(port, { headers: { Authorization: 'Bearer good-token' } })).status === 200)
    expect(listens).toHaveBeenCalledTimes(1)
    expect(mcp.delivered).toHaveLength(2)
    expect(core.coreCalls).toEqual([])
  })

  // has folds starting into there, since a call retries it. The door reads the state itself and answers at once
  it('answers 503 at once while mcp is starting, never waiting out the call\'s retries', async () => {
    const { mcp, port } = await started({ mcp: 'starting' })
    const asked = performance.now()
    const reply = await post(port, { headers: { Authorization: 'Bearer good-token' } })
    expect([reply.status, reply.body]).toEqual([503, unavailable])
    expect(performance.now() - asked).toBeLessThan(1000)
    expect(mcp.delivered).toEqual([])
  })

  it('lets the port go on stop and binds nothing after', async () => {
    const port = await freePort()
    const listens = vi.spyOn(net.Server.prototype, 'listen')
    const { core } = await started({ mcp: 'unavailable', port })
    expect(await canConnect(port)).toBe(true)
    await core.stop()
    expect(await canConnect(port)).toBe(false)
    core.setState('mcp', 'ready')
    await tick(100)
    expect(await canConnect(port)).toBe(false)
    expect(listens).toHaveBeenCalledTimes(1)
  })

  it('answers the shipped seam 401 with a Bearer challenge naming the resource metadata on its port and reaches nothing', async () => {
    const { mcp, port } = await started({ token: refuseEveryToken })
    await until(() => canConnect(port))
    const reply = await post(port, { headers: { Authorization: 'Bearer good-token' } })
    expect(reply.status).toBe(401)
    expect(reply.headers['www-authenticate']).toBe(`Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp"`)
    expect(mcp.delivered).toEqual([])
  })

  it('fails with port-taken when 127.0.0.1 and its port are held, never trying another port', async () => {
    const port = await freePort()
    const holder = net.createServer()
    holders.push(holder)
    await new Promise<void>(resolve => holder.listen({ host: '127.0.0.1', port }, resolve))
    const listens = vi.spyOn(net.Server.prototype, 'listen')
    const { core } = await started({ port })
    await until(() => core.coreCalls.length === 1)
    expect(core.coreCalls).toEqual([{ action: 'core.bindFailed', args: { reason: 'port-taken' }, caller: { kind: 'plugin', id: 'http', half: 'host', incarnation: 1 } }])
    expect(core.status()).toEqual({ state: 'failed', reason: 'port-taken' })
    // A failed bind stays failed: no change the core tells and no time tries it again
    core.setState('mcp', 'unavailable')
    core.setState('mcp', 'ready')
    await tick(300)
    expect(listens.mock.calls.map(([given]) => given)).toEqual([{ host: '127.0.0.1', port, exclusive: true }])
  })

  // One place holds the port: what init names is bound and is the only port the Host check takes
  it('binds the port its init names and takes a Host naming it alone, 4747 refused', async () => {
    const { port, mcp } = await started()
    await until(() => canConnect(port))
    expect((await post(port, { host: '127.0.0.1:4747', headers: { Authorization: 'Bearer good-token' } })).status).toBe(403)
    expect((await post(port, { host: `127.0.0.1:${port + 1}`, headers: { Authorization: 'Bearer good-token' } })).status).toBe(403)
    expect((await post(port, { headers: { Authorization: 'Bearer good-token' } })).status).toBe(200)
    expect(mcp.delivered).toHaveLength(1)
  })

  it('binds nothing when its init names no port and tells the core bind-failed', async () => {
    const listens = vi.spyOn(net.Server.prototype, 'listen')
    const { core } = await started({ port: null })
    await until(() => core.coreCalls.length === 1)
    expect(core.coreCalls).toEqual([{ action: 'core.bindFailed', args: { reason: 'bind-failed' }, caller: { kind: 'plugin', id: 'http', half: 'host', incarnation: 1 } }])
    expect(core.status()).toEqual({ state: 'failed', reason: 'bind-failed' })
    expect(listens).not.toHaveBeenCalled()
  })

  it('reports refusals at the door to the core once a second by reason, never one call a refusal', async () => {
    const { core, port, mcp } = await started()
    await until(() => canConnect(port))
    for (let i = 0; i < 5; i++) expect((await post(port, { host: 'evil.example' })).status).toBe(403)
    expect((await post(port, { headers: { Origin: 'https://evil.example', Authorization: 'Bearer good-token' } })).status).toBe(403)
    expect((await post(port, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    await until(() => core.floor.filter(record => record.event === 'http.refused').length === 3)
    const counts = Object.fromEntries(core.floor.filter(record => record.event === 'http.refused').map(record => [record.fields.reason, record.fields.count]))
    expect(counts).toEqual({ host: 5, origin: 1, token: 1 })
    expect(mcp.delivered).toEqual([])
  })

  it('writes no token, body, query, Host or Origin text to any record or line', async () => {
    const lines: string[] = []
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream)
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        lines.push(String(chunk))
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
      }) as typeof stream.write)
    }
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    const { core, port } = await started({ answer: () => ({ status: 200, body: null }) })
    await until(() => canConnect(port))
    const secrets = ['good-token', 'body-secret', 'query-secret', 'evil-host.example', 'evil-origin.example']
    await post(port, { headers: { Authorization: 'Bearer good-token' }, body: '{"x":"body-secret"}' })
    await post(port, { headers: { Authorization: 'Bearer good-token' }, path: '/mcp?q=query-secret' })
    await post(port, { host: 'evil-host.example', headers: { Authorization: 'Bearer good-token' } })
    await post(port, { headers: { Authorization: 'Bearer good-token', Origin: 'https://evil-origin.example' } })
    await until(() => core.floor.some(record => record.event === 'http.refused'))
    await core.stop()
    const written = JSON.stringify(core.floor) + lines.join('\n')
    for (const secret of secrets) expect(written).not.toContain(secret)
  })
})
