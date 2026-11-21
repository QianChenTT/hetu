import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, writeSync } from 'node:fs'
import net from 'node:net'
import { userInfo } from 'node:os'
import path from 'node:path'
import type { Duplex, Readable, Writable } from 'node:stream'
import { pipeName } from '../../api/pipe.ts'
import { baseEnv, setVariable } from '../../lib/clean-env.ts'

// hetu.exe --mcp-stdio, the shim: a program on this computer that speaks MCP over stdio starts hetu with this one switch
// and gets its stdin and stdout relayed to the local pipe mcp-http-handler serves. It is Electron's main with no window,
// no single-instance lock, no boot and no event log. stdout carries only what came back over the pipe and anything the
// shim has to say goes to stderr, never to a dialog. Electron's own process.stdin reads as ended at once on Windows, so
// stdin is read from fd 0 itself

export const SHIM_SWITCH = '--mcp-stdio'

// How long the shim waits for the pipe after it started hetu
export const PIPE_WAIT_MS = 30_000
const RETRY_MS = 250

// How long the pipe stays open after stdin ended for the answers still owed, the time the door gives a request
export const ANSWER_WAIT_MS = 35_000

// A line past the handler's largest answer is relayed but never read for its id
const SCAN_BYTES = 4 * 1024 * 1024
const NEWLINE = 0x0a

// A locked build is the shim only with exactly the switch after its name. A run from the source has the repo and maybe
// Chromium's switches beside it
export function shimArgv(argv: readonly string[], locked: boolean): boolean {
  return locked ? argv.length === 2 && argv[1] === SHIM_SWITCH : argv.slice(1).includes(SHIM_SWITCH)
}

// What hetu itself starts with when the shim starts it: nothing in a locked build, the repo in a run from the source
export const hetuArgv = (argv: readonly string[]) => argv.slice(1).filter(arg => arg !== SHIM_SWITCH)

// How the shim starts hetu: the executable it runs as, its arguments less the switch and an environment built from
// empty, since the shim's own is whatever the client's config chose. Kept from it are only the names Windows starts no
// process without, which libuv would carry over anyway (baseEnv): who the user is, where Windows is and a PATH of
// System32 alone, so no program hetu runs is found through the client's PATH. The folder hetu keeps its state under
// comes from the account's own home, never from LOCALAPPDATA, HOME or XDG_STATE_HOME as the client set them. Nothing
// else of hetu's own is passed, HETU_DATA_DIR and HETU_INSTALL_DIR among it
export function hetuStart(options: {
  execPath: string
  argv: readonly string[]
  ambient: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  home: string
}): { command: string, args: string[], env: Record<string, string> } {
  const env: Record<string, string> = { ...baseEnv(options.ambient, options.platform) }
  if (options.platform === 'win32') {
    setVariable(env, 'USERPROFILE', options.home, options.platform)
    setVariable(env, 'LOCALAPPDATA', path.win32.join(options.home, 'AppData', 'Local'), options.platform)
  } else {
    env.HOME = options.home
  }
  return { command: options.execPath, args: hetuArgv(options.argv), env }
}

export type Reach = {
  // Rejects when nothing serves the pipe
  connect(): Promise<Duplex>
  start(): void
  now(): number
  wait(ms: number): Promise<void>
}

// The pipe of a running hetu. With none, hetu is started once and the pipe tried until 30 s later. null when it never
// came
export async function reachPipe(reach: Reach): Promise<Duplex | null> {
  const tried = () => reach.connect().catch(() => null)
  const first = await tried()
  if (first !== null) return first
  reach.start()
  const deadline = reach.now() + PIPE_WAIT_MS
  while (reach.now() < deadline) {
    await reach.wait(Math.min(RETRY_MS, deadline - reach.now()))
    const pipe = await tried()
    if (pipe !== null) return pipe
  }
  return null
}

// Hands each whole line of what comes to onLine, a line past the cap passed over
function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let rest: Buffer[] = []
  let size = 0
  let over = false
  return chunk => {
    let from = 0
    for (let end = chunk.indexOf(NEWLINE); end >= 0; end = chunk.indexOf(NEWLINE, from)) {
      if (!over && size + end - from <= SCAN_BYTES) onLine(Buffer.concat([...rest, chunk.subarray(from, end)]).toString('utf8'))
      rest = []
      size = 0
      over = false
      from = end + 1
    }
    const tail = chunk.subarray(from)
    size += tail.length
    over ||= size > SCAN_BYTES
    if (over) rest = []
    else if (tail.length > 0) rest.push(tail)
  }
}

// The ids of a line's requests, or with requests false of its answers, a batch's included. An id is a string or a
// number and the two never match
function idsOf(line: string, requests: boolean): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return []
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap(message => {
    if (message === null || typeof message !== 'object') return []
    const { id } = message as { id?: unknown }
    if ((typeof id !== 'string' && typeof id !== 'number') || ('method' in message) !== requests) return []
    return [JSON.stringify(id)]
  })
}

export type RelayParts = { input: Readable, output: Writable, pipe: Duplex, errors: (line: string) => void, answerWaitMs?: number }

// Relays stdin to the pipe and the pipe to stdout until one ends, then gives the exit code once stdout is flushed: 0
// when stdin ended with every answer back, 1 when stdin failed, an answer never came or the pipe or stdout went first.
// A Windows pipe breaks outright on a half-close and the handler cancels the calls of a connection that closed, so
// after stdin ends the pipe stays open whole until what was written went out and each request passed on was answered,
// at the latest the answer wait later
export function relay(parts: RelayParts): Promise<number> {
  const { input, output, pipe, errors } = parts
  const owed = new Set<string>()
  let writing = 0
  let ended = false
  let failed = false
  let told = false
  let cap: NodeJS.Timeout | undefined

  const settle = () => {
    if (ended && writing === 0 && owed.size === 0) pipe.destroy()
  }
  const fromInput = lines(line => { for (const id of idsOf(line, true)) owed.add(id) })
  const fromPipe = lines(line => { for (const id of idsOf(line, false)) owed.delete(id) })

  input.on('data', (chunk: Buffer) => {
    fromInput(chunk)
    writing++
    const room = pipe.write(chunk, () => {
      writing--
      settle()
    })
    if (!room) input.pause()
  })
  pipe.on('drain', () => input.resume())
  const end = () => {
    if (ended) return
    ended = true
    cap = setTimeout(() => {
      errors(`closed the pipe with ${answersOwed()}`)
      told = true
      pipe.destroy()
    }, parts.answerWaitMs ?? ANSWER_WAIT_MS)
    cap.unref()
    settle()
  }
  const answersOwed = () => `${owed.size} answer${owed.size === 1 ? '' : 's'} owed`
  input.once('end', end)
  input.once('error', error => {
    errors(`stdin failed: ${error.message}`)
    failed = true
    end()
  })

  pipe.on('data', (chunk: Buffer) => {
    if (!output.write(chunk)) pipe.pause()
    fromPipe(chunk)
    settle()
  })
  output.on('drain', () => pipe.resume())
  output.on('error', error => {
    errors(`stdout failed: ${error.message}`)
    told = true
    pipe.destroy()
  })
  pipe.on('error', error => {
    if (ended) return
    errors(`the pipe failed: ${error.message}`)
    told = true
  })

  return new Promise(resolve => {
    pipe.once('close', () => {
      clearTimeout(cap)
      input.pause()
      if (!ended && !told) errors('hetu closed the connection')
      else if (owed.size > 0 && !told) errors(`hetu closed the connection with ${answersOwed()}`)
      const code = ended && !failed && owed.size === 0 ? 0 : 1
      if (output.destroyed) resolve(code)
      else output.end(() => resolve(code))
    })
  })
}

// One line on stderr, the shim's only voice besides the relay
export function shimError(line: string): void {
  try {
    writeSync(2, `hetu --mcp-stdio: ${line}\n`)
  } catch {
    // stderr is gone as well
  }
}

const connect = (at: string) => new Promise<Duplex>((resolve, reject) => {
  const socket = net.connect(at)
  socket.once('error', reject)
  socket.once('connect', () => {
    socket.off('error', reject)
    resolve(socket)
  })
})

// The shim in Electron's main, once it is ready: the pipe reached, the relay run and the process ended with its code.
// An error anywhere ends it on stderr, where Electron would show a dialog for one in main
export function runShim(app: { whenReady(): Promise<unknown>, exit(code: number): void }): void {
  const failed = (error: unknown) => {
    shimError(error instanceof Error ? error.message : String(error))
    app.exit(1)
  }
  process.on('uncaughtException', failed)
  process.on('unhandledRejection', failed)
  const at = pipeName(process.platform, userInfo().username)
  const reach: Reach = {
    connect: () => connect(at),
    // hetu on its own, holding none of the shim's stdio, so the client's pipes end with the shim
    start: () => {
      const { command, args, env } = hetuStart({ execPath: process.execPath, argv: process.argv, ambient: process.env, platform: process.platform, home: userInfo().homedir })
      const hetu = spawn(command, args, { env, detached: true, stdio: 'ignore' })
      hetu.once('error', error => shimError(`could not start hetu: ${error.message}`))
      hetu.unref()
    },
    now: Date.now,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
  void app.whenReady().then(async () => {
    const pipe = await reachPipe(reach)
    if (pipe === null) {
      shimError(`no hetu answered on ${at} within ${PIPE_WAIT_MS / 1000} s`)
      return app.exit(1)
    }
    const input = createReadStream(null as never, { fd: 0, autoClose: false })
    const output = createWriteStream(null as never, { fd: 1, autoClose: false })
    app.exit(await relay({ input, output, pipe, errors: shimError }))
  }).catch(failed)
}
