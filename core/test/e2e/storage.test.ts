import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore, type Switches } from '../../backend/boot/state.ts'
import { cleanup, editorPage, launch, logged, pageAt, temp, tick, until, visibleWindows } from './helpers.ts'

afterEach(cleanup)

type Reply = { ok: boolean, result?: unknown, refusal?: { code: string } }
let next = 7000

// A call through a page's bridge, as its own code makes one
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    const reply = message as { kind?: string, id?: number }
    if (reply.kind === 'reply' && reply.id === id) resolve(reply)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [next++, action, args] as const) as Promise<Reply>

async function data(switches: Partial<Switches> = {}): Promise<string> {
  const dataDir = await temp()
  await new StateStore(dataDir).writeSwitches({ ...defaultSwitches(), ...switches })
  return dataDir
}

// The built install, with storage among its host halves, up and the editor's page open
async function started(dataDir: string, storage: 'on' | 'off' = 'on'): Promise<{ app: ElectronApplication, page: Page }> {
  const app = await launch(dataDir)
  const page = await editorPage(app)
  await until(() => logged(dataDir, 'core.ready'))
  if (storage === 'on') await until(() => logged(dataDir, 'plugin.started', { plugin: 'storage' }))
  return { app, page }
}

const favorites = path.join('storage', 'window.editor', 'key-favorites')

describe('the storage plugin in the install', () => {
  it('keeps the editor window\'s value in its own space across a restart, under its hash line', async () => {
    const dataDir = await data()
    const first = await started(dataDir)
    expect(await ask(first.page, 'storage.set', { key: 'favorites', value: ['search/results'] })).toMatchObject({ ok: true, result: null })
    expect((await ask(first.page, 'storage.get', { key: 'favorites' })).result).toEqual(['search/results'])
    await first.app.close()
    const [line, hash] = (await readFile(path.join(dataDir, favorites), 'utf8')).split('\n')
    expect(JSON.parse(line)).toEqual({ key: 'favorites', value: ['search/results'] })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)

    const second = await started(dataDir)
    expect((await ask(second.page, 'storage.get', { key: 'favorites' })).result).toEqual(['search/results'])
  })

  it('answers tampered for a key edited while hetu was closed and writes storage.tampered', async () => {
    const dataDir = await data()
    const first = await started(dataDir)
    await ask(first.page, 'storage.set', { key: 'favorites', value: ['search/results'] })
    await first.app.close()
    const file = path.join(dataDir, favorites)
    await writeFile(file, (await readFile(file, 'utf8')).replace('search/results', 'evil/view'))

    const second = await started(dataDir)
    expect((await ask(second.page, 'storage.get', { key: 'favorites' })).refusal).toEqual({ code: 'tampered', action: 'storage.get' })
    await until(() => logged(dataDir, 'storage.tampered', { space: 'window.editor', key: 'favorites' }))
    // The window decides: a set puts a good value back
    expect((await ask(second.page, 'storage.set', { key: 'favorites', value: [] })).ok).toBe(true)
    expect((await ask(second.page, 'storage.get', { key: 'favorites' })).result).toEqual([])
  })

  it('answers unavailable with storage switched off, and hetu runs on without it', async () => {
    const dataDir = await data({ off: ['storage'] })
    const { page } = await started(dataDir, 'off')
    expect((await ask(page, 'storage.get', { key: 'favorites' })).refusal?.code).toBe('unavailable')
    expect((await ask(page, 'cache.set', { key: 'k', value: 1 })).refusal?.code).toBe('unavailable')
    expect(await ask(page, 'log.verify')).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('gives the trusted window no space at all', async () => {
    const dataDir = await data()
    const { app, page } = await started(dataDir)
    await ask(page, 'security.open')
    const trusted = await pageAt(app, 'hetu://trusted/')
    await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
    // Past the input delay, so the refusal is the floor's and not the delay's
    await tick(1300)
    expect((await ask(trusted, 'storage.get', { key: 'favorites' })).refusal?.code).toBe('not-granted')
    expect((await ask(trusted, 'cache.get', { key: 'favorites' })).refusal?.code).toBe('not-granted')
  })
})
