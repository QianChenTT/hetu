import { execFileSync } from 'node:child_process'
import { cp, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { INSTALL_LIST } from '../../api/install.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { firstPartyEntry, hashOf } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, exists, launch, logged, pageAt, records, repo, temp, tick, until, visibleWindows } from './helpers.ts'

afterEach(cleanup)

// The file explorer as the install carries it: first-party, built from the community package at its pinned commit

// The input delay and a little more, so a click after it lands
const PAST_DELAY = 1300
const ID = 'file-explorer'
const listAll: Capability = { type: 'luoshu.list', paths: ['**'] }
const readAll: Capability = { type: 'luoshu.read', paths: ['**'] }
const writeAll: Capability = { type: 'luoshu.write', paths: ['**'] }
const rest: Capability[] = [{ type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] }, { type: 'ui.view' }, { type: 'storage' }]

type Setup = { notes: Record<string, string>, granted?: Capability[] }

// A notes folder and a data folder. granted seeds the explorer's entry as a human who narrowed it leaves it: the
// install's own copy in the plugin folder and the entry naming what it may use. Without it the first start copies the
// explorer in with its manifest's grant
async function started(setup: Setup): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, folder: string }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(setup.notes)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true })
    await writeFile(path.join(folder, name), text)
  }
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder })
  if (setup.granted !== undefined) {
    const install = path.join(repo, 'core', 'dist')
    const listed = (JSON.parse(await readFile(path.join(install, INSTALL_LIST), 'utf8')) as { plugins: Record<string, { version: string, hash: string }> }).plugins[ID]!
    const root = path.join(dataDir, 'plugins', ID)
    await cp(path.join(install, 'plugins', ID), root, { recursive: true })
    expect(await hashOf(root)).toBe(listed.hash)
    await store.writePlugin(ID, firstPartyEntry(listed.hash, { version: listed.version, granted: setup.granted }))
  }
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: ID }))
  return { app, editor, dataDir, folder }
}

// The explorer's view: the one surface holding a list, which no other view here draws. Its New note button gives way
// to an input while a name is typed
const explorer = (editor: Page) => editor.locator('#editors .hetu-surface', { has: editor.locator('.hetu-list') })
const row = (view: Locator, text: string) => view.getByRole('button', { name: text, exact: true })
const status = (view: Locator) => view.innerText()
const shown = (editor: Page) => editor.locator('.editor:not([hidden]) .cm-content')

async function openFolder(view: Locator, name: string): Promise<void> {
  await row(view, `▸ ${name}`).click()
  await row(view, `▾ ${name}`).waitFor()
}

// Types a path into the explorer's input and presses Enter there
async function typed(view: Locator, value: string): Promise<void> {
  const input = view.locator('input')
  await input.fill(value)
  await input.press('Enter')
}

async function deleted(view: Locator, name: string): Promise<void> {
  await row(view, name).click()
  await row(view, 'Delete').click()
  await until(async () => (await view.page().locator('body').innerText()).includes(`Move ${name} to the recycle bin?`))
  await view.page().getByRole('button', { name: 'Move to recycle bin', exact: true }).click()
}

// The luoshu.read calls the explorer's worker made, from the audit records, each record counting the calls it stands for
async function readsBy(dataDir: string): Promise<number> {
  const audit = (await records(dataDir)).filter(record => record.event === 'audit.call' && record.action === 'luoshu.read'
    && typeof record.caller === 'string' && record.caller.startsWith(`${ID}/`))
  return audit.reduce((sum, record) => sum + (typeof record.count === 'number' ? record.count : 1), 0)
}

const files = async (folder: string) => (await readdir(folder, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => path.relative(folder, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()

// Puts back what the Windows recycle bin holds from folder, so no run leaves its notes there. Read through the shell's
// own view of the bin, which names each item's original folder
async function putBack(folder: string): Promise<void> {
  if (process.platform !== 'win32') return
  const from = await realpath(folder)
  const script = [
    '$bin = (New-Object -ComObject Shell.Application).NameSpace(10)',
    `$from = '${from.replace(/'/g, "''")}'`,
    "$bin.Items() | Where-Object { $bin.GetDetailsOf($_, 1) -eq $from } | ForEach-Object { $_.InvokeVerb('undelete') }",
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
}

describe('the file explorer, a first-party plugin from the community package', () => {
  it('starts with its whole grant at class 4, lists, opens and asks once in the trusted window before its first write', async () => {
    const notes = { 'a.md': 'alpha', 'inbox/b.md': 'beta', 'notes/deep/d.md': 'delta', 'other.txt': 'not a note' }
    const { app, editor, dataDir, folder } = await started({ notes })
    try {
      expect(await logged(dataDir, 'plugin.copied', { plugin: ID, version: '0.1.0' })).toBe(true)
      const entry = (await new StateStore(dataDir).load()).state.plugins[ID]
      expect(entry).toMatchObject({ signer: 'hetu first-party', class: 4, granted: [listAll, readAll, writeAll, ...rest], firstUse: [writeAll] })
      const view = explorer(editor)
      await view.waitFor()

      // Every name: the folders closed at first, then opened. A file that isn't a note isn't shown
      await row(view, 'a').waitFor()
      await openFolder(view, 'inbox')
      await openFolder(view, 'notes')
      await openFolder(view, 'deep')
      for (const name of ['a', 'b', 'd']) expect(await row(view, name).isVisible(), name).toBe(true)
      expect(await row(view, 'other.txt').count()).toBe(0)

      // Open: a click on a note shows it in the editor
      await row(view, 'a').click()
      await until(async () => (await shown(editor).innerText()) === 'alpha')

      // Create: the first write asks, writes nothing before the Confirm and answers needs-confirm
      await row(view, 'New note').click()
      await typed(view, 'inbox/new')
      await until(async () => (await status(view)).includes('Can’t create inbox/new.md: needs-confirm'))
      expect(await exists(path.join(folder, 'inbox', 'new.md'))).toBe(false)
      const notice = editor.getByRole('button', { name: `The plugin "${ID}" asks to use something for the first time` })
      await notice.waitFor()
      await tick(PAST_DELAY)
      await notice.click()
      const page = await pageAt(app, 'hetu://trusted/')
      await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
      await until(async () => (await page.locator('#root').innerText()).includes(`Let ${ID} use luoshu.write on "**"`))
      expect(await exists(path.join(folder, 'inbox', 'new.md'))).toBe(false)
      await tick(PAST_DELAY)
      await page.getByRole('button', { name: 'Confirm' }).click()
      await until(() => logged(dataDir, 'security.applied', { kind: 'item.on', target: ID }))
      expect((await new StateStore(dataDir).load()).state.plugins[ID]?.firstUse).toEqual([])
      expect(await exists(path.join(folder, 'inbox', 'new.md'))).toBe(false)
      // The same Enter again, now the item is on
      await view.locator('input').press('Enter')
      await until(() => exists(path.join(folder, 'inbox', 'new.md')))
      expect(await readFile(path.join(folder, 'inbox', 'new.md'), 'utf8')).toBe('')
      await row(view, 'new').waitFor()

      // Rename into another folder by typing its path
      await row(view, 'new').click()
      await row(view, 'Rename').click()
      await typed(view, 'notes/renamed')
      await until(() => exists(path.join(folder, 'notes', 'renamed.md')))
      expect(await exists(path.join(folder, 'inbox', 'new.md'))).toBe(false)
      await row(view, 'renamed').waitFor()

      // Delete, asked in the view
      await deleted(view, 'b')
      await until(async () => !(await exists(path.join(folder, 'inbox', 'b.md'))))
      await until(async () => (await row(view, 'b').count()) === 0)
      expect(await files(folder)).toEqual(['a.md', 'notes/deep/d.md', 'notes/renamed.md', 'other.txt'])

      // One read for the one delete and none on listing, opening, creating or renaming
      await until(async () => (await readsBy(dataDir)) === 1)
      await tick(1500)
      expect(await readsBy(dataDir)).toBe(1)
      // Asked once only
      expect((await records(dataDir)).filter(record => record.event === 'security.applied' && record.kind === 'item.on' && record.target === ID)).toHaveLength(1)
    } finally {
      await putBack(folder)
    }
  })

  // The proof: its write narrowed to inbox/** by the human. It still lists every name and opens any note. It moves
  // and removes only inside inbox/
  it('lists every name and opens any note with its write narrowed to inbox/** and renames and deletes only inside inbox/', async () => {
    const notes = { 'a.md': 'alpha', 'inbox/b.md': 'beta', 'inbox/c.md': 'gamma', 'notes/d.md': 'delta' }
    const narrowed: Capability = { type: 'luoshu.write', paths: ['inbox/**'] }
    const { editor, dataDir, folder } = await started({ notes, granted: [listAll, readAll, narrowed, ...rest] })
    try {
      const entry = (await new StateStore(dataDir).load()).state.plugins[ID]
      expect(entry).toMatchObject({ signer: 'hetu first-party', class: 2, granted: [listAll, readAll, narrowed, ...rest] })
      expect(entry?.firstUse ?? []).toEqual([])
      const view = explorer(editor)
      await view.waitFor()
      await row(view, 'a').waitFor()
      await openFolder(view, 'inbox')
      await openFolder(view, 'notes')
      for (const name of ['a', 'b', 'c', 'd']) expect(await row(view, name).isVisible(), name).toBe(true)

      // Opens a note outside inbox/
      await row(view, 'd').click()
      await until(async () => (await shown(editor).innerText()) === 'delta')

      // Renames inside inbox/, not out of it and not outside it
      await row(view, 'c').click()
      await row(view, 'Rename').click()
      await typed(view, 'inbox/c2')
      await until(() => exists(path.join(folder, 'inbox', 'c2.md')))
      await row(view, 'c2').click()
      await row(view, 'Rename').click()
      await typed(view, 'c3')
      await until(async () => (await status(view)).includes('Can’t move inbox/c2.md to c3.md: not-granted'))
      await row(view, 'Cancel').click()
      await row(view, 'd').click()
      await row(view, 'Rename').click()
      await typed(view, 'notes/d2')
      await until(async () => (await status(view)).includes('Can’t move notes/d.md to notes/d2.md: not-granted'))
      await row(view, 'Cancel').click()

      // Deletes inside inbox/ and not outside it
      await deleted(view, 'b')
      await until(async () => !(await exists(path.join(folder, 'inbox', 'b.md'))))
      await deleted(view, 'a')
      await until(async () => (await status(view)).includes('Can’t delete a.md: not-granted'))
      expect(await files(folder)).toEqual(['a.md', 'inbox/c2.md', 'notes/d.md'])
      expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('alpha')

      // Nothing asked: write inside one folder is class 2
      expect(await logged(dataDir, 'security.applied', { kind: 'item.on', target: ID })).toBe(false)
      // One read for each of the two deletes and no other
      await until(async () => (await readsBy(dataDir)) === 2)
      await tick(1500)
      expect(await readsBy(dataDir)).toBe(2)
    } finally {
      await putBack(folder)
    }
  })
})
