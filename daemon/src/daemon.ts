import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node'
import { VaultCore } from './core.ts'
import { callContext, EventLog } from './log.ts'
import { buildServer } from './mcp.ts'
import { handleApi } from './api.ts'
import { watchVault } from './watcher.ts'

export type DaemonOptions = {
  vault: string
  token: string
  port?: number
  humanDebounceMs?: number
  leaseTtlSeconds?: number
  events?: EventLog
}

export type Daemon = { core: VaultCore; url: string; close: () => Promise<void> }

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`)
  const given = Buffer.from(header ?? '')
  // Constant-time compare so response timing doesn't leak how much of the token was right
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// What a refused request looked like. Never the Authorization header itself
function describe(req: IncomingMessage) {
  return {
    method: req.method,
    path: req.url,
    host: req.headers.host,
    origin: req.headers.origin,
    ua: req.headers['user-agent'],
    remote: req.socket.remoteAddress,
    auth: req.headers.authorization ? 'present' : 'none',
  }
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const events = options.events ?? new EventLog({ console: true })
  const core = new VaultCore({ root: options.vault, leaseTtlSeconds: options.leaseTtlSeconds, events })
  await core.start()
  const watcher = watchVault(core, options.humanDebounceMs ?? 2000)

  const handler = createMcpHandler(
    ctx => {
      // The SDK says which protocol era the request speaks: legacy (2025 handshake) or modern (2026-07-28)
      const store = callContext.getStore()
      if (store) store.era = ctx.era
      return buildServer(core)
    },
    { onerror: err => events.emit('mcp.error', { error: err.message }, 'error') },
  )
  const mcp = toNodeHandler(handler, { onerror: err => events.emit('mcp.error', { error: err.message }, 'error') })
  // Host blocks DNS rebinding (a web page whose domain resolves to 127.0.0.1). Origin blocks browser pages calling in directly
  const validateHost = localhostHostValidation()
  const validateOrigin = localhostOriginValidation()

  const server: Server = createServer((req, res) => {
    const reject = (reason: string) => events.emit('http.rejected', { reason, ...describe(req) }, 'warn')
    if (!validateHost(req, res)) return reject('host')
    if (!validateOrigin(req, res)) return reject('origin')
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const isMcp = pathname === '/mcp'
    const isApi = pathname.startsWith('/api/')
    if (!isMcp && !isApi) {
      res.writeHead(404).end()
      return reject('path')
    }
    if (!tokenMatches(req.headers.authorization, options.token)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing or wrong bearer token' }))
      return reject('token')
    }
    // Every event this request causes carries the same req id
    callContext.run({ req: randomBytes(4).toString('hex'), ua: req.headers['user-agent'] }, () =>
      isMcp ? void mcp(req, res) : void handleApi(core, req, res, pathname),
    )
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Loopback only, never reachable from the network
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}/mcp`
  events.emit('daemon.started', { vault: core.root, url, pid: process.pid, log: events.file() })

  return {
    core,
    url,
    close: async () => {
      events.emit('daemon.stopping', { open_leases: core.openLeases })
      await watcher.close()
      await core.stop()
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
