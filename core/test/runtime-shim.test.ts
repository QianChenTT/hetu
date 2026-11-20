import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { hetuArgv, reachPipe, relay, shimArgv } from '../backend/runtime/shim.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the shim\'s arguments', () => {
  it('are exactly --mcp-stdio after the name in a locked build', () => {
    expect(shimArgv(['hetu.exe', '--mcp-stdio'], true)).toBe(true)
    expect(shimArgv(['hetu.exe'], true)).toBe(false)
    expect(shimArgv(['hetu.exe', '--mcp-stdio', '--inspect'], true)).toBe(false)
    expect(shimArgv(['hetu.exe', '--inspect', '--mcp-stdio'], true)).toBe(false)
    expect(shimArgv(['hetu.exe', '--mcp-stdio=1'], true)).toBe(false)
    expect(shimArgv(['--mcp-stdio'], true)).toBe(false)
  })

  it('hold --mcp-stdio anywhere after the name in a run from the source, the repo and Chromium\'s switches beside it', () => {
    expect(shimArgv(['electron', '.', '--mcp-stdio'], false)).toBe(true)
    expect(shimArgv(['electron', '--no-sandbox', 'C:\\hetu', '--mcp-stdio'], false)).toBe(true)
    expect(shimArgv(['electron', '.'], false)).toBe(false)
    expect(shimArgv(['--mcp-stdio'], false)).toBe(false)
  })

  it('start hetu itself with nothing in a locked build and with the repo in a run from the source', () => {
    expect(hetuArgv(['hetu.exe', '--mcp-stdio'])).toEqual([])
    expect(hetuArgv(['electron', '--no-sandbox', 'C:\\hetu', '--mcp-stdio'])).toEqual(['--no-sandbox', 'C:\\hetu'])
  })
})

// A pipe that is there once tries reaches some number, on a clock each wait moves
function reaching(answersFrom: number) {
  let tries = 0
  let starts = 0
  let time = 0
  const waits: number[] = []
  const pipe = new PassThrough()
  const reach = {
    connect: () => (++tries >= answersFrom ? Promise.resolve(pipe) : Promise.reject(Object.assign(new Error('no pipe'), { code: 'ENOENT' }))),
    start: () => { starts++ },
    now: () => time,
    wait: (ms: number) => { waits.push(ms); time += ms; return Promise.resolve() },
  }
  return { reach, pipe, tries: () => tries, starts: () => starts, waits }
}

describe('reaching the pipe', () => {
  it('takes a running hetu\'s pipe and starts nothing', async () => {
    const { reach, pipe, starts } = reaching(1)
    expect(await reachPipe(reach)).toBe(pipe)
    expect(starts()).toBe(0)
  })

  it('starts hetu once with no pipe and takes the pipe when it comes', async () => {
    const { reach, pipe, starts, tries } = reaching(5)
    expect(await reachPipe(reach)).toBe(pipe)
    expect(starts()).toBe(1)
    expect(tries()).toBe(5)
  })

  it('gives up 30 s after it started hetu with no pipe come', async () => {
    const { reach, starts, waits } = reaching(Infinity)
    expect(await reachPipe(reach)).toBeNull()
    expect(starts()).toBe(1)
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(30_000)
  })
})

// The pipe as the shim holds it: what was written, whether it was half-closed or destroyed, the handler's lines
// pushed back. held keeps each write's callback until flush, as a pipe whose buffer hasn't gone out yet
function fakePipe(options: { held?: boolean } = {}) {
  const written: string[] = []
  const owed: (() => void)[] = []
  let halfClosed = false
  const pipe = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString('utf8'))
      if (options.held === true) owed.push(() => done())
      else done()
    },
    final(done) {
      halfClosed = true
      done()
    },
  })
  return {
    pipe,
    written: () => written.join(''),
    flush: () => { for (const done of owed.splice(0)) done() },
    halfClosed: () => halfClosed,
    answer: (line: string) => pipe.push(`${line}\n`),
  }
}

function relayed(options: { held?: boolean, answerWaitMs?: number } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  let out = ''
  output.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
  const errors: string[] = []
  const fake = fakePipe(options)
  const code = relay({ input, output, pipe: fake.pipe, errors: line => errors.push(line), answerWaitMs: options.answerWaitMs })
  let done: number | null = null
  void code.then(value => { done = value })
  return { input, out: () => out, errors, ...fake, code, done: () => done, outputEnded: () => output.writableEnded }
}

const request = (id: unknown, method = 'tools/list') => JSON.stringify({ jsonrpc: '2.0', id, method })
const notification = (method = 'notifications/initialized') => JSON.stringify({ jsonrpc: '2.0', method })
const result = (id: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result: {} })

describe('the relay', () => {
  it('passes stdin to the pipe and the pipe to stdout as they came, nothing else on stdout', async () => {
    const shim = relayed()
    shim.input.write(`${request(1)}\n${notification()}\n`)
    shim.input.write(`${request(2).slice(0, 5)}`)
    shim.input.write(`${request(2).slice(5)}\n`)
    shim.answer(result(1))
    await tick()
    expect(shim.written()).toBe(`${request(1)}\n${notification()}\n${request(2)}\n`)
    expect(shim.out()).toBe(`${result(1)}\n`)
    expect(shim.errors).toEqual([])
  })

  it('closes the pipe whole once stdin ends with nothing owed, never half-closing it and exits 0', async () => {
    const shim = relayed()
    shim.input.write(`${notification()}\n`)
    shim.input.end()
    expect(await shim.code).toBe(0)
    expect(shim.pipe.destroyed).toBe(true)
    expect(shim.halfClosed()).toBe(false)
    expect(shim.outputEnded()).toBe(true)
    expect(shim.errors).toEqual([])
  })

  // A Windows pipe breaks outright on a half-close and the handler cancels the calls of a closed connection
  it('keeps the pipe open after stdin ends until the answer to each request it passed on came back', async () => {
    const shim = relayed()
    shim.input.write(`${request(1)}\n${request('1')}\n${notification()}\n`)
    shim.input.end()
    await tick()
    expect(shim.pipe.destroyed).toBe(false)
    shim.answer(result(1))
    await tick()
    // The string id is another request than the number
    expect(shim.pipe.destroyed).toBe(false)
    shim.answer(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32000, message: 'throttled' } }))
    expect(await shim.code).toBe(0)
    expect(shim.out()).toBe(`${result(1)}\n${JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32000, message: 'throttled' } })}\n`)
    expect(shim.halfClosed()).toBe(false)
  })

  it('owes nothing for a request hetu sent, which stdin answers', async () => {
    const shim = relayed()
    shim.answer(request(7, 'roots/list'))
    await tick()
    shim.input.write(`${result(7)}\n`)
    shim.input.end()
    expect(await shim.code).toBe(0)
  })

  it('reads the ids of a batch', async () => {
    const shim = relayed()
    shim.input.write(`[${request(1)},${notification()},${request(2)}]\n`)
    shim.input.end()
    shim.answer(`[${result(1)}]`)
    await tick()
    expect(shim.pipe.destroyed).toBe(false)
    shim.answer(result(2))
    expect(await shim.code).toBe(0)
  })

  it('waits for what it wrote to go out before it closes the pipe', async () => {
    const shim = relayed({ held: true })
    shim.input.write(`${notification()}\n`)
    shim.input.end()
    await tick()
    expect(shim.pipe.destroyed).toBe(false)
    shim.flush()
    expect(await shim.code).toBe(0)
    expect(shim.written()).toBe(`${notification()}\n`)
  })

  it('closes the pipe past the wait with answers still owed, saying so on stderr and exits 0', async () => {
    const shim = relayed({ answerWaitMs: 20 })
    shim.input.write(`${request(1)}\n`)
    shim.input.end()
    await tick()
    expect(shim.pipe.destroyed).toBe(false)
    expect(await shim.code).toBe(0)
    expect(shim.pipe.destroyed).toBe(true)
    expect(shim.errors).toEqual(['closed the pipe with 1 answer owed'])
    expect(shim.out()).toBe('')
  })

  it('exits 1 with a line on stderr and nothing on stdout when hetu closes the pipe first', async () => {
    const shim = relayed()
    shim.input.write(`${request(1)}\n`)
    await tick()
    shim.pipe.destroy()
    expect(await shim.code).toBe(1)
    expect(shim.errors).toEqual(['hetu closed the connection'])
    expect(shim.out()).toBe('')
    expect(shim.outputEnded()).toBe(true)
  })

  it('exits 1 naming the error when the pipe fails', async () => {
    const shim = relayed()
    shim.pipe.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    expect(await shim.code).toBe(1)
    expect(shim.errors).toEqual(['the pipe failed: read ECONNRESET'])
  })
})
