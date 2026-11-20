import { lstat, mkdir, unlink } from 'node:fs/promises'
import net from 'node:net'
import { doorLimits, type Refusal, type RefusalReason } from './checks.ts'
import type { Clients, Joined } from './clients.ts'
import type { Answer, Passed } from './server.ts'

// The local pipe beside the door: MCP's stdio framing, one JSON-RPC message a line, from a program on this computer the
// shim relays. No token is traded on it. The first line, MCP's initialize, names the client, which joins through the
// clients table before anything is served. Every line then goes to the same serving part as the door's, on behalf of
// the connection's own label and under the door's rate. A refusal is recorded by its reason and closes the connection

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

// An initialize as far as it is read. Reading a field of any value JSON gives but null throws nothing
type Initialize = { method?: unknown, params?: { clientInfo?: { name?: unknown, title?: unknown } } } | null

// The client an initialize names by clientInfo.name, with its title as the name the connect shows when it gives one.
// null for a line that is no initialize naming a client
export function clientOf(line: Buffer): { client: string, name: string | null } | null {
  let message: Initialize
  try {
    message = JSON.parse(line.toString('utf8')) as Initialize
  } catch {
    return null
  }
  const info = message?.method === 'initialize' ? message.params?.clientInfo : undefined
  if (typeof info?.name !== 'string' || info.name === '') return null
  return { client: info.name, name: typeof info.title === 'string' ? info.title : null }
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
// pipe name keeps it. Elsewhere a socket is taken away only when no server answers on it, one a run that crashed left
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

    const refuse = (reason: RefusalReason) => {
      if (socket.destroyed) return
      refused(reason)
      socket.destroy()
    }

    const one = async (line: Buffer, label: string) => {
      const gone = new AbortController()
      calls.add(gone)
      const given = await options.serve({ client: label, body: line, headers: [], signal: gone.signal }).catch(() => null)
      calls.delete(gone)
      if (socket.destroyed) return
      if (given === null) return void socket.destroy()
      if ('reason' in given) return refuse(given.reason)
      if (given.body !== null) socket.write(`${given.body}\n`)
    }

    // The connection reads nothing more until its client joined, so the lines behind the first wait in the socket
    const first = async (line: Buffer) => {
      const named = clientOf(line)
      if (named === null) return refuse('malformed')
      const got = await options.clients.join(named.client, named.name, () => socket.destroy()).catch(() => null)
      if (got === null) return refuse('token')
      if (socket.destroyed) return got.leave()
      joined = got
      joining = false
      void one(line, got.label)
      socket.resume()
      read()
    }

    // Each whole line in what came, a line past the cap refused before its end arrives
    const read = () => {
      while (!joining && !socket.destroyed) {
        const end = rest.indexOf(NEWLINE)
        if (end < 0) return void (rest.length > doorLimits.mcpBodyBytes && refuse('size'))
        if (end > doorLimits.mcpBodyBytes) return refuse('size')
        const line = rest.subarray(0, end)
        rest = rest.subarray(end + 1)
        if (!take()) return refuse('rate')
        if (joined === null) {
          joining = true
          socket.pause()
          void first(line)
          return
        }
        void one(line, joined.label)
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
    if (process.platform === 'win32' || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || await answers(at)) throw error
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
