import path from 'node:path'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, dataWith, editorPage, launch, repo, until } from './helpers.ts'

afterEach(cleanup)

// The window's own caller, asked through the shell's bridge as the shell asks
const self = (page: Page) => page.evaluate(() => new Promise(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    const reply = message as { kind?: string, id?: number, result?: unknown }
    if (reply.kind === 'reply' && reply.id === 900) resolve(reply.result)
  })
  bridge.send({ v: 1, kind: 'call', id: 900, action: 'core.self', args: undefined })
}))

describe('a window\'s way in', () => {
  it('shows the banner the shell draws from core.status', async () => {
    const app = await launch(await dataWith({}))
    const page = await editorPage(app)
    await until(async () => (await page.locator('#banner li').count()) > 0)
    const lines = await page.locator('#banner li').allTextContents()
    expect(lines).toEqual(['capabilities: absent', 'watchdog: absent', 'pick a luoshu folder'])
  })

  it('gives each load of the window its own way: a reload takes the next n', async () => {
    const app = await launch(await dataWith({}))
    const page = await editorPage(app)
    expect(await self(page)).toEqual({ kind: 'window', role: 'editor', n: 1 })
    await page.reload()
    await page.waitForLoadState()
    expect(await self(page)).toEqual({ kind: 'window', role: 'editor', n: 2 })
  })

  it('answers nothing to a window the core didn\'t make, though it has the same page and preload', async () => {
    const app = await launch(await dataWith({}))
    // The control: the window the core made answers through the same bridge
    expect(await self(await editorPage(app))).toMatchObject({ kind: 'window', role: 'editor' })
    const preload = path.join(repo, 'core', 'dist', 'mount-preload.js')
    const answered = await app.evaluate(async ({ BrowserWindow, session }, mountPreload) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          session: session.fromPartition('hetu-editor'), sandbox: true, contextIsolation: true,
          preload: mountPreload,
        },
      })
      await window.loadURL('hetu://editor/')
      const got = await window.webContents.executeJavaScript(`new Promise(resolve => {
        window.hetu.listen(message => { if (message && message.id === 901) resolve(true) })
        window.hetu.send({ v: 1, kind: 'call', id: 901, action: 'core.self', args: undefined })
        setTimeout(() => resolve(false), 1000)
      })`)
      window.destroy()
      return got as boolean
    }, preload)
    expect(answered).toBe(false)
  })

  it('gives a frame inside the window no bridge of its own', async () => {
    const app = await launch(await dataWith({}))
    const page = await editorPage(app)
    const inFrame = await page.evaluate(() => new Promise(resolve => {
      const frame = document.createElement('iframe')
      frame.src = 'about:blank'
      frame.onload = () => resolve(typeof (frame.contentWindow as unknown as { hetu?: unknown }).hetu)
      document.body.append(frame)
    }))
    expect(inFrame).toBe('undefined')
  })
})
