// Tier 0's first-run journeys on the driven build: the startup flow's folder pick and install, a broken zip, the same
// zip again, a plugin removed, the first write's Confirm and the door. Every Confirm goes through its delay check, and
// the editor window's places agree after each step it shows
import { execFileSync } from 'node:child_process'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { userInfo } from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { pipeName } from '../../../api/pipe.ts'
import { StateStore } from '../../../backend/boot/state.ts'
import { EMITTED_SHOW, profiles, showUnseen, start, until, type Instance } from '../instance.ts'
import { agree } from '../state.ts'
import { counted, drawn, EMITTED_FOCUS, pressArmed, shown, throughDelay } from './trusted.ts'

const pair = { name: 'pair', plugins: ['file-explorer', 'links'] }
const notes = { 'a.md': '# a\n\nbody a\n' }
const pluginFolders = async (instance: Instance) => (await readdir(path.join(instance.data, 'plugins')).catch(() => [])).sort()
const confirmOf = (trusted: Page) => trusted.getByRole('button', { name: 'Confirm', exact: true })
const installOf = (trusted: Page) => trusted.locator('section.installing').getByRole('button', { name: 'Install', exact: true })
const fromZip = (trusted: Page) => trusted.getByRole('button', { name: 'Install from a zip' }).first()
const explorer = async (editor: Page) => {
  const element = await editor.waitForSelector('iframe[data-hetu-owner="file-explorer"]', { state: 'attached' })
  return (await element.contentFrame())!
}

// The Plugins tab, pressed until it is the one shown, since a redraw can replace the tab under the press
async function pluginsTab(instance: Instance, trusted: Page): Promise<void> {
  const tab = trusted.getByRole('tab', { name: /^Plugins/ })
  for (let tries = 0; await tab.getAttribute('aria-selected') !== 'true'; tries++) {
    if (tries === 3) throw new Error(`the Plugins tab never showed. The trusted window shows: ${await shown(trusted)}`)
    await pressArmed(instance, tab).catch(() => {
      // Replaced by a redraw mid press: pressed again
    })
  }
}

// Install from a zip through the picker as its close gives the trusted window focus, then Install and its Confirm,
// each through the delay check. Before the Confirm nothing is installed and nothing says so (sealed F3)
async function installZip(instance: Instance, trusted: Page, ids: readonly string[]): Promise<void> {
  await instance.picker(instance.zip, { focusTrusted: true })
  await pressArmed(instance, fromZip(trusted))
  const before = await pluginFolders(instance)
  await throughDelay(instance, installOf(trusted), { event: 'security.request', kind: 'plugin.install' }, async () => await confirmOf(trusted).count() === 1, 'the install\'s Install')
  // Read for a while, as the request's answer can come after its Confirm is drawn
  for (const ends = Date.now() + 600; Date.now() < ends; await new Promise(resolve => setTimeout(resolve, 50))) {
    expect(await trusted.getByText(/^Installed /).count(), `the trusted window says Installed while the Confirm waits: ${await shown(trusted)}`).toBe(0)
  }
  expect(await pluginFolders(instance)).toEqual(before)
  const installed = async () => await confirmOf(trusted).count() === 0 && (await pluginFolders(instance)).filter(id => ids.includes(id)).length === ids.length
  await throughDelay(instance, confirmOf(trusted).first(), { event: 'security.confirm', kind: 'plugin.install' }, installed, 'the install\'s Confirm')
}

describe('first run and plugins on the driven build', () => {
  it('picks the notes folder and installs the zip through the startup flow, each Confirm counting only after its delay', async context => {
    const instance = await start(context, { profile: profiles.shipped, route: 'install', firstRun: true, notes })
    const editor = await instance.editor()
    const trusted = await instance.trusted()
    await until(async () => await trusted.getByRole('heading', { name: 'Get started with hetu' }).count() === 1, 'the startup flow')
    if (!await showUnseen(instance.app)) instance.harnessed(EMITTED_SHOW)
    await agree(instance)

    // The picker's close gives the trusted window focus, which restarts its delay as the Confirm is asked for (W2)
    await instance.picker(instance.notes, { focusTrusted: true })
    await pressArmed(instance, trusted.getByRole('button', { name: 'Pick a folder' }))
    const picked = async () => (await new StateStore(instance.data).load()).state.luoshu?.folder === instance.notes
    await throughDelay(instance, confirmOf(trusted), { event: 'security.confirm', kind: 'luoshu.pick' }, picked, 'the folder\'s Confirm')
    await until(async () => await trusted.getByRole('button', { name: 'Pick the notes folder (done)' }).count() === 1, 'the step marked done')
    expect(await editor.getByText('no notes folder is picked yet').count()).toBe(0)
    await agree(instance)

    await pressArmed(instance, trusted.getByRole('button', { name: 'Next' }))
    await installZip(instance, trusted, instance.ids)
    expect(await pluginFolders(instance)).toEqual([...instance.ids].sort())
    const agreed = await agree(instance, { landed: state => state.files?.rows?.map(row => row.path).join() === 'a.md' })
    expect(agreed.tabs.map(tab => tab.text)).toContain('links · Links')
    const record = await instance.quit()
    expect(record.harness.filter(step => step !== EMITTED_SHOW)).toEqual([EMITTED_FOCUS, EMITTED_FOCUS, EMITTED_FOCUS])
    expect(record.plugins.folders).toEqual(record.plugins.ids)
  })

  // T-56: a broken zip's words are in the page twice, the note under the requests and the status line a screen reader
  // reads. A known defect, pinned: once the words show once this goes red and becomes the check that they do
  it('says a broken zip is no zip, twice (T-56), then installs the same zip again over itself', async context => {
    const instance = await start(context, { profile: pair, route: 'install', notes })
    const trusted = await instance.trusted()
    await pluginsTab(instance, trusted)
    const broken = path.join(instance.folder, 'broken.zip')
    await writeFile(broken, 'not a zip\n')
    await instance.picker(broken, { focusTrusted: true })
    await pressArmed(instance, fromZip(trusted))
    const words = trusted.getByText('That doesn’t read as a zip or a plugin folder', { exact: true })
    await until(async () => await words.count() > 0, 'the broken zip\'s words')
    expect(await words.count()).toBe(2)
    expect(await installOf(trusted).count()).toBe(0)
    expect(await pluginFolders(instance)).toEqual(['file-explorer', 'links'])

    // The same zip over the installed plugins: each row says what it replaces, and both run after the Confirm
    await instance.picker(instance.zip, { focusTrusted: true })
    await pressArmed(instance, fromZip(trusted))
    await drawn(installOf(trusted), 'the plugins found again')
    for (const id of instance.ids) expect(await trusted.locator('section.installing fieldset', { hasText: `(${id})` }).innerText()).toContain('replaces version')
    await installZip(instance, trusted, instance.ids)
    expect(await pluginFolders(instance)).toEqual(['file-explorer', 'links'])
    const editor = await instance.editor()
    await until(async () => await (await explorer(editor)).getByRole('treeitem', { name: 'a', exact: true }).count() === 1, 'the reinstalled explorer listing a')
    const agreed = await agree(instance, { landed: state => state.files?.rows?.length === 1 })
    expect(agreed.tabs.map(tab => tab.text)).toContain('links · Links')
    await instance.quit()
  })

  // T-50: removing a plugin raises "New plugin found" for the plugin just removed, an approval nobody can answer. A known
  // defect, pinned: once the removal raises nothing this goes red and becomes the check that it doesn't
  it('removes a plugin after its Confirm and then raises "New plugin found" for it (T-50)', async context => {
    const instance = await start(context, { profile: pair, route: 'install', notes })
    const editor = await instance.editor()
    const trusted = await instance.trusted()
    await pluginsTab(instance, trusted)
    const row = trusted.locator('div.plugin').filter({ hasText: /^links · / })
    await pressArmed(instance, row.getByRole('button', { name: 'Remove' }))
    await until(async () => (await shown(trusted)).includes('Remove links with its code, storage and cache'), 'the removal\'s Confirm')
    const gone = async () => !(await pluginFolders(instance)).includes('links')
    await throughDelay(instance, confirmOf(trusted).first(), { event: 'security.confirm', kind: 'plugin.remove', target: 'links' }, gone, 'the removal\'s Confirm')
    expect(await pluginFolders(instance)).toEqual(['file-explorer'])
    const found = editor.getByRole('button', { name: 'New plugin found: "links"' })
    await until(async () => await found.count() === 1, 'T-50\'s notice for the removed plugin', 10_000)
    await agree(instance, { landed: state => !state.drawer.some(view => view.owner === 'links') })
    await instance.quit()
  })

  // The explorer's first rename asks in the trusted window and writes nothing before the Confirm. After it the rename
  // is not retried (T-22, a question for Han), so it is made again and lands
  it('asks for the first write\'s Confirm on the explorer\'s first rename, writing nothing before it', async context => {
    const instance = await start(context, { profile: { name: 'explorer', plugins: ['file-explorer'] }, route: 'install', notes })
    const editor = await instance.editor()
    const trusted = await instance.trusted()
    const files = await explorer(editor)
    await until(async () => await files.getByRole('treeitem', { name: 'a', exact: true }).count() === 1, 'the a row')
    await instance.click(files.getByRole('treeitem', { name: 'a', exact: true }))
    await instance.click(files.getByRole('button', { name: 'Rename' }))
    await until(async () => await files.getByRole('textbox').isVisible(), 'the rename box')
    expect(await instance.frameKeys(['Backspace', 'b', 'Enter'], 30)).toEqual([])
    await until(async () => (await files.locator('body').innerText()).includes('needs-confirm'), 'the rename refused for its Confirm')
    expect((await stat(path.join(instance.notes, 'a.md'))).isFile()).toBe(true)
    await agree(instance, { landed: state => state.disk.files.join() === 'a.md' })

    const notice = editor.getByRole('button', { name: 'The plugin "file-explorer" asks to use something for the first time' })
    await drawn(notice, 'the first-use notice')
    // The notice opens the trusted window only once it has been on screen for the delay
    await new Promise(resolve => setTimeout(resolve, 1100))
    await instance.click(notice)
    const confirm = trusted.locator('section.request', { hasText: 'Let file-explorer create, change, move and delete all your notes' }).getByRole('button', { name: 'Confirm', exact: true })
    const on = async () => await counted(instance, { event: 'security.applied', kind: 'item.on', target: 'file-explorer' }) === 1
    await throughDelay(instance, confirm, { event: 'security.confirm', kind: 'item.on', target: 'file-explorer' }, on, 'the first write\'s Confirm', false)
    expect((await readdir(instance.notes)).sort()).toEqual(['a.md'])

    // The refused box stays open with its words, so Enter in it again is the person's retry
    expect(await files.getByRole('textbox').inputValue()).toBe('b')
    await instance.click(files.getByRole('textbox'))
    expect(await instance.frameKeys(['Enter'])).toEqual([])
    await agree(instance, { landed: state => state.disk.files.join() === 'b.md' && state.files?.rows?.map(row => row.path).join() === 'b.md' })
    await instance.quit()
  })

  // D-763: the door's port and pipe are fixed, so its profile runs one instance at a time
  it('opens the door while mcp holds it and closes it when mcp is switched off and at the quit', async context => {
    const instance = await start(context, { profile: profiles.door, route: 'install', notes })
    // Node's own request, which sends the Host header as given
    const door = (host = '127.0.0.1:4747') => new Promise<number | string>(resolve => {
      const asked = request({ host: '127.0.0.1', port: 4747, path: '/mcp', method: 'POST', headers: { host, 'content-type': 'application/json' } }, answer => {
        answer.resume()
        resolve(answer.statusCode ?? 'no status')
      })
      asked.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'failed'))
      asked.end('{}')
    })
    await until(async () => await door() === 401, 'the door answering', 10_000)
    expect(await door('localhost:4747')).toBe(403)
    expect((await stat(pipeName(process.platform, userInfo().username))).isSocket()).toBe(true)
    // The listener is this instance's, a process under its main
    const listener = Number(execFileSync('lsof', ['-nP', '-iTCP:4747', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0])
    const parents = (pid: number): number[] => (pid <= 1 ? [] : [pid, ...parents(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()))])
    expect(parents(listener)).toContain(instance.app.process().pid)
    await agree(instance)

    const trusted = await instance.trusted()
    await pluginsTab(instance, trusted)
    await pressArmed(instance, trusted.locator('div.plugin').filter({ hasText: /^mcp · / }).getByRole('button', { name: 'Switch off', exact: true }).first())
    await until(async () => await door() === 'ECONNREFUSED', 'the door closed with mcp switched off', 10_000)
    await agree(instance)
    const record = await instance.quit()
    expect(record).toMatchObject({ serial: true, exitCode: 0 })
    expect(await door()).toBe('ECONNREFUSED')
  })
})
