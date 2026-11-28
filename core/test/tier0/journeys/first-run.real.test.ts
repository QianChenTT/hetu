// Tier 0's first-run journeys on the driven build: the startup flow's folder pick and install, a broken zip, the same
// zip again, a plugin removed, the first write's Confirm and the door. Every Confirm goes through its delay check, and
// the editor window's places agree after each step it shows. Inside the delay only main's restart on focus is pressed,
// emitted in the press's own task: the restarts on show and on a load need the window really shown and are on Han's
// screen list, as are the real picker's refocus and hetu's own focus() bringing the window forward
import { execFileSync } from 'node:child_process'
import { lstat, readdir, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { userInfo } from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { PendingRequest } from '../../../api/actions.ts'
import { pipeName } from '../../../api/pipe.ts'
import { INPUT_DELAY_MS, installProblemWords } from '../../../api/trusted.ts'
import { StateStore } from '../../../backend/boot/state.ts'
import { noticeText } from '../../../frontend/editor/shell.ts'
import { Dropped } from '../input.ts'
import { armed, EMITTED_SHOW, PICKER_FOCUS, profiles, showUnseen, start, until, type Instance } from '../instance.ts'
import { counted } from '../log.ts'
import { agree } from '../state.ts'
import { drawn, EMITTED_FOCUS, firstSeen, pressArmed, shown, throughDelay } from './trusted.ts'

const pair = { name: 'pair', plugins: ['file-explorer', 'links'] }
// The words each check reads, from where the page takes them, so a pin goes red on behaviour and not on wording
const notice = (kind: PendingRequest['kind'], plugin: string) => noticeText({ id: 'r', kind, plugin })
const NO_FOLDER = 'no notes folder is picked yet'
const notes = { 'a.md': '# a\n\nbody a\n' }
const pluginFolders = async (instance: Instance) => (await readdir(path.join(instance.data, 'plugins')).catch(() => [])).sort()
const confirmOf = (trusted: Page) => trusted.getByRole('button', { name: 'Confirm', exact: true })
const installOf = (trusted: Page) => trusted.locator('section.installing').getByRole('button', { name: 'Install', exact: true })
const fromZip = (trusted: Page) => trusted.getByRole('button', { name: 'Install from a zip' }).first()
const explorer = async (editor: Page) => {
  const element = await editor.waitForSelector('iframe[data-hetu-owner="file-explorer"]', { state: 'attached' })
  return (await element.contentFrame())!
}

// The Plugins tab, pressed until it is the one shown, since a redraw can replace the tab under the press. Each press
// made again is recorded with why, so a page redrawing under every press shows in the run record
const PRESSED_AGAIN = 'pressed the Plugins tab again after '
async function pluginsTab(instance: Instance, trusted: Page): Promise<void> {
  const tab = trusted.getByRole('tab', { name: /^Plugins/ })
  for (let tries = 0; await tab.getAttribute('aria-selected') !== 'true'; tries++) {
    if (tries === 3) throw new Error(`the Plugins tab never showed. The trusted window shows: ${await shown(trusted)}`)
    await pressArmed(instance, tab).catch((err: unknown) => {
      // Replaced by a redraw mid press: pressed again
      if (!/not attached|detached|never held still|hits |left the page under the press/.test(String(err))) throw err
      instance.harnessed(`${PRESSED_AGAIN}${String(err).replace(/^Error: /, '').split('\n')[0]}`)
    })
  }
}

// Install from a zip through the picker as its close gives the trusted window focus, then Install and its Confirm,
// each through the delay check. No box is open before the pick, so the one read is this pick's. replaces checks each
// row says what it replaces. Before the Confirm nothing is installed and nothing says so (sealed F3)
async function installZip(instance: Instance, trusted: Page, ids: readonly string[], replaces = false): Promise<void> {
  expect(await installOf(trusted).count(), 'an install box open before the pick').toBe(0)
  await instance.picker(instance.zip, { focusTrusted: true })
  await pressArmed(instance, fromZip(trusted))
  await drawn(installOf(trusted), 'the plugins found in the zip')
  if (replaces) for (const id of ids) expect(await trusted.locator('section.installing fieldset', { hasText: `(${id})` }).innerText()).toContain('replaces version')
  const before = await pluginFolders(instance)
  const confirm = firstSeen(confirmOf(trusted).first())
  await throughDelay(instance, installOf(trusted), { event: 'security.request', kind: 'plugin.install' }, confirm.seen, 'the install\'s Install')
  const drawnDisabled = confirm.disabled()
  // Read for a while, as the request's answer can come after its Confirm is drawn
  for (const ends = Date.now() + 600; Date.now() < ends; await new Promise(resolve => setTimeout(resolve, 50))) {
    expect(await trusted.getByText(/^Installed /).count(), `the trusted window says Installed while the Confirm waits: ${await shown(trusted)}`).toBe(0)
  }
  expect(await pluginFolders(instance)).toEqual(before)
  const installed = async () => await confirmOf(trusted).count() === 0 && (await pluginFolders(instance)).filter(id => ids.includes(id)).length === ids.length
  await throughDelay(instance, confirmOf(trusted).first(), { event: 'security.confirm', kind: 'plugin.install' }, installed, 'the install\'s Confirm', { drawnDisabled })
}

describe('first run and plugins on the driven build', () => {
  it('picks the notes folder and installs the zip through the startup flow, each Confirm counting only after its delay', async context => {
    const instance = await start(context, { profile: profiles.shipped, route: 'install', firstRun: true, notes })
    const editor = await instance.editor()
    const trusted = await instance.trusted()
    await until(async () => await trusted.getByRole('heading', { name: 'Get started with hetu' }).count() === 1, 'the startup flow')
    if (!await showUnseen(instance.app)) instance.harnessed(EMITTED_SHOW)
    expect(await editor.getByText(NO_FOLDER).count(), 'the editor saying no folder is picked').toBe(1)
    await agree(instance)

    // The picker's close gives the trusted window focus, which restarts its delay as the Confirm is asked for (W2)
    await instance.picker(instance.notes, { focusTrusted: true })
    await pressArmed(instance, trusted.getByRole('button', { name: 'Pick a folder' }))
    const picked = async () => (await new StateStore(instance.data).load()).state.luoshu?.folder === instance.notes
    await throughDelay(instance, confirmOf(trusted), { event: 'security.confirm', kind: 'luoshu.pick' }, picked, 'the folder\'s Confirm')
    await until(async () => await trusted.getByRole('button', { name: 'Pick the notes folder (done)' }).count() === 1, 'the step marked done')
    await until(async () => await editor.getByText(NO_FOLDER).count() === 0, 'the editor no longer saying no folder is picked')
    await agree(instance)

    await pressArmed(instance, trusted.getByRole('button', { name: 'Next' }))
    await installZip(instance, trusted, instance.ids)
    expect(await pluginFolders(instance)).toEqual([...instance.ids].sort())
    const agreed = await agree(instance, { landed: state => state.files?.rows?.map(row => row.path).join() === 'a.md' })
    expect(agreed.tabs.map(tab => tab.text)).toContain('links · Links')
    const record = await instance.quit()
    expect(record.harness.filter(step => step !== EMITTED_SHOW)).toEqual([PICKER_FOCUS, EMITTED_FOCUS, PICKER_FOCUS, EMITTED_FOCUS, EMITTED_FOCUS])
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
    // The note under the requests and the status line, each read as its own element
    const places = () => trusted.evaluate(words => [...document.querySelectorAll('p.note, [role=status]')]
      .filter(element => element.textContent === words).map(element => (element.getAttribute('role') === 'status' ? 'status line' : 'note')), installProblemWords.invalid)
    await until(async () => (await places()).length > 0, 'the broken zip\'s words')
    expect(await places(), 'T-56: the broken zip\'s words shown twice, a known defect').toEqual(['note', 'status line'])
    expect(await installOf(trusted).count()).toBe(0)
    expect(await pluginFolders(instance)).toEqual(['file-explorer', 'links'])

    // The same zip over the installed plugins: each row says what it replaces, and both run after the Confirm
    await installZip(instance, trusted, instance.ids, true)
    expect(await pluginFolders(instance)).toEqual(['file-explorer', 'links'])
    const editor = await instance.editor()
    await until(async () => await (await explorer(editor)).getByRole('treeitem', { name: 'a', exact: true }).count() === 1, 'the reinstalled explorer listing a')
    const agreed = await agree(instance, { landed: state => state.files?.rows?.length === 1 })
    expect(agreed.tabs.map(tab => tab.text)).toContain('links · Links')
    await instance.quit()
  })

  // The trusted window draws itself whole on each change, twice about 100 ms after an install as its plugins start, so
  // a redraw between the click's hit check and its press took the press from the target T-50's journey pressed. A
  // press waits until the window has stopped redrawing. The redraws here replace the whole root for 800 ms after the
  // window's delay ran out, as the page's draw replaces it
  it('presses a trusted window control only once the window has stopped redrawing', async context => {
    const instance = await start(context, { profile: pair, route: 'install', notes })
    const trusted = await instance.trusted()
    await armed(instance.app, trusted.url())
    const ends = await trusted.evaluate(() => {
      const root = document.getElementById('root')!
      const until = Date.now() + 800
      const timer = setInterval(() => {
        if (Date.now() > until) clearInterval(timer)
        else root.replaceChildren(...[...root.children].map(child => child.cloneNode(true)))
      }, 20)
      return until
    })
    await pressArmed(instance, trusted.getByRole('tab', { name: /^Plugins/ }))
    expect(Date.now()).toBeGreaterThan(ends)
    await instance.quit()
  })

  // A press of the Plugins tab made again after a redraw took the first is recorded, so a page that redraws under every
  // press shows in the run record instead of passing quietly. The tab is replaced on the press's mouse move by a copy
  // that hands its click to the tab, as a redraw does with the page's own handler
  it('records the Plugins tab pressed again after a redraw took the first press', async context => {
    const instance = await start(context, { profile: pair, route: 'install', notes })
    const trusted = await instance.trusted()
    await trusted.evaluate(() => {
      // The tab found at the move, as the window redraws itself while its plugins start
      window.addEventListener('mousemove', () => {
        const tab = [...document.querySelectorAll<HTMLElement>('[role=tab]')].find(each => /^Plugins/.test(each.textContent ?? ''))!
        const copy = tab.cloneNode(true) as HTMLElement
        copy.addEventListener('click', () => tab.click())
        tab.replaceWith(copy)
      }, { capture: true, once: true })
    })
    await pluginsTab(instance, trusted)
    const record = await instance.quit()
    expect(record.harness.filter(step => step.startsWith(PRESSED_AGAIN))).toEqual([`${PRESSED_AGAIN}the target left the page under the press, as a redraw replaces it: the press went to what took its place, the target got 0 pointerdown and 0 pointerup`])
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
    const found = editor.getByRole('button', { name: notice('plugin.approve', 'links') })
    await until(async () => await found.count() === 1, 'T-50: "New plugin found" for the plugin just removed, a known defect', 10_000)
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
    const asked = { event: 'security.request', kind: 'item.on', target: 'file-explorer' }
    await until(async () => await counted(instance.data, asked) === 1, 'the rename\'s write asking for its Confirm')
    expect((await stat(path.join(instance.notes, 'a.md'))).isFile()).toBe(true)
    await agree(instance, { landed: state => state.disk.files.join() === 'a.md' })

    const firstUse = editor.getByRole('button', { name: notice('item.on', 'file-explorer') })
    await drawn(firstUse, 'the first-use notice')
    // The notice opens the trusted window only once it has been on screen for the delay, counted from when it was seen
    const seenAt = Date.now()
    await until(() => Date.now() - seenAt > INPUT_DELAY_MS + 100, 'the notice\'s delay')
    await instance.click(firstUse).catch((err: unknown) => {
      throw err instanceof Dropped ? new Error('main dropped the press on the editor\'s notice, which has no delay') : err
    })
    const confirm = trusted.locator('section.request', { hasText: 'Let file-explorer create, change, move and delete all your notes' }).getByRole('button', { name: 'Confirm', exact: true })
    const on = async () => await counted(instance.data, { event: 'security.applied', kind: 'item.on', target: 'file-explorer' }) === 1
    await throughDelay(instance, confirm, { event: 'security.confirm', kind: 'item.on', target: 'file-explorer' }, on, 'the first write\'s Confirm', false)
    expect((await readdir(instance.notes)).sort(), 'T-22: the write is not retried after its Confirm, a question for Han').toEqual(['a.md'])

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
      asked.setTimeout(3000, () => {
        resolve('timed out')
        asked.destroy()
      })
      asked.end('{}')
    })
    await until(async () => await door() === 401, 'the door answering', 10_000)
    expect(await door('localhost:4747')).toBe(403)
    const pipe = pipeName(process.platform, userInfo().username)
    expect((await stat(pipe)).isSocket()).toBe(true)
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
    // The socket goes with the door. Its folder stays: the pipe keeps one folder of the user's own, 0700, and checks it
    // is that at each start, so a folder another user made first refuses the door
    expect(await lstat(pipe).then(() => 'there', () => 'gone')).toBe('gone')
    expect((await stat(path.dirname(pipe))).mode & 0o777).toBe(0o700)
  })
})
