import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { FetchRefused, getFromGitHub, type Fetch } from '../backend/lib/github.ts'

// Node's own fetch against a server on loopback, so decoding and sockets are Node's as in main. The fetch handed in
// sends each GitHub URL to the server instead, with the request as built

type Served = { fetch: Fetch, closed: () => Promise<void> }

let server: Server | null = null
const sockets: Socket[] = []

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.length = 0
  await new Promise(resolve => server === null ? resolve(undefined) : server.close(resolve))
  server = null
})

async function serve(handle: (request: IncomingMessage, response: ServerResponse) => void): Promise<Served> {
  const made = createServer(handle)
  server = made
  made.on('connection', socket => sockets.push(socket))
  await new Promise<void>(resolve => made.listen(0, '127.0.0.1', resolve))
  const { port } = made.address() as AddressInfo
  const fetch: Fetch = (url, init) => globalThis.fetch(url.replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), init)
  // Resolves once every socket the server took has closed, or fails the test after two seconds
  const closed = () => Promise.race([
    Promise.all(sockets.map(socket => socket.destroyed ? undefined : new Promise(resolve => socket.once('close', resolve)))).then(() => undefined),
    new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('a socket stayed open')), 2000)),
  ])
  return { fetch, closed }
}

const ASSET = 'https://github.com/o/r/releases/download/v1/a.zip'
const want = { accept: 'application/octet-stream' }

async function problemOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (err) {
    if (err instanceof FetchRefused) return err.problem
    throw err
  }
  return 'none'
}

describe('a body read through Node\'s fetch', () => {
  it('is counted as decoded, so a gzip answer past the cap is refused though its Content-Length is small', async () => {
    const plain = Buffer.alloc(100_000)
    const packed = gzipSync(plain)
    expect(packed.length).toBeLessThan(1000)
    const { fetch } = await serve((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(packed.length) })
      response.end(packed)
    })
    expect(await problemOf(getFromGitHub(ASSET, want, { bytes: 50_000, ms: 5000 }, { fetch }))).toBe('too-big')
    expect((await getFromGitHub(ASSET, want, { bytes: 100_000, ms: 5000 }, { fetch })).equals(plain)).toBe(true)
  })

  it('frees its socket once refused past the cap mid-body', async () => {
    const { fetch, closed } = await serve((_request, response) => {
      response.writeHead(200)
      const chunk = Buffer.alloc(16 * 1024)
      const pump = setInterval(() => response.write(chunk), 5)
      response.on('close', () => clearInterval(pump))
    })
    expect(await problemOf(getFromGitHub(ASSET, want, { bytes: 100_000, ms: 5000 }, { fetch }))).toBe('too-big')
    await closed()
  })

  it('frees its socket once past its time limit mid-body', async () => {
    const { fetch, closed } = await serve((_request, response) => {
      response.writeHead(200)
      response.write(Buffer.alloc(10))
    })
    expect(await problemOf(getFromGitHub(ASSET, want, { bytes: 100_000, ms: 100 }, { fetch }))).toBe('timed-out')
    await closed()
  })
})
