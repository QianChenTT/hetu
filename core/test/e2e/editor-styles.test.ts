import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, launch, logged, temp, tick, until, workersPage, openByHand, writeOpener } from './helpers.ts'

afterEach(cleanup)

// 3000 short lines, far taller than the window
const LINES = 3000
const long = Array.from({ length: LINES }, (_, i) => `line ${i} of a long note`).join('\n')

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')
// A plugin that hands its ctx to the test
const fixture = `
import { definePlugin } from '${sdk}'
export default definePlugin({ start(ctx) { (globalThis as Record<string, unknown>).ctx = ctx } })
`
type Fixture = { granted: Capability[], theme?: object }

async function started(notes: Record<string, string>, plugins: Record<string, Fixture> = {}): Promise<{ app: ElectronApplication, editor: Page, refused: string[] }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(notes)) await writeFile(path.join(folder, name), text)
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: [] })
  await store.writeLuoshu({ folder })
  await writeOpener(dataDir)
  if (Object.keys(plugins).length > 0) {
    const source = await temp()
    await writeFolder(source, { 'src/worker.ts': fixture })
    const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
    for (const [id, plugin] of Object.entries(plugins)) {
      const root = path.join(dataDir, 'plugins', id)
      const manifest = workerManifest(id, { capabilities: plugin.granted, ...(plugin.theme === undefined ? {} : { theme: plugin.theme }) })
      await writeFolder(root, filesFor(manifest, { 'worker.js': built!.text }))
      await writeApproved(store, id, root, { granted: plugin.granted })
    }
  }
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  const refused: string[] = []
  editor.on('console', message => {
    if (message.text().includes('Content Security Policy')) refused.push(message.text())
  })
  await editor.evaluate(() => {
    document.addEventListener('securitypolicyviolation', event => {
      console.error(`Content Security Policy refused ${event.violatedDirective} ${event.blockedURI}`)
    })
  })
  await until(() => logged(dataDir, 'core.ready'))
  for (const id of Object.keys(plugins)) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  return { app, editor, refused }
}

const open = openByHand

type Seen = {
  slot: { height: number, scrollTop: number }
  scroller: { overflowY: string, height: number, clientHeight: number, scrollHeight: number, scrollTop: number, top: number, bottom: number }
  viewport: { from: number, to: number }
  length: number
  // The line drawn at the scroll box's middle with the place it starts at, then the last line drawn with its box
  middle: { line: number, from: number } | null
  last: { text: string, top: number, bottom: number } | null
  styles: { applied: number, blocked: number }
}

// What the shown editor looks like now. The view is read through the content element CodeMirror keeps it on
const seen = (editor: Page) => editor.evaluate((): Seen => {
  const slot = document.querySelector('.editor:not([hidden])') as HTMLElement
  const scroller = slot.querySelector('.cm-scroller') as HTMLElement
  const content = slot.querySelector('.cm-content') as unknown as { cmTile?: { root?: { view?: { viewport: { from: number, to: number }, state: { doc: { length: number, line(n: number): { from: number } } } } } } }
  const view = content.cmTile?.root?.view
  if (view === undefined) throw new Error('no view on the content element')
  const box = scroller.getBoundingClientRect()
  const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('.cm-line')
  const number = /^line (\d+) /.exec(at?.textContent ?? '')
  const lines = [...slot.querySelectorAll('.cm-line')]
  const lastLine = lines[lines.length - 1]
  const lastBox = lastLine?.getBoundingClientRect()
  const styles = [...document.querySelectorAll('style')]
  return {
    slot: { height: slot.clientHeight, scrollTop: slot.scrollTop },
    scroller: {
      overflowY: getComputedStyle(scroller).overflowY, height: box.height, clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop, top: box.top, bottom: box.bottom,
    },
    viewport: { from: view.viewport.from, to: view.viewport.to },
    length: view.state.doc.length,
    middle: number === null ? null : { line: Number(number[1]), from: view.state.doc.line(Number(number[1]) + 1).from },
    last: lastLine === undefined || lastBox === undefined ? null : { text: lastLine.textContent ?? '', top: lastBox.top, bottom: lastBox.bottom },
    styles: { applied: styles.filter(style => style.sheet !== null).length, blocked: styles.filter(style => style.sheet === null).length },
  }
})

describe('the editor\'s own styles', () => {
  it('scrolls a note taller than the window in the editor\'s own scroll box, Ctrl+End staying at the end and the viewport following, with no style refused', async () => {
    const { editor, refused } = await started({ 'long.md': long })
    await open(editor, 'long.md')
    const first = await seen(editor)
    // CodeMirror's style sheet applies, so its scroller is the box that scrolls and no taller than the slot
    expect(first.styles).toEqual({ applied: 1, blocked: 0 })
    expect(first.scroller.overflowY).toBe('auto')
    expect(first.scroller.clientHeight).toBeLessThanOrEqual(first.slot.height)
    expect(first.scroller.scrollHeight).toBeGreaterThan(first.scroller.clientHeight * 10)
    expect(first.viewport.from).toBe(0)
    expect(first.viewport.to).toBeLessThan(first.length / 10)

    await editor.locator('.editor:not([hidden]) .cm-content').click()
    await editor.keyboard.press('ControlOrMeta+End')
    const atEnd = (now: Seen) => now.viewport.to === now.length && now.viewport.from > 0 && now.scroller.scrollTop > 0
      && now.last?.text === `line ${LINES - 1} of a long note` && now.last.bottom <= now.scroller.bottom + 1 && now.last.top >= now.scroller.top
    await until(async () => atEnd(await seen(editor)), 5000)
    // Still there once the editor has measured again, the slot itself never scrolled
    await tick(1000)
    const end = await seen(editor)
    expect(atEnd(end), JSON.stringify(end)).toBe(true)
    expect(end.slot.scrollTop).toBe(0)

    // Scrolled half way by its scroll box, the viewport holds the line on screen there
    await editor.evaluate(() => {
      const scroller = document.querySelector('.editor:not([hidden]) .cm-scroller') as HTMLElement
      scroller.scrollTop = scroller.scrollHeight / 2
    })
    const holdsMiddle = (now: Seen) => now.middle !== null && now.middle.line > LINES / 4 && now.middle.line < LINES * 3 / 4
      && now.viewport.from <= now.middle.from && now.viewport.to > now.middle.from
    await until(async () => holdsMiddle(await seen(editor)), 5000)
    const middle = await seen(editor)
    expect(middle.viewport.from).toBeGreaterThan(0)
    expect(middle.viewport.to).toBeLessThan(middle.length)

    expect(refused).toEqual([])
  })

  it('names a nonce in the editor page\'s policy that its own script holds, fresh on each load and hidden from attribute reads', async () => {
    const { app, editor } = await started({})
    const policies = await app.evaluate(async ({ session }) => {
      const editor = session.fromPartition('hetu-editor')
      const policies: string[] = []
      for (let i = 0; i < 2; i++) policies.push((await editor.fetch('hetu://editor/')).headers.get('content-security-policy') ?? '')
      return policies
    })
    const nonces = policies.map(policy => /'nonce-([^']+)'/.exec(policy)?.[1])
    expect(nonces[0]).toBeDefined()
    expect(nonces[1]).toBeDefined()
    expect(nonces[0]).not.toBe(nonces[1])
    for (const policy of policies) expect(policy).not.toContain('unsafe-inline')
    const held = await editor.evaluate(() => {
      const script = document.querySelector('script[src="page.js"]') as HTMLScriptElement
      return { nonce: script.nonce, attribute: script.getAttribute('nonce'), selected: document.querySelectorAll('[nonce]:not([nonce=""])').length }
    })
    // The page's own nonce is neither fetched one. No attribute read or selector finds it
    expect(held.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(nonces).not.toContain(held.nonce)
    expect(held.attribute).toBe('')
    expect(held.selected).toBe(0)
  })

  it('draws the caret and the focused editor\'s dotted outline in the editor\'s text color under hetu\'s colors and a dark theme', async () => {
    const dusk = { tokens: { 'color-editor-fg': '#e8e8e8', 'color-editor-bg': '#101010', 'color-bg': '#181818', 'color-fg': '#e8e8e8' } }
    const { editor } = await started({ 'a.md': 'some words to type after' }, { dusk: { granted: [], theme: dusk } })
    await open(editor, 'a.md')
    const plain = await focused(editor)
    // hetu's own colors stay as they are and the caret and outline take the text's color
    expect(plain).toMatchObject({ focused: true, text: 'rgb(31, 31, 31)', background: 'rgb(255, 255, 255)', caret: 'rgb(31, 31, 31)', outline: 'dotted 1px rgb(31, 31, 31)' })
    expect(plain.caretContrast).toBeGreaterThanOrEqual(plain.textContrast)
    expect(plain.outlineContrast).toBeGreaterThanOrEqual(plain.textContrast)

    await editor.locator('#views').click()
    await until(async () => editor.locator('#menu').isVisible())
    await editor.locator('#menu select').first().selectOption('dusk')
    await until(async () => (await looks(editor)).background === 'rgb(16, 16, 16)')
    await editor.locator('#menu-close').click()
    const dark = await focused(editor)
    expect(dark).toMatchObject({ focused: true, text: 'rgb(232, 232, 232)', caret: 'rgb(232, 232, 232)', outline: 'dotted 1px rgb(232, 232, 232)' })
    expect(dark.caretContrast).toBeGreaterThanOrEqual(dark.textContrast)
    expect(dark.outlineContrast).toBeGreaterThanOrEqual(dark.textContrast)
  })

  it('indents a plugin\'s quote line 12px inside its border, over the 6px CodeMirror gives every line', async () => {
    const granted: Capability[] = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }]
    const { app, editor } = await started({ 'a.md': 'a first line\na quoted line\na last line' }, { quoter: { granted } })
    await open(editor, 'a.md')
    const host = await workersPage(app, 'quoter')
    await until(() => host.workers().length === 1)
    const plugin = host.workers()[0]!
    type Ctx = { editor: { instances(): Promise<{ instance: string, version: number }[]>, decorate(instance: string, version: number, set: string, marks: unknown[]): Promise<void> } }
    await until(async () => (await plugin.evaluate(() => (globalThis as unknown as { ctx: Ctx }).ctx.editor.instances())).length === 1)
    const answer = await plugin.evaluate(async () => {
      const { ctx } = globalThis as unknown as { ctx: Ctx }
      const [open] = await ctx.editor.instances()
      return ctx.editor.decorate(open!.instance, open!.version, 'quote', [{ kind: 'line', from: 13, style: 'quote' }]).then(() => 'drawn', (err: { code?: string }) => `refused ${err.code}`)
    })
    expect(answer).toBe('drawn')
    const lines = editor.locator('.editor:not([hidden]) .cm-line')
    await until(async () => (await editor.locator('.editor:not([hidden]) .cm-hetu-line-quote').count()) === 1)
    const indents = await lines.evaluateAll(found => found.map(line => {
      const style = getComputedStyle(line)
      return `${line.textContent}: ${style.paddingLeft} inside ${style.borderLeftWidth} ${style.borderLeftStyle}`
    }))
    expect(indents).toEqual(['a first line: 6px inside 0px none', 'a quoted line: 12px inside 3px solid', 'a last line: 6px inside 0px none'])
  })

  it("draws a plugin's widgets at a point at a line's start, mid-line and the note's end with the rest of its set", async () => {
    const granted: Capability[] = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }]
    const { app, editor } = await started({ 'a.md': 'a first line\na quoted line\na last line' }, { pointer: { granted } })
    await open(editor, 'a.md')
    const host = await workersPage(app, 'pointer')
    await until(() => host.workers().length === 1)
    const plugin = host.workers()[0]!
    type Ctx = { editor: { instances(): Promise<{ instance: string, version: number }[]>, decorate(instance: string, version: number, set: string, marks: unknown[]): Promise<void> } }
    await until(async () => (await plugin.evaluate(() => (globalThis as unknown as { ctx: Ctx }).ctx.editor.instances())).length === 1)
    const answer = await plugin.evaluate(async () => {
      const { ctx } = globalThis as unknown as { ctx: Ctx }
      const [open] = await ctx.editor.instances()
      return ctx.editor.decorate(open!.instance, open!.version, 'points', [
        { kind: 'widget', from: 13, to: 13, text: '>' },
        { kind: 'widget', from: 2, to: 2, text: '*' },
        { kind: 'widget', from: 38, to: 38, text: '.' },
        { kind: 'line', from: 13, style: 'quote' },
        { kind: 'mark', from: 0, to: 1, style: 'em' },
      ]).then(() => 'drawn', (err: { code?: string }) => `refused ${err.code}`)
    })
    expect(answer).toBe('drawn')
    await until(async () => (await editor.locator('.editor:not([hidden]) .cm-hetu-widget').count()) === 3)
    expect(await editor.locator('.editor:not([hidden]) .cm-line').allTextContents()).toEqual(['a *first line', '>a quoted line', 'a last line.'])
    expect(await editor.locator('.editor:not([hidden]) .cm-hetu-em').count()).toBe(1)
    expect(await editor.locator('.editor:not([hidden]) .cm-hetu-line-quote').count()).toBe(1)
  })
})

describe('a link mark', () => {
  it('underlines its text in the link color and tells a Ctrl or Cmd click on it only to its plugin, a plain click placing the caret', async () => {
    const granted: Capability[] = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }]
    const { app, editor } = await started({ 'a.md': 'see the note here' }, { linker: { granted }, other: { granted } })
    await open(editor, 'a.md')
    type Ctx = { editor: { instances(): Promise<{ instance: string, version: number }[]>, decorate(instance: string, version: number, set: string, marks: unknown[]): Promise<void>, on(topic: string, handler: (event: unknown) => void): void } }
    const listening = async (id: string) => {
      const host = await workersPage(app, id)
      await until(() => host.workers().length === 1)
      const plugin = host.workers()[0]!
      await until(async () => (await plugin.evaluate(() => (globalThis as unknown as { ctx: Ctx }).ctx.editor.instances())).length === 1)
      await plugin.evaluate(() => {
        const held = globalThis as unknown as { ctx: Ctx, heard: unknown[] }
        held.heard = []
        held.ctx.editor.on('link', event => held.heard.push(event))
      })
      return { plugin, heard: () => plugin.evaluate(() => (globalThis as unknown as { heard: unknown[] }).heard) }
    }
    const [linker, other] = [await listening('linker'), await listening('other')]
    await linker.plugin.evaluate(async () => {
      const { ctx } = globalThis as unknown as { ctx: Ctx }
      const [note] = await ctx.editor.instances()
      await ctx.editor.decorate(note!.instance, note!.version, 'links', [{ kind: 'link', from: 4, to: 12, id: 'theNote' }])
    })
    const drawn = editor.locator('.editor:not([hidden]) .cm-hetu-link')
    await until(async () => (await drawn.count()) === 1)
    expect(await drawn.innerText()).toBe('the note')
    expect(await drawn.evaluate(found => [getComputedStyle(found).textDecorationLine, getComputedStyle(found).color])).toEqual(['underline', 'rgb(26, 95, 180)'])
    const head = () => editor.evaluate(() => {
      const content = document.querySelector('.editor:not([hidden]) .cm-content') as unknown as { cmTile?: { root?: { view?: { state: { selection: { main: { head: number } } } } } } }
      return content.cmTile?.root?.view?.state.selection.main.head
    })

    await editor.locator('.editor:not([hidden]) .cm-content').click({ position: { x: 1, y: 5 } })
    const before = await head()
    await drawn.click({ modifiers: ['ControlOrMeta'] })
    await until(async () => (await linker.heard()).length === 1)
    expect(await linker.heard()).toEqual([expect.objectContaining({ topic: 'editor.link', version: 0, id: 'theNote' })])
    expect(await head()).toBe(before)

    await drawn.click()
    await tick(300)
    const placed = await head()
    expect(placed).toBeGreaterThan(4)
    expect(placed).toBeLessThanOrEqual(12)
    expect(await linker.heard()).toHaveLength(1)
    expect(await other.heard()).toEqual([])
  })
})

// The shown editor's text, background, caret and outline as computed, each color's contrast against the background
const looks = (editor: Page) => editor.evaluate(() => {
  const content = document.querySelector('.editor:not([hidden]) .cm-content') as HTMLElement
  const cm = content.closest('.cm-editor') as HTMLElement
  const luminance = (color: string) => {
    const [r, g, b] = (/rgba?\((\d+), (\d+), (\d+)/.exec(color) ?? []).slice(1).map(value => {
      const part = Number(value) / 255
      return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
  }
  const contrast = (a: string, b: string) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
    return (high + 0.05) / (low + 0.05)
  }
  const inner = getComputedStyle(content)
  const outer = getComputedStyle(cm)
  return {
    focused: cm.classList.contains('cm-focused'), text: inner.color, background: outer.backgroundColor, caret: inner.caretColor,
    outline: `${outer.outlineStyle} ${outer.outlineWidth} ${outer.outlineColor}`,
    textContrast: contrast(inner.color, outer.backgroundColor), caretContrast: contrast(inner.caretColor, outer.backgroundColor),
    outlineContrast: contrast(outer.outlineColor, outer.backgroundColor),
  }
})

// The same once a click into the shown editor has CodeMirror mark it focused, which can come a moment after the click
async function focused(editor: Page): Promise<Awaited<ReturnType<typeof looks>>> {
  await editor.locator('.editor:not([hidden]) .cm-content').click()
  await until(async () => (await looks(editor)).focused)
  return looks(editor)
}
