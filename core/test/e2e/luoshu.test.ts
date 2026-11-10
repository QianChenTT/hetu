import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { cleanup, editorPage, launch, logged, pageAt, temp, tick, until, visibleWindows } from './helpers.ts'

afterEach(cleanup)

const PAST_DELAY = 1300

type Reply = { ok: boolean, result?: unknown, refusal?: { code: string } }
let next = 9000

// A call through a page's bridge, as its own code makes one
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    const reply = message as { kind?: string, id?: number }
    if (reply.kind === 'reply' && reply.id === id) resolve(reply)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [next++, action, args] as const) as Promise<Reply>

const codeOf = (reply: Reply) => (reply.ok ? 'ok' : reply.refusal?.code)

// The paths of the luoshu events the page heard since it began listening
const listening = (page: Page) => page.evaluate(() => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  const heard: string[] = []
  ;(window as unknown as { heard: string[] }).heard = heard
  bridge.listen(message => {
    const event = message as { kind?: string, topic?: string, path?: string, seq?: number }
    if (event.kind !== 'event' || event.topic !== 'luoshu.outside') return
    heard.push(event.path ?? '')
    bridge.send({ v: 1, kind: 'ack', seq: event.seq })
  })
})
const heard = (page: Page) => page.evaluate(() => (window as unknown as { heard: string[] }).heard)

// Main's folder dialog answers with folder, since a test can't click an OS dialog
const stubDialog = (app: ElectronApplication, folder: string) => app.evaluate(({ dialog }, picked) => {
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
}, folder)

async function started(): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, notes: string }> {
  const dataDir = await temp()
  await new StateStore(dataDir).writeSwitches(defaultSwitches())
  const notes = path.join(await temp(), 'notes')
  await mkdir(path.join(notes, '.git'), { recursive: true })
  await writeFile(path.join(notes, '.git', 'config'), '[core]\n')
  await writeFile(path.join(notes, 'a.md'), 'note a')
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'luoshu' }))
  return { app, editor, dataDir, notes }
}

describe('the luoshu in the install', () => {
  it('answers unavailable until a folder is picked in the trusted window, then serves the editor and hears an outside save', async () => {
    const { app, editor, dataDir, notes } = await started()
    expect(codeOf(await ask(editor, 'luoshu.read', { path: 'a.md' }))).toBe('unavailable')

    await stubDialog(app, notes)
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const trusted = await pageAt(app, 'hetu://trusted/')
    await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
    await until(async () => (await trusted.locator('#root').innerText()).includes('Notes folder: none picked'))
    await tick(PAST_DELAY)
    await trusted.getByRole('button', { name: 'Pick a folder' }).click()
    await until(async () => (await trusted.locator('#root').innerText()).includes(`Use ${JSON.stringify(notes)} as the notes folder`))
    await tick(PAST_DELAY)
    await trusted.getByRole('button', { name: 'Confirm' }).click()
    await until(async () => (await trusted.locator('#root').innerText()).includes(`Notes folder: ${notes}`))
    expect((await new StateStore(dataDir).load()).state.luoshu).toEqual({ folder: notes })

    const read = await ask(editor, 'luoshu.read', { path: 'a.md' })
    expect(read.result).toMatchObject({ text: 'note a' })
    expect(codeOf(await ask(editor, 'luoshu.write', { path: 'journal/new.md', text: 'from the editor' }))).toBe('ok')
    expect(await readFile(path.join(notes, 'journal', 'new.md'), 'utf8')).toBe('from the editor')
    expect((await ask(editor, 'luoshu.list', {})).result).toEqual({ paths: ['a.md', 'journal/new.md'], next: null })

    await listening(editor)
    expect(codeOf(await ask(editor, 'events.subscribe', { topics: ['luoshu.outside'] }))).toBe('ok')
    await writeFile(path.join(notes, 'a.md'), 'from obsidian')
    await until(async () => (await heard(editor)).includes('a.md'))
    expect(await heard(editor)).toEqual(['a.md'])
  })

  it('refuses the spellings threat-model row 3 found', async () => {
    const { app, editor, dataDir, notes } = await started()
    await app.close()
    await new StateStore(dataDir).writeLuoshu({ folder: notes })
    const again = await launch(dataDir)
    const page = await editorPage(again)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'luoshu' }))
    void editor
    expect(codeOf(await ask(page, 'luoshu.read', { path: 'a.md' }))).toBe('ok')
    expect(codeOf(await ask(page, 'luoshu.read', { path: '.git/config' }))).toBe('not-granted')
    expect(codeOf(await ask(page, 'luoshu.read', { path: 'a.md::$DATA' }))).toBe('invalid')
    expect(codeOf(await ask(page, 'luoshu.read', { path: '.git::$INDEX_ALLOCATION/config' }))).toBe('invalid')
    expect(codeOf(await ask(page, 'luoshu.write', { path: 'journal/con.md', text: 'x' }))).toBe('invalid')
  })
})
