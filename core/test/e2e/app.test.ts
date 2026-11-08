import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

const repo = path.join(import.meta.dirname, '..', '..', '..')
const electronPath = createRequire(import.meta.url)('electron') as string
// Ubuntu 24.04 keeps unprivileged user namespaces from Chromium's sandbox, so a start on Linux goes without it, as
// Playwright's own starts do there
const sandboxArgs = process.platform === 'linux' ? ['--no-sandbox'] : []
const running: ElectronApplication[] = []
const made: string[] = []
const servers: Server[] = []

afterEach(async () => {
  // Playwright refuses process() once an app was closed, and close() on a closed one only throws
  for (const app of running.splice(0)) await app.close().catch(() => {})
  for (const server of servers.splice(0)) server.close()
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-e2e-'))
  made.push(dir)
  return dir
}

function env(extra: Record<string, string>): Record<string, string> {
  const own = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  return { ...Object.fromEntries(own), ...extra }
}

// The built app from the source, as `electron .` starts it, on its own data folder
async function launch(dataDir: string): Promise<ElectronApplication> {
  const app = await electron.launch({ args: [repo], env: env({ HETU_DATA_DIR: dataDir }) })
  running.push(app)
  return app
}

const exists = (file: string) => stat(file).then(() => true, () => false)
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  for (let waited = 0; !(await check()); waited += 50) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(50)
  }
}

// The event log's whole lines, each record with its fields
async function records(dataDir: string): Promise<Record<string, unknown>[]> {
  let text = ''
  try {
    text = await readFile(path.join(dataDir, 'events', 'events-1.jsonl'), 'utf8')
  } catch {
    return []
  }
  return text.split('\n').slice(0, -1).map(line => JSON.parse(line) as Record<string, unknown>)
}

const events = async (dataDir: string) => (await records(dataDir)).map(record => record.event)

// A local server counting each request, standing in for the network
async function counting(): Promise<{ url: string, hits: () => number }> {
  let hits = 0
  const server = createServer((_request, response) => {
    hits++
    response.end('reached')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}/`, hits: () => hits }
}

function exited(app: ElectronApplication): Promise<number | null> {
  return new Promise(resolve => app.process().once('exit', code => resolve(code)))
}

describe('hetu as an Electron app', () => {
  it('boots, writes core.ready with every slot\'s state and opens the editor page', async () => {
    const dataDir = await temp()
    const app = await launch(dataDir)
    const window = await app.firstWindow()
    await window.waitForLoadState()
    expect(window.url()).toBe('hetu://editor/')
    expect(await window.textContent('body')).toContain('hetu is running')
    await until(async () => (await events(dataDir)).includes('core.ready'))
    const all = await records(dataDir)
    expect(all.map(record => record.event)).toEqual(expect.arrayContaining(['boot.default-written', 'install.checked']))
    expect(all.find(record => record.event === 'install.checked')).toMatchObject({ result: 'ok' })
    expect(all.find(record => record.event === 'core.ready')).toMatchObject({
      gate: 'absent', log: 'absent', capabilities: 'absent', watchdog: 'absent',
    })
    expect(await exists(path.join(dataDir, 'electron'))).toBe(true)
  })

  it('quits in order, leaving no lock and the shutdown records last', async () => {
    const dataDir = await temp()
    const app = await launch(dataDir)
    await app.firstWindow()
    await until(async () => (await events(dataDir)).includes('core.ready'))
    expect(await exists(path.join(dataDir, 'hetu.lock'))).toBe(true)
    const done = exited(app)
    await app.close()
    expect(await done).toBe(0)
    expect(await exists(path.join(dataDir, 'hetu.lock'))).toBe(false)
    const all = await events(dataDir)
    expect(all.indexOf('core.stopping')).toBeGreaterThan(all.indexOf('core.ready'))
    expect(all.at(-1)).toBe('core.stopping')
  })

  it('quits once the last window closes', async () => {
    const dataDir = await temp()
    const app = await launch(dataDir)
    await app.firstWindow()
    await until(async () => (await events(dataDir)).includes('core.ready'))
    const done = exited(app)
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close()
    })
    expect(await done).toBe(0)
    expect(await exists(path.join(dataDir, 'hetu.lock'))).toBe(false)
  })

  it('lets one hetu run per data folder: a second start on it quits, one on another folder runs', async () => {
    const dataDir = await temp()
    const first = await launch(dataDir)
    await first.firstWindow()
    const second = spawn(electronPath, [...sandboxArgs, repo], { env: env({ HETU_DATA_DIR: dataDir }), stdio: 'ignore' })
    const code = await new Promise<number | null>(resolve => second.once('exit', resolve))
    expect(code).toBe(0)
    expect(first.process().exitCode).toBe(null)
    expect(await first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    const other = await launch(await temp())
    expect((await other.firstWindow()).url()).toBe('hetu://editor/')
  })

  it('refuses every request from the editor\'s session but its own hosts', async () => {
    const dataDir = await temp()
    const app = await launch(dataDir)
    await app.firstWindow()
    const network = await counting()
    const file = path.join(dataDir, 'outside.html')
    await writeFile(file, '<p>outside</p>')
    const urls = [network.url, `file:///${file.split(path.sep).join('/')}`, 'hetu://trusted/', 'hetu://editor/']
    const loaded = await app.evaluate(async ({ BrowserWindow, session }, list) => {
      const window = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition('hetu-editor'), sandbox: true } })
      const out: Record<string, string> = {}
      for (const url of list) {
        try {
          await window.loadURL(url)
          out[url] = 'loaded'
        } catch (err) {
          out[url] = (err as { code?: string }).code ?? String(err)
        }
      }
      window.destroy()
      return out
    }, urls)
    expect(loaded[network.url]).toBe('ERR_BLOCKED_BY_CLIENT')
    expect(loaded[urls[1]]).toBe('ERR_BLOCKED_BY_CLIENT')
    // The filter sees hetu requests too and is what refuses another role's host, since a 404 still loads
    expect(loaded['hetu://trusted/']).toBe('ERR_BLOCKED_BY_CLIENT')
    expect(loaded['hetu://editor/']).toBe('loaded')
    expect(network.hits()).toBe(0)
  })

  it('keeps the editor page where it is and gives it no new window and no permission', async () => {
    const dataDir = await temp()
    const app = await launch(dataDir)
    const page = await app.firstWindow()
    await page.waitForLoadState()
    const network = await counting()
    await page.evaluate(url => {
      location.href = url
    }, network.url)
    expect(await page.evaluate(() => globalThis.open('hetu://editor/'))).toBe(null)
    expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied')
    const media = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (err: Error) => err.name))
    expect(media).toBe('NotAllowedError')
    await tick(300)
    expect(page.url()).toBe('hetu://editor/')
    expect(network.hits()).toBe(0)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  })
})

describe('a packaged build started for debugging', () => {
  // A probe built from the real before ready, told it is packaged. Electron prints the DevTools line once its handler
  // listens, so the exit must land before that line
  async function probe(source: string, args: string[]): Promise<{ code: number | null, stderr: string }> {
    const dir = await temp()
    const entry = path.join(dir, 'entry.ts')
    await writeFile(entry, source)
    await build({ entryPoints: [entry], outfile: path.join(dir, 'probe.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
    const child = spawn(electronPath, [...sandboxArgs, path.join(dir, 'probe.mjs'), ...args], { env: env({ LOCALAPPDATA: dir, HOME: dir, XDG_STATE_HOME: dir }) })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve))
    return { code, stderr }
  }

  const beforeReadyPath = path.join(repo, 'core', 'backend', 'runtime', 'before-ready.ts').split(path.sep).join('/')

  it('exits before Chromium opens the DevTools port', async () => {
    const { code, stderr } = await probe(`
      import { app, protocol } from 'electron'
      import { beforeReady } from '${beforeReadyPath}'
      const packaged = {
        isPackaged: true, commandLine: app.commandLine, setPath: (name, value) => app.setPath(name, value),
        requestSingleInstanceLock: () => app.requestSingleInstanceLock(), enableSandbox: () => app.enableSandbox(),
        exit: code => app.exit(code),
      }
      beforeReady(packaged, protocol, { env: process.env, platform: process.platform })
      app.whenReady().then(() => { console.error('reached ready'); app.exit(0) })
    `, ['--remote-debugging-port=0'])
    expect(code).toBe(1)
    expect(stderr).not.toContain('DevTools listening')
    expect(stderr).not.toContain('reached ready')
  })

  it('would otherwise have opened it, which the probe above can tell', async () => {
    const { stderr } = await probe(`
      import { app } from 'electron'
      app.whenReady().then(() => setTimeout(() => app.exit(0), 500))
    `, ['--remote-debugging-port=0'])
    expect(stderr).toContain('DevTools listening')
  })
})
