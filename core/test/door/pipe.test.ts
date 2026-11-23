import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { doorLimits, type Refusal, type RefusalReason } from '../../backend/door/checks.ts'
import { type Clients, clientsOf } from '../../backend/door/clients.ts'
import { mcpServe } from '../../backend/door/mcp.ts'
import { openPipe, type Pipe } from '../../backend/door/pipe.ts'
import type { Answer, Passed } from '../../backend/door/server.ts'

// Every test drives the pipe with a real named pipe or socket, so any framing can be sent as written

const pipes: Pipe[] = []
const sockets: net.Socket[] = []
const tables: Clients[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const pipe of pipes.splice(0)) await pipe.close()
  for (const clients of tables.splice(0)) clients.close()
})

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 3000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('never held')
    await tick()
  }
}

// A name no other test or run holds, elsewhere than Windows in a folder of the user's own as the pipe's is
const freshPath = () => (process.platform === 'win32' ? `\\\\.\\pipe\\hetu-test-${randomUUID()}` : path.join(mkdtempSync(path.join(tmpdir(), 'hetu-test-')), 'mcp.sock'))

// The core as clients.ts reaches it: every connect answered as the test says, nothing held, until a revoke
function fakeCore(answer: 'yes' | 'no' = 'yes') {
  const asked: unknown[] = []
  let holds = 'none'
  const call = async (name: string, args: unknown): Promise<unknown> => {
    if (name === 'consentAsk') {
      asked.push(args)
      return { handle: `h${asked.length}` }
    }
    if (name === 'consentAnswer') return { answer }
    if (name === 'identities') return (args as { fields: string[] }).fields.map(field => ({ field, holds }))
    throw new Error(`no core.${name}`)
  }
  return { call, asked, revoke: () => { holds = 'revoked' } }
}

type Made = { pipe: Pipe, path: string, core: ReturnType<typeof fakeCore>, clients: Clients, refused: RefusalReason[], passed: Passed[] }

// The pipe on a fresh name with clients on the fake core, labels numbered from 1 and a serve that answers with the
// label and the line it was handed unless the test serves otherwise
async function made(options: { answer?: 'yes' | 'no', serve?: (passed: Passed) => Promise<Answer | Refusal>, take?: () => boolean } = {}): Promise<Made> {
  const core = fakeCore(options.answer)
  const clients = clientsOf({ call: core.call, answerEveryMs: 5, revokeEveryMs: 20, clock: () => 1 })
  tables.push(clients)
  const refused: RefusalReason[] = []
  const passed: Passed[] = []
  const at = freshPath()
  const pipe = await openPipe({
    path: at,
    clients,
    serve: async given => {
      passed.push(given)
      if (options.serve) return options.serve(given)
      return { status: 200, body: JSON.stringify({ label: given.client, line: given.body.toString('utf8') }) }
    },
    take: options.take ?? (() => true),
    refused: reason => void refused.push(reason),
  })
  pipes.push(pipe)
  return { pipe, path: at, core, clients, refused, passed }
}

type Client = { socket: net.Socket, lines: string[], closed: () => boolean }

// A connection reading what comes back as lines
async function connect(at: string): Promise<Client> {
  const socket = net.connect(at)
  sockets.push(socket)
  const lines: string[] = []
  let text = ''
  let closed = false
  socket.on('data', data => {
    text += data.toString('utf8')
    let end = text.indexOf('\n')
    while (end >= 0) {
      lines.push(text.slice(0, end))
      text = text.slice(end + 1)
      end = text.indexOf('\n')
    }
  })
  socket.on('error', () => {})
  socket.on('close', () => { closed = true })
  await new Promise(resolve => socket.once('connect', resolve))
  return { socket, lines, closed: () => closed }
}

const initialize = (name: unknown = 'claude-code', title?: unknown) => JSON.stringify({
  jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '2.0.0', ...(title === undefined ? {} : { title }) } },
})

// A request of MCP from 2026-07-28 on, which has no initialize: each request carries the protocol version, the
// client's capabilities and its clientInfo in _meta. null leaves the clientInfo out
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
const modern = (method: string, info: unknown = { name: 'claude-code', version: '3.0.0' }) => JSON.stringify({
  jsonrpc: '2.0', id: 1, method,
  params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, ...(info === null ? {} : { [CLIENT_INFO]: info }) } },
})

const answered = (line: string) => JSON.parse(line) as { label: string, line: string }

// The JSON-RPC error a refused request is answered with
const error = (id: unknown, message: string, code = -32000) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })

describe('a connection joining', () => {
  it('names its client by the first line\'s initialize, joins it through the clients with no redirect and serves that line on behalf of its label', async () => {
    const { path: at, core, passed, clients } = await made()
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.lines.length === 1)
    expect(core.asked).toEqual([{ client: 'claude-code', name: null, redirect: null, field: 'claude-code#1' }])
    expect(answered(client.lines[0])).toEqual({ label: 'claude-code#1', line: initialize() })
    expect(passed.map(given => [given.client, given.headers])).toEqual([['claude-code#1', []]])
    expect(clients.connections()).toEqual(['claude-code#1'])
  })

  it('hands the client\'s title to the connect as its name', async () => {
    const { path: at, core } = await made()
    const client = await connect(at)
    client.socket.write(`${initialize('claude-code', 'Claude Code')}\n`)
    await until(() => client.lines.length === 1)
    expect(core.asked).toEqual([{ client: 'claude-code', name: 'Claude Code', redirect: null, field: 'claude-code#1' }])
  })

  it('gives a second connection of the client a label of its own with no second connect', async () => {
    const { path: at, core, passed } = await made()
    const one = await connect(at)
    one.socket.write(`${initialize()}\n`)
    await until(() => one.lines.length === 1)
    const two = await connect(at)
    two.socket.write(`${initialize()}\n`)
    await until(() => two.lines.length === 1)
    one.socket.write('{"id":1}\n')
    two.socket.write('{"id":2}\n')
    await until(() => one.lines.length === 2 && two.lines.length === 2)
    expect(answered(one.lines[1])).toEqual({ label: 'claude-code#1', line: '{"id":1}' })
    expect(answered(two.lines[1])).toEqual({ label: 'claude-code#2', line: '{"id":2}' })
    expect(new Set(passed.map(given => given.client))).toEqual(new Set(['claude-code#1', 'claude-code#2']))
    expect(core.asked).toHaveLength(1)
  })

  it('names its client by a modern first request\'s clientInfo in _meta as a dual-era client\'s server/discover carries it and serves that line as it came', async () => {
    const { path: at, core, passed } = await made()
    const client = await connect(at)
    client.socket.write(`${modern('server/discover')}\n`)
    await until(() => client.lines.length === 1)
    expect(core.asked).toEqual([{ client: 'claude-code', name: null, redirect: null, field: 'claude-code#1' }])
    expect(answered(client.lines[0])).toEqual({ label: 'claude-code#1', line: modern('server/discover') })
    expect(passed).toHaveLength(1)
  })

  it('names its client by any modern request\'s clientInfo with its title as the name', async () => {
    const { path: at, core } = await made()
    const client = await connect(at)
    client.socket.write(`${modern('tools/list', { name: 'claude-code', version: '3', title: 'Claude Code' })}\n`)
    await until(() => client.lines.length === 1)
    expect(core.asked).toEqual([{ client: 'claude-code', name: 'Claude Code', redirect: null, field: 'claude-code#1' }])
  })

  it('refuses a modern first request with no clientInfo with a JSON-RPC error carrying its id and closes, asking the core nothing', async () => {
    const { path: at, core, refused } = await made()
    const client = await connect(at)
    client.socket.write(`${modern('server/discover', null)}\n`)
    await until(() => client.closed())
    expect(client.lines).toEqual([error(1, 'invalid params', -32602)])
    expect(refused).toEqual(['malformed'])
    expect(core.asked).toEqual([])
  })

  it('refuses a first line that names no client as malformed, closes and asks the core nothing', async () => {
    for (const first of ['not json', '{"jsonrpc":"2.0","id":0,"method":"tools/list"}', initialize(7), initialize(''), '[]', 'null', '5', '"initialize"',
    '{"method":"initialize","params":null}', '{"method":"initialize","params":"x"}', '{"method":"initialize","params":{"clientInfo":"claude-code"}}',
    modern('server/discover', { name: 7 }), modern('server/discover', { name: '' }), '{"method":"server/discover","params":{"_meta":"x"}}',
    '{"method":"server/discover","params":{"_meta":{"clientInfo":{"name":"claude-code"}}}}',
    // An initialize is named by its own clientInfo alone
    JSON.stringify({ method: 'initialize', params: { _meta: { [CLIENT_INFO]: { name: 'claude-code' } } } })]) {
      const { path: at, core, refused, passed } = await made()
      const client = await connect(at)
      client.socket.write(`${first}\n`)
      await until(() => client.closed())
      expect(refused, first).toEqual(['malformed'])
      expect(core.asked).toEqual([])
      expect(passed).toEqual([])
    }
  })

  it('answers a refused first line that carries an id with a JSON-RPC error before it closes', async () => {
    const { path: at } = await made()
    const client = await connect(at)
    client.socket.write('{"jsonrpc":"2.0","id":"a","method":"tools/list"}\n')
    await until(() => client.closed())
    expect(client.lines).toEqual([error('a', 'invalid params', -32602)])
  })

  it('refuses a client the human turned away as token, answers its initialize with a JSON-RPC error, closes and serves nothing', async () => {
    const { path: at, refused, passed } = await made({ answer: 'no' })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.closed())
    expect(refused).toEqual(['token'])
    expect(passed).toEqual([])
    expect(client.lines).toEqual([error(0, 'refused')])
  })

  it('refuses a first line past the rate with a JSON-RPC error and closes, asking the core nothing', async () => {
    const { path: at, core, refused } = await made({ take: () => false })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.closed())
    expect(refused).toEqual(['rate'])
    expect(core.asked).toEqual([])
    expect(client.lines).toEqual([error(0, 'throttled')])
  })

  it('holds the lines sent behind the first until the client joined, then serves them in order', async () => {
    const { path: at, passed } = await made()
    const client = await connect(at)
    client.socket.write(`${initialize()}\n{"id":1}\n{"id":2}\n`)
    await until(() => client.lines.length === 3)
    expect(passed.map(given => given.body.toString('utf8'))).toEqual([initialize(), '{"id":1}', '{"id":2}'])
  })
})

describe('lines', () => {
  it('reads a line split over many writes and many lines in one write', async () => {
    const { path: at } = await made()
    const client = await connect(at)
    const first = `${initialize()}\n`
    client.socket.write(first.slice(0, 10))
    await tick(20)
    client.socket.write(`${first.slice(10)}{"id":1}\n{"id":2}\n{"id"`)
    await tick(20)
    client.socket.write(':3}\n')
    await until(() => client.lines.length === 4)
    expect(client.lines.slice(1).map(line => answered(line).line)).toEqual(['{"id":1}', '{"id":2}', '{"id":3}'])
  })

  it('serves a line of exactly the cap', async () => {
    const { path: at, passed } = await made()
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.lines.length === 1)
    const line = `"${'x'.repeat(doorLimits.mcpBodyBytes - 2)}"`
    client.socket.write(`${line}\n`)
    await until(() => passed.length === 2)
    expect(passed[1].body.length).toBe(doorLimits.mcpBodyBytes)
  })

  it('refuses a line past the cap as size before its end arrives, closes and never serves it', async () => {
    const { path: at, refused, passed } = await made()
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.lines.length === 1)
    client.socket.write('x'.repeat(doorLimits.mcpBodyBytes + 1))
    await until(() => client.closed())
    expect(refused).toEqual(['size'])
    expect(passed).toHaveLength(1)
  })

  it('refuses a first line past the cap as size with no connect', async () => {
    const { path: at, core, refused, passed } = await made()
    const client = await connect(at)
    client.socket.write(`${'x'.repeat(doorLimits.mcpBodyBytes + 1)}\n`)
    await until(() => client.closed())
    expect(refused).toEqual(['size'])
    expect(core.asked).toEqual([])
    expect(passed).toEqual([])
  })

  it('writes nothing back for an answer with no body, a notification\'s 202', async () => {
    const { path: at } = await made({ serve: async given => (given.body.toString('utf8').includes('notifications/') ? { status: 202, body: null } : { status: 200, body: '{"ok":true}' }) })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"id":1}\n`)
    await until(() => client.lines.length === 2)
    await tick(30)
    expect(client.lines).toEqual(['{"ok":true}', '{"ok":true}'])
  })

  it('passes MCP\'s own answers of 400 and 404 on as they are', async () => {
    const statuses = [200, 400, 404]
    const { path: at } = await made({ serve: async () => { const status = statuses.shift()!; return { status, body: `{"s":${status}}` } } })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n{"id":1}\n{"id":2}\n`)
    await until(() => client.lines.length === 3)
    expect(client.lines.sort()).toEqual(['{"s":200}', '{"s":400}', '{"s":404}'])
  })

  it('answers a request the serving part refused with a JSON-RPC error carrying its id and a notification with nothing, keeping the connection', async () => {
    const refusals: Record<string, Answer> = {
      1: { status: 503, body: '{"error":"unavailable"}' },
      2: { status: 504, body: '{"error":"timeout"}' },
      3: { status: 429, body: '{"error":"throttled"}' },
      '"four"': { status: 413, body: '{"error":"too large"}' },
      5: { status: 502, body: '{"error":"bad gateway"}' },
      none: { status: 503, body: '{"error":"unavailable"}' },
    }
    const { path: at } = await made({
      serve: async given => {
        const text = given.body.toString('utf8')
        if (text.includes('"method":"initialize"')) return { status: 200, body: '{}' }
        return refusals[text.match(/"id":([^,}]+)/)?.[1] ?? 'none']
      },
    })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n`)
    for (const id of ['1', '2', '3', '"four"', '5']) client.socket.write(`{"jsonrpc":"2.0","id":${id},"method":"tools/call"}\n`)
    await until(() => client.lines.length === 6)
    await tick(30)
    expect(client.lines.slice(1).sort()).toEqual([
      error(1, 'unavailable'), error(2, 'timeout'), error(3, 'throttled'), error('four', 'too large'), error(5, 'bad gateway'),
    ].sort())
    expect(client.closed()).toBe(false)
  })
})

describe('refusals and the end of a connection', () => {
  it('spends the shared rate on every line and answers one past it with a JSON-RPC error, keeping the connection', async () => {
    let left = 2
    const { path: at, refused, passed } = await made({ take: () => left-- > 0 })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n{"id":1}\n{"id":2}\n`)
    await until(() => client.lines.length === 3)
    expect(refused).toEqual(['rate'])
    expect(passed.map(given => given.body.toString('utf8'))).toEqual([initialize(), '{"id":1}'])
    expect(client.lines).toContain(error(2, 'throttled'))
    left = 1
    client.socket.write('{"id":3}\n')
    await until(() => client.lines.length === 4)
    expect(answered(client.lines[3]).line).toBe('{"id":3}')
    expect(client.closed()).toBe(false)
  })

  it('answers a call past the cap on calls in flight with a JSON-RPC error and keeps the connection and its other calls', async () => {
    const signals: AbortSignal[] = []
    let answer = () => {}
    const slow = new Promise<void>(resolve => { answer = resolve })
    const serve = mcpServe(async (args, options) => {
      if (args.body.includes('initialize')) return { status: 200, body: '{}' }
      signals.push(options.signal)
      await slow
      return { status: 200, body: args.body }
    })
    const { path: at, refused } = await made({ serve })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.lines.length === 1)
    for (let id = 1; id <= doorLimits.callsPerClient + 1; id++) client.socket.write(`{"id":${id}}\n`)
    await until(() => client.lines.length === 2)
    expect(client.lines[1]).toBe(error(doorLimits.callsPerClient + 1, 'throttled'))
    expect(refused).toEqual(['rate'])
    answer()
    await until(() => client.lines.length === doorLimits.callsPerClient + 2)
    expect(signals.some(signal => signal.aborted)).toBe(false)
    expect(client.closed()).toBe(false)
  })

  it('lets an answer written before a refusal reach a client still reading it before the connection ends', async () => {
    const big = `"${'x'.repeat(1024 * 1024)}"`
    const { path: at, refused } = await made({
      serve: async given => {
        const text = given.body.toString('utf8')
        if (text === '{"id":1}') return { status: 200, body: big }
        if (text === 'bad') return new Promise(resolve => setTimeout(() => resolve({ status: 400, reason: 'malformed' }), 50))
        return { status: 200, body: '{}' }
      },
    })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.lines.length === 1)
    client.socket.pause()
    client.socket.write('{"id":1}\nbad\n')
    await until(() => refused.length === 1)
    client.socket.resume()
    await until(() => client.closed())
    expect(client.lines).toEqual(['{}', big])
  })

  it('refuses a line that is no UTF-8 as malformed and closes', async () => {
    const { path: at, refused } = await made({ serve: mcpServe(async args => ({ status: 200, body: args.body })) })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n{"id":1}\n`)
    await until(() => client.lines.length === 2)
    client.socket.write(Buffer.from([0xff, 0xfe, 0x0a]))
    await until(() => client.closed())
    expect(refused).toEqual(['malformed'])
    expect(client.lines).toEqual([initialize(), '{"id":1}'])
  })

  it('aborts the calls a connection carries when its client goes and leaves the clients\' table', async () => {
    const signals: AbortSignal[] = []
    const { path: at, clients } = await made({
      serve: given => {
        signals.push(given.signal)
        if (signals.length === 1) return Promise.resolve({ status: 200, body: '{}' })
        return new Promise(resolve => given.signal.addEventListener('abort', () => resolve({ status: 200, body: null })))
      },
    })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n{"id":1}\n`)
    await until(() => signals.length === 2)
    expect(clients.connections()).toEqual(['claude-code#1'])
    client.socket.destroy()
    await until(() => signals[1].aborted)
    expect(signals[0].aborted).toBe(false)
    await until(() => clients.connections().length === 0)
  })

  it('closes a connection of a client revoked in the trusted window', async () => {
    const { path: at, core } = await made()
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.lines.length === 1)
    core.revoke()
    await until(() => client.closed())
  })

  it('leaves a connection that went while its client was joining out of the clients\' table', async () => {
    let release = () => {}
    const core = fakeCore()
    const held = new Promise<void>(resolve => { release = resolve })
    const clients = clientsOf({ call: async (name, args) => { if (name === 'consentAnswer') await held; return core.call(name, args) }, answerEveryMs: 5, clock: () => 1 })
    tables.push(clients)
    const at = freshPath()
    const passed: Passed[] = []
    pipes.push(await openPipe({ path: at, clients, serve: async given => { passed.push(given); return { status: 200, body: '{}' } }, take: () => true, refused: () => {} }))
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => core.asked.length === 1)
    client.socket.destroy()
    await tick(30)
    release()
    await tick(50)
    expect(clients.connections()).toEqual([])
    expect(passed).toEqual([])
  })
})

// A socket's folder exists outside Windows alone
describe.skipIf(process.platform === 'win32')('the socket\'s folder', () => {
  const opened = (at: string) => openPipe({ path: at, clients: { join: async () => null }, serve: async () => ({ status: 200, body: null }), take: () => true, refused: () => {} })

  it('is made for its owner alone', async () => {
    const at = path.join(mkdtempSync(path.join(tmpdir(), 'hetu-test-')), 'pipe', 'mcp.sock')
    pipes.push(await opened(at))
    expect(statSync(path.dirname(at)).mode & 0o777).toBe(0o700)
  })

  it('refuses a folder of the user\'s own that others may open', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'hetu-test-'))
    chmodSync(folder, 0o755)
    await expect(opened(path.join(folder, 'mcp.sock'))).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('takes away a socket no server answers on, one a crashed run left', async () => {
    const at = freshPath()
    // A process that ends with its server still listening leaves the socket behind
    spawnSync(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(at)}, () => process.exit(0))`])
    expect(lstatSync(at).isSocket()).toBe(true)
    pipes.push(await opened(at))
    expect(await new Promise(resolve => net.connect(at).once('connect', () => resolve(true)).once('error', () => resolve(false)))).toBe(true)
  })

  it('leaves anything at the name that is no socket and fails', async () => {
    const at = freshPath()
    writeFileSync(at, 'kept')
    await expect(opened(at)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(readFileSync(at, 'utf8')).toBe('kept')
  })
})

describe('the pipe', () => {
  it('fails to open on a name another server holds', async () => {
    const { path: at } = await made()
    const clients = clientsOf({ call: fakeCore().call })
    tables.push(clients)
    await expect(openPipe({ path: at, clients, serve: async () => ({ status: 200, body: null }), take: () => true, refused: () => {} })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('closes every connection it holds when it closes', async () => {
    const { path: at, pipe } = await made()
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.lines.length === 1)
    await pipe.close()
    await until(() => client.closed())
    await expect(new Promise((resolve, reject) => net.connect(at).once('connect', resolve).once('error', reject))).rejects.toBeTruthy()
  })
})
