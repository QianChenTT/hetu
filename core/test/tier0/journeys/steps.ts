// Steps the journeys share: each a person's action through main's input route, then agree, which waits until the
// action landed and every place showing a state agrees
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Frame, Page } from 'playwright'
import { expect } from 'vitest'
import { heard, mark } from '../input.ts'
import { until, type Instance, type RunRecord } from '../instance.ts'
import { agree, readState, type AgreeOptions, type State } from '../state.ts'

// A seed note in Inbox by its number
export const note = (n: number) => `Inbox/Inbox note ${String(n).padStart(2, '0')}.md`

export const current = (state: State) => state.editors.find(editor => editor.current)
export const tabOf = (state: State, instance: string | undefined) => state.tabs.find(tab => tab.instance === instance)
// The tabs of notes, by the instance ids the editors give them
export const noteTabs = (state: State) => state.tabs.filter(tab => state.editors.some(editor => editor.instance === tab.instance))
export const currentTab = (state: State) => tabOf(state, current(state)?.instance)?.text

export async function explorer(editor: Page): Promise<Frame> {
  const element = await editor.waitForSelector('iframe[data-hetu-owner="file-explorer"]', { state: 'attached' })
  const frame = await element.contentFrame()
  if (frame === null) throw new Error('the Files frame has no document')
  return frame
}

export async function filesRow(editor: Page, name: string) {
  const row = (await explorer(editor)).getByRole('treeitem', { name, exact: true })
  await until(async () => await row.count() === 1, `one Files row named ${name}`)
  return row
}

export const shownNote = (editor: Page) => editor.locator('[data-hetu-editor]:not([hidden]) [role=textbox]')

export const step = (instance: Instance, landed: AgreeOptions['landed']) => agree(instance, { landed })

// Opens the note at path from Files, each folder above it opened first by a click on its row
export async function openFromFiles(instance: Instance, editor: Page, note: string): Promise<State> {
  const parts = note.slice(0, -'.md'.length).split('/')
  for (const [at, folder] of parts.slice(0, -1).entries()) {
    const above = parts.slice(0, at + 1).join('/')
    const state = await step(instance, () => true)
    if (state.files?.rows?.find(row => row.path === above)?.expanded === true) continue
    await instance.click(await filesRow(editor, folder))
    await step(instance, after => after.files?.rows?.find(row => row.path === above)?.expanded === true)
  }
  await instance.click(await filesRow(editor, parts.at(-1)!))
  return step(instance, state => currentTab(state) === note)
}

// A click in the shown note, then keys through main, landed once the note grew by them, so text the note held
// before never counts
export async function typeInNote(instance: Instance, editor: Page, text: string): Promise<State> {
  const before = current(await readState(instance))?.text
  if (before === undefined || before === null) throw new Error('no current note to type in')
  await instance.click(shownNote(editor))
  await instance.keys(editor, text)
  return step(instance, state => current(state)?.text?.length === before.length + text.length && current(state)!.text!.includes(text))
}

// Waits until main heard the key go down in the editor window since the mark, so an action whose effect is that nothing
// changes has reached hetu before agree holds
export async function heardKey(instance: Instance, since: number, key: string): Promise<void> {
  await until(async () => (await heard(instance.app, since, { url: 'hetu://editor/', kind: 'key' }))
    .some(each => each.type === 'keyDown' && each.key?.toLowerCase() === key.toLowerCase()), `main to hear ${key}`)
}
export const markInput = (instance: Instance) => mark(instance.app)

// shell.trashItem in main moves what it is handed into a bin in the instance's folder instead of the OS's Trash, so a
// delete leaves the machine's own Trash alone. Main calls it through the same shell object at each remove
export async function binned(instance: Instance): Promise<string> {
  const bin = path.join(instance.folder, 'bin')
  await mkdir(bin)
  await instance.app.evaluate(({ shell }, into) => {
    const { rename } = process.getBuiltinModule('node:fs/promises')
    const { basename, join } = process.getBuiltinModule('node:path')
    shell.trashItem = absolute => rename(absolute, join(into, basename(absolute)))
  }, bin)
  return bin
}

// Rename in Files on the selected note: the box holds the path less .md, which the keys replace, then Enter
export async function renameInFiles(instance: Instance, editor: Page, to: string): Promise<State> {
  const files = await explorer(editor)
  await instance.click(files.getByRole('button', { name: 'Rename', exact: true }))
  const box = files.getByRole('textbox', { name: 'Note path' })
  await until(() => box.isVisible(), 'the rename box')
  const held = await box.inputValue()
  expect(await instance.frameKeys([...Array<string>(held.length).fill('Backspace'), ...to, 'Enter'])).toEqual([])
  return step(instance, state => state.disk.files.includes(`${to}.md`))
}

// The drafts the editor window keeps, each a JSON line naming its key and value, then the line's hash
export async function drafts(instance: Instance): Promise<{ path: string, text: string, at: number }[]> {
  const space = path.join(instance.data, 'storage', 'window.editor')
  const names = (await readdir(space).catch(() => [])).filter(name => name.startsWith('key-draft'))
  const kept = []
  for (const name of names) {
    const { value } = JSON.parse((await readFile(path.join(space, name), 'utf8')).split('\n')[0]!) as { value: { path: string, text: string, at: number } }
    kept.push({ path: value.path, text: value.text, at: value.at })
  }
  return kept
}

// ⌘Q through main as a person quits, then the record once the process has closed. Main may go down before the
// press's own call answers, which is the only failure let through
export async function quitWithKeys(instance: Instance, editor: Page): Promise<RunRecord> {
  await instance.press(editor, 'Mod+Q').catch((err: unknown) => {
    if (!/closed/i.test(String(err))) throw err
  })
  await instance.ended()
  return instance.quit()
}
