import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { doorLimits, type Refusal, type RefusalReason } from '../src/checks.ts'
import { type Clients, clientsOf } from '../src/clients.ts'
import { openPipe, type Pipe } from '../src/pipe.ts'
import type { Answer, Passed } from '../src/server.ts'

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

const answered = (line: string) => JSON.parse(line) as { label: string, line: string }

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

  it('refuses a first line that is no initialize naming a client as malformed, closes and asks the core nothing', async () => {
    for (const first of ['not json', '{"jsonrpc":"2.0","id":0,"method":"tools/list"}', initialize(7), initialize(''), '[]', 'null', '5', '"initialize"',
    '{"method":"initialize","params":null}', '{"method":"initialize","params":"x"}', '{"method":"initialize","params":{"clientInfo":"claude-code"}}']) {
      const { path: at, core, refused, passed } = await made()
      const client = await connect(at)
      client.socket.write(`${first}\n`)
      await until(() => client.closed())
      expect(refused, first).toEqual(['malformed'])
      expect(core.asked).toEqual([])
      expect(passed).toEqual([])
    }
  })

  it('refuses a client the human turned away as token, closes and serves nothing', async () => {
    const { path: at, refused, passed } = await made({ answer: 'no' })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.closed())
    expect(refused).toEqual(['token'])
    expect(passed).toEqual([])
    expect(client.lines).toEqual([])
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

  it('passes the answer\'s body of any status as a line', async () => {
    const { path: at } = await made({ serve: async () => ({ status: 503, body: '{"error":"unavailable"}' }) })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.lines.length === 1)
    expect(client.lines).toEqual(['{"error":"unavailable"}'])
    expect(client.closed()).toBe(false)
  })
})

describe('refusals and the end of a connection', () => {
  it('spends the shared rate on every line and refuses one past it as rate, closing', async () => {
    let left = 2
    const { path: at, refused, passed } = await made({ take: () => left-- > 0 })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n{"id":1}\n{"id":2}\n`)
    await until(() => client.closed())
    expect(refused).toEqual(['rate'])
    expect(passed.map(given => given.body.toString('utf8'))).toEqual([initialize(), '{"id":1}'])
  })

  it('records a refusal the serving part answers and closes', async () => {
    const { path: at, refused } = await made({ serve: async () => ({ status: 429, reason: 'rate' }) })
    const client = await connect(at)
    client.socket.write(`${initialize()}\n`)
    await until(() => client.closed())
    expect(refused).toEqual(['rate'])
    expect(client.lines).toEqual([])
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

  it('refuses a folder another user could open', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'hetu-test-'))
    chmodSync(folder, 0o755)
    await expect(opened(path.join(folder, 'mcp.sock'))).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('takes away a socket no server answers on, one a crashed run left', async () => {
    const at = freshPath()
    writeFileSync(at, '')
    pipes.push(await opened(at))
    expect(await new Promise(resolve => net.connect(at).once('connect', () => resolve(true)).once('error', () => resolve(false)))).toBe(true)
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
