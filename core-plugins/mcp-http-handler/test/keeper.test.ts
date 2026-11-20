import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
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

const canConnect = (port: number | string) => new Promise<boolean>(resolve => {
  const socket = typeof port === 'string' ? net.connect(port) : net.connect({ host: '127.0.0.1', port })
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

const goodToken: TokenSeam = text => (text === 'Bearer good-token' ? { client: 'https://client.example/metadata#1' } : null)

// http on the fake core with mcp as a stand-in whose handle echoes what reached it
// A pipe name no other test or run holds, elsewhere than Windows in a folder of the user's own as the pipe's is
const freshPipe = () => (process.platform === 'win32' ? `\\\\.\\pipe\\hetu-test-${randomUUID()}` : path.join(mkdtempSync(path.join(tmpdir(), 'hetu-test-')), 'mcp.sock'))

async function started(options: { token?: TokenSeam, mcp?: 'ready' | 'starting' | 'unavailable', port?: number, pipe?: string, answer?: (call: Delivered) => unknown } = {}) {
  const port = options.port ?? await freePort()
  const pipe = options.pipe ?? freshPipe()
  const core = fakeCore({ manifest })
  cores.push(core)
  const mcp: StandIn = core.standIn('mcp', {
    actions: { handle: { from: ['mcp-http-handler'] } },
    handle: options.answer ?? (call => ({ status: 200, body: JSON.stringify({ caller: call.caller, onBehalf: call.onBehalf ?? null, args: call.args }) })),
    state: options.mcp ?? 'ready',
  })
  const state = await core.start(httpPlugin({ port, token: options.token ?? goodToken, pipe }))
  return { core, mcp, port, pipe, state }
}

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
      caller: { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 },
      onBehalf: 'https://client.example/metadata#1',
      args: { body: 'not json {', headers: { 'mcp-session-id': 's-1' } },
    })
    expect(reply.headers['content-type']).toBe('application/json')
    expect(mcp.delivered).toHaveLength(1)
  })

  it('refuses a token that names a label out of the form with 401, reaching nothing, the core hearing only the refusal', async () => {
    const { core, mcp, port } = await started({ token: () => ({ client: 'https://client.example/metadata' }) })
    await until(() => canConnect(port))
    expect((await post(port, { headers: { Authorization: 'Bearer any' } })).status).toBe(401)
    expect(mcp.delivered).toEqual([])
    await until(() => core.coreRecords.some(record => record.event === 'mcp-http-handler.refused'))
    expect(core.coreRecords.filter(record => record.event === 'mcp-http-handler.refused').map(record => record.fields.reason)).toEqual(['token'])
    expect(core.coreCalls).toEqual([])
  })

  it('asks the core nothing while it serves a request, so no state of the gate reaches it', async () => {
    const { core, mcp, port } = await started()
    await until(() => canConnect(port))
    expect((await post(port, { headers: { Authorization: 'Bearer good-token' } })).status).toBe(200)
    expect(mcp.delivered).toHaveLength(1)
    expect(core.coreCalls).toEqual([])
  })

  it('opens no door while mcp is not there, opens it when mcp turns ready, closes it when mcp goes and opens it again', async () => {
    const { core, port, state } = await started({ mcp: 'unavailable' })
    expect(state).toEqual({ state: 'ready' })
    await tick(100)
    expect(await canConnect(port)).toBe(false)
    core.setState('mcp', 'ready')
    await until(() => canConnect(port))
    core.setState('mcp', 'unavailable')
    await until(async () => !(await canConnect(port)))
    core.setState('mcp', 'ready')
    await until(() => canConnect(port))
    expect(core.coreCalls).toEqual([])
  })

  // has reads a requirement that is starting as there, since the SDK retries a call that meets starting
  it('opens the door while mcp is starting', async () => {
    const { port } = await started({ mcp: 'starting' })
    await until(() => canConnect(port))
  })

  it('answers the shipped seam\'s 401 with a bare WWW-Authenticate and reaches nothing', async () => {
    const { mcp, port } = await started({ token: refuseEveryToken })
    await until(() => canConnect(port))
    const reply = await post(port, { headers: { Authorization: 'Bearer good-token' } })
    expect(reply.status).toBe(401)
    expect(reply.headers['www-authenticate']).toBe('Bearer')
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
    expect(core.coreCalls).toEqual([{ action: 'core.bindFailed', args: { reason: 'port-taken' }, caller: { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 } }])
    expect(core.status()).toEqual({ state: 'failed', reason: 'port-taken' })
    await tick(100)
    expect(listens.mock.calls.map(([given]) => given)).toEqual([{ host: '127.0.0.1', port, exclusive: true }])
  })

  it('reports refusals at the door to the core once a second by reason, never one call a refusal', async () => {
    const { core, port, mcp } = await started()
    await until(() => canConnect(port))
    for (let i = 0; i < 5; i++) expect((await post(port, { host: 'evil.example' })).status).toBe(403)
    expect((await post(port, { headers: { Origin: 'https://evil.example', Authorization: 'Bearer good-token' } })).status).toBe(403)
    expect((await post(port, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    await until(() => core.coreRecords.filter(record => record.event === 'mcp-http-handler.refused').length === 3)
    const counts = Object.fromEntries(core.coreRecords.filter(record => record.event === 'mcp-http-handler.refused').map(record => [record.fields.reason, record.fields.count]))
    expect(counts).toEqual({ host: 5, origin: 1, token: 1 })
    expect(mcp.delivered).toEqual([])
  })

  it('opens the pipe beside the door exactly while mcp is there', async () => {
    const { core, pipe } = await started({ mcp: 'unavailable' })
    await tick(100)
    expect(await canConnect(pipe)).toBe(false)
    core.setState('mcp', 'ready')
    await until(() => canConnect(pipe))
    core.setState('mcp', 'unavailable')
    await until(async () => !(await canConnect(pipe)))
    core.setState('mcp', 'ready')
    await until(() => canConnect(pipe))
  })

  it('asks the core to connect the client a pipe connection\'s initialize names with no redirect and closes it when the core can\'t answer', async () => {
    const { core, mcp, pipe } = await started()
    await until(() => canConnect(pipe))
    const socket = net.connect(pipe)
    let closed = false
    socket.on('error', () => {})
    socket.on('close', () => { closed = true })
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'claude-code', version: '2' } } })}\n`)
    await until(() => closed)
    const asked = core.coreCalls.filter(call => call.action === 'core.consentAsk')
    expect(asked).toHaveLength(1)
    expect(asked[0].args).toMatchObject({ client: 'claude-code', name: null, redirect: null })
    expect((asked[0].args as { field: string }).field).toMatch(/^claude-code#[1-9][0-9]*$/)
    expect(mcp.delivered).toEqual([])
    await until(() => core.coreRecords.some(record => record.event === 'mcp-http-handler.refused'))
    expect(core.coreRecords.filter(record => record.event === 'mcp-http-handler.refused').map(record => record.fields.reason)).toEqual(['token'])
  })

  it('fails with bind-failed when another server holds the pipe\'s name', async () => {
    const pipe = freshPipe()
    const holder = net.createServer()
    holders.push(holder)
    await new Promise<void>(resolve => holder.listen(pipe, resolve))
    const { core } = await started({ pipe })
    await until(() => core.coreCalls.length === 1)
    expect(core.coreCalls).toEqual([{ action: 'core.bindFailed', args: { reason: 'bind-failed' }, caller: { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 } }])
    expect(core.status()).toEqual({ state: 'failed', reason: 'bind-failed' })
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
    await until(() => core.coreRecords.some(record => record.event === 'mcp-http-handler.refused'))
    await core.stop()
    const written = JSON.stringify(core.coreRecords) + lines.join('\n')
    for (const secret of secrets) expect(written).not.toContain(secret)
  })
})
