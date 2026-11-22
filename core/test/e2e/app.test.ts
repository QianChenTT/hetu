import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { coreModuleIds } from '../../api/ids.ts'
import {
  appCommand, cleanup, counting, editorPage, electronPath, env, events, exists, exited, launch, records, repo, sandboxArgs, temp, tick, until,
  visibleWindows,
} from './helpers.ts'

afterEach(cleanup)

describe('hetu as an Electron app', () => {
  it('boots, writes core.ready with every policy job\'s state and opens the editor page', async () => {
    const dataDir = await temp()
    const app = await launch(dataDir)
    const window = await editorPage(app)
    expect(window.url()).toBe('hetu://editor/')
    expect(await window.textContent('body')).toContain('Press Ctrl+P to open a note')
    // Sandboxed and isolated with no Node: the page sees none of Node's globals
    expect(await window.evaluate(() => [typeof globalThis.require, typeof globalThis.process, typeof globalThis.Buffer])).toEqual(['undefined', 'undefined', 'undefined'])
    await until(async () => (await events(dataDir)).includes('core.ready'))
    await until(async () => (await records(dataDir)).some(record => record.event === 'plugin.started' && record.plugin === 'layout'))
    const all = await records(dataDir)
    expect(all.map(record => record.event)).toEqual(expect.arrayContaining(['boot.default-written', 'install.checked']))
    expect(all.find(record => record.event === 'install.checked')).toMatchObject({ result: 'ok' })
    // The layout ships in the install, is copied into the plugin folder and starts. The core modules start with the core,
    // so no plugin record names one
    expect(all.find(record => record.event === 'plugin.copied')).toMatchObject({ plugin: 'layout', version: '0.1.0' })
    expect(all.filter(record => (coreModuleIds as readonly unknown[]).includes(record.plugin))).toEqual([])
    expect(all.find(record => record.event === 'core.ready')).toMatchObject({
      gate: 'on', 'grant-risk-classifier': 'on',
    })
    expect(await exists(path.join(dataDir, 'electron'))).toBe(true)
  })

  it('quits in order, leaving no lock and the shutdown records last', async () => {
    const dataDir = await temp()
    const app = await launch(dataDir)
    await editorPage(app)
    await until(async () => (await events(dataDir)).includes('core.ready'))
    expect(await exists(path.join(dataDir, 'hetu.lock'))).toBe(true)
    const done = exited(app)
    await app.close()
    expect(await done).toBe(0)
    expect(await exists(path.join(dataDir, 'hetu.lock'))).toBe(false)
    const all = await records(dataDir)
    const stopping = all.findIndex(record => record.event === 'core.stopping')
    expect(stopping).toBeGreaterThan(all.findIndex(record => record.event === 'core.ready'))
    // Only the plugins' stops follow core.stopping, then the core modules closing once every plugin stopped, in the
    // reverse of their start, with the audit records Quit's flushes write. The gate and the classifier answer to the
    // end, so no record follows for them
    const after = ['plugin.stopped', 'audit.call', 'module.state']
    const tail = all.slice(stopping + 1)
    expect(tail.map(record => record.event).filter(event => !after.includes(event as string))).toEqual([])
    expect(tail.filter(record => record.event === 'module.state')).toEqual(['heartbeat', 'exec', 'history', 'luoshu', 'storage'].map(module => expect.objectContaining({
      module, state: 'stopped', reason: 'shutdown',
    })))
    const lastStop = tail.findLastIndex(record => record.event === 'plugin.stopped')
    expect(lastStop).toBeLessThan(tail.findIndex(record => record.event === 'module.state'))
  })

  it('quits once the last window closes', async () => {
    const dataDir = await temp()
    const app = await launch(dataDir)
    await editorPage(app)
    await until(async () => (await events(dataDir)).includes('core.ready'))
    const done = exited(app)
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.isVisible()) window.close()
    })
    expect(await done).toBe(0)
    expect(await exists(path.join(dataDir, 'hetu.lock'))).toBe(false)
  })

  it('lets one hetu run per data folder: a second start on it quits, one on another folder runs', async () => {
    const dataDir = await temp()
    const first = await launch(dataDir)
    await editorPage(first)
    const second = spawn(appCommand[0], [...sandboxArgs, ...appCommand[1]], { env: env({ HETU_DATA_DIR: dataDir }), stdio: 'ignore' })
    const code = await new Promise<number | null>(resolve => second.once('exit', resolve))
    expect(code).toBe(0)
    expect(first.process().exitCode).toBe(null)
    expect(await visibleWindows(first)).toEqual(['hetu://editor/'])
    const other = await launch(await temp())
    expect((await editorPage(other)).url()).toBe('hetu://editor/')
  })

  it('refuses every request from the editor\'s session but its own hosts', async () => {
    const dataDir = await temp()
    const app = await launch(dataDir)
    await editorPage(app)
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

  // A machine with no microphone, a CI runner among them, refuses with NotFoundError before any permission is asked, so
  // Chromium's fake device stands in for one and the permission handler is what answers
  it('keeps the editor page where it is and gives it no new window and no permission', async () => {
    const dataDir = await temp()
    const app = await launch(dataDir, {}, ['--use-fake-device-for-media-stream'])
    const page = await editorPage(app)
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
    expect(await visibleWindows(app)).toEqual(['hetu://editor/'])
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
      const locked = {
        commandLine: app.commandLine, setPath: (name, value) => app.setPath(name, value),
        requestSingleInstanceLock: () => app.requestSingleInstanceLock(), enableSandbox: () => app.enableSandbox(),
        exit: code => app.exit(code),
      }
      // Its own name alone as the arguments, so only Chromium's parse of the switch can refuse it
      beforeReady(locked, protocol, { env: process.env, platform: process.platform, locked: true, argv: [process.argv[0]] })
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
