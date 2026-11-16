import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { cleanup, editorPage, launch, logged, temp, tick, until } from './helpers.ts'

afterEach(cleanup)

// 3000 short lines, far taller than the window
const LINES = 3000
const long = Array.from({ length: LINES }, (_, i) => `line ${i} of a long note`).join('\n')

async function started(notes: Record<string, string>): Promise<{ app: ElectronApplication, editor: Page, refused: string[] }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(notes)) await writeFile(path.join(folder, name), text)
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: [] })
  await store.writeLuoshu({ folder })
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
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'luoshu' }))
  return { app, editor, refused }
}

async function open(editor: Page, name: string): Promise<void> {
  await editor.keyboard.press('ControlOrMeta+p')
  await until(async () => editor.locator('#palette').isVisible())
  await editor.keyboard.type(name)
  await until(async () => (await editor.locator('#palette-list li').first().innerText()) === name)
  await editor.keyboard.press('Enter')
  await until(async () => (await editor.locator('#title').innerText()).startsWith(name))
}

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
})
