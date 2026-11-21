import { lstat, mkdir, unlink } from 'node:fs/promises'
import net from 'node:net'
import { doorLimits, type Refusal, type RefusalReason } from './checks.ts'
import type { Clients, Joined } from './clients.ts'
import { refusedWords } from './mcp.ts'
import type { Answer, Passed } from './server.ts'

// The local pipe beside the door: MCP's stdio framing, one JSON-RPC message a line, from a program on this computer the
// shim relays. No token is traded on it. The first line names the client, which joins through the clients table before
// anything is served. Every line then goes to the same serving part as the door's, on behalf of
// the connection's own label and under the door's rate. A request past the rate or the calls in flight, or one the
// serving part answers with a fixed body, gets a JSON-RPC error with its id and the connection stays. A line past the
// cap, bytes that are no UTF-8 and a refused first line are recorded by their reason and close the connection

export type PipeOptions = {
  path: string
  clients: Pick<Clients, 'join'>
  serve: (passed: Passed) => Promise<Answer | Refusal>
  // The rate every listener shares, false past it
  take: () => boolean
  refused: (reason: RefusalReason) => void
}

export type Pipe = { close(): Promise<void> }

const NEWLINE = 0x0a

// Where MCP from 2026-07-28 on, which has no initialize, carries the client's name in each request's _meta
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'

// A first line as far as it is read. Reading a field of any value JSON gives but null throws nothing
type Info = { name?: unknown, title?: unknown }
type First = { method?: unknown, params?: { clientInfo?: Info, _meta?: Record<string, Info | undefined> } } | null

// The client a first line names by its clientInfo's name, with its title as the name the connect shows when it gives
// one: an initialize's own clientInfo, or the clientInfo in any other request's _meta, such as the server/discover a
// client of both eras sends first. null for a line that names no client
export function clientOf(line: Buffer): { client: string, name: string | null } | null {
  let message: First
  try {
    message = JSON.parse(line.toString('utf8')) as First
  } catch {
    return null
  }
  const info = message?.method === 'initialize' ? message.params?.clientInfo : message?.params?._meta?.[CLIENT_INFO]
  if (typeof info?.name !== 'string' || info.name === '') return null
  return { client: info.name, name: typeof info.title === 'string' ? info.title : null }
}

// The id of the request a line carries, a string or a number, read for its error alone
function idOf(line: Buffer): string | number | undefined {
  try {
    const id = (JSON.parse(line.toString('utf8')) as { id?: unknown } | null)?.id
    return typeof id === 'string' || typeof id === 'number' ? id : undefined
  } catch {
    return undefined
  }
}

// On macOS and Linux the socket sits in a folder only its owner may open, made here, or one already there taken only
// when it is this user's own and no one else may open it, so no other user can swap the socket for one of theirs
async function ownFolder(at: string): Promise<void> {
  const folder = at.slice(0, at.lastIndexOf('/'))
  await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const seen = await lstat(folder)
  if (!seen.isDirectory() || seen.uid !== process.getuid?.() || (seen.mode & 0o077) !== 0) {
    throw Object.assign(new Error('the pipe\'s folder is not the user\'s own'), { code: 'EACCES' })
  }
}

// Whether a server answers on the name
const answers = (at: string) => new Promise<boolean>(resolve => {
  const probe = net.connect(at)
  probe.once('connect', () => { probe.destroy(); resolve(true) })
  probe.once('error', () => resolve(false))
})

const listen = (server: net.Server, at: string) => new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen({ path: at, exclusive: true }, () => {
    server.off('error', reject)
    resolve()
  })
})

// Opens the pipe on its name or rejects. A name another server holds is never shared: on Windows the first server of a
// pipe name keeps it. Elsewhere a socket is taken away only when no server answers on it, one a run that crashed left,
// and anything at the name that is no socket stays
export async function openPipe(options: PipeOptions): Promise<Pipe> {
  const { path: at, take, refused } = options
  const sockets = new Set<net.Socket>()

  const served = (socket: net.Socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    let rest: Buffer = Buffer.alloc(0)
    let joined: Joined | null = null
    let joining = false
    // The calls the connection carries, all cancelled when it closes
    const calls = new Set<AbortController>()
    socket.once('close', () => {
      sockets.delete(socket)
      for (const call of calls) call.abort()
      joined?.leave()
    })

    const open = () => !socket.destroyed && !socket.writableEnded

    // The connection ends once what was written went out, at the latest the door's request time later
    const refuse = (reason: RefusalReason) => {
      if (!open()) return
      refused(reason)
      const cap = setTimeout(() => socket.destroy(), doorLimits.requestMs)
      cap.unref?.()
      socket.once('close', () => clearTimeout(cap))
      socket.end(() => socket.destroy())
    }

    // A request's JSON-RPC error, written only when the line carries an id, so a notification gets none
    const answerError = (line: Buffer, message: string, code = -32000) => {
      const id = idOf(line)
      if (id !== undefined && open()) socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
    }

    // A call past the rate or the calls in flight is answered and the connection kept. Any other refusal ends it
    const one = async (line: Buffer, label: string) => {
      const gone = new AbortController()
      calls.add(gone)
      const given = await options.serve({ client: label, body: line, headers: [], signal: gone.signal }).catch(() => null)
      calls.delete(gone)
      if (!open()) return
      if (given === null) return void socket.destroy()
      if ('reason' in given && given.reason !== 'rate') return refuse(given.reason)
      if ('reason' in given) {
        refused('rate')
        return answerError(line, refusedWords[429])
      }
      if (Object.hasOwn(refusedWords, given.status)) return answerError(line, refusedWords[given.status])
      if (given.body !== null) socket.write(`${given.body}\n`)
    }

    // Lines behind the first are held until the client joined. A first line refused is answered before the end
    const first = async (line: Buffer) => {
      if (!take()) {
        answerError(line, refusedWords[429])
        return refuse('rate')
      }
      const named = clientOf(line)
      if (named === null) {
        answerError(line, 'invalid params', -32602)
        return refuse('malformed')
      }
      const got = await options.clients.join(named.client, named.name, () => socket.destroy()).catch(() => null)
      if (got === null) {
        answerError(line, 'refused')
        return refuse('token')
      }
      if (!open()) return got.leave()
      joined = got
      joining = false
      void one(line, got.label)
      read()
    }

    // Each whole line in what came, a line past the cap refused before its end arrives and the lines held while the
    // client joins within the cap too
    const read = () => {
      while (open()) {
        const end = rest.indexOf(NEWLINE)
        if (joining || end < 0) return void (rest.length > doorLimits.mcpBodyBytes && refuse('size'))
        if (end > doorLimits.mcpBodyBytes) return refuse('size')
        const line = rest.subarray(0, end)
        rest = rest.subarray(end + 1)
        if (joined === null) {
          joining = true
          void first(line)
          return
        }
        if (take()) void one(line, joined.label)
        else {
          refused('rate')
          answerError(line, refusedWords[429])
        }
      }
    }

    socket.on('data', (chunk: Buffer) => {
      rest = rest.length === 0 ? chunk : Buffer.concat([rest, chunk])
      read()
    })
  }

  const server = net.createServer(served)
  server.maxConnections = doorLimits.connections
  if (process.platform !== 'win32') await ownFolder(at)
  try {
    await listen(server, at)
  } catch (error) {
    if (process.platform === 'win32' || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || await answers(at) || !(await lstat(at)).isSocket()) throw error
    await unlink(at)
    await listen(server, at)
  }
  return {
    close: () => new Promise<void>(done => {
      server.close(() => done())
      for (const socket of sockets) socket.destroy()
    }),
  }
}
