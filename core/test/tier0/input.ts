// Main's input route for tier 0 and the end-to-end tests: input handed to a window the way the OS hands it, through
// main's own hooks, where Playwright's keys go round them. Measured on the driven build with hidden windows:
// - Playwright's keys never reach main's before-input-event. sendInputEvent's keys do, and go to the page, never to
//   the frame holding focus
// - sendInputEvent's mouse reaches before-mouse-event with no screen point, so main's hetu:press lands at the page's
//   corner, and the event never reaches a plugin frame
// - a CDP mouse event sent to the window's own target, as Playwright's mouse also sends it, goes through the
//   browser's hit-testing like a real one: main hears it in before-mouse-event with its screen point and the frame
//   under it gets it
// What none of them pass through is the OS: which window is under the pointer and key, the activating click, IME
import type { ElectronApplication, Locator, Page } from 'playwright'

// The routes a run names in its record
export const ROUTES = {
  keys: 'keys: sendInputEvent to the window, through main\'s before-input-event',
  frameKeys: 'frame keys: main\'s before-input-event handed each key, then CDP to the focused frame',
  mouse: 'mouse: CDP to the window\'s target, heard by main\'s before-mouse-event',
} as const

type Key = { key: string, code: string, accelerator: string, vk: number, text?: string, shift: boolean }
const NAMED: Record<string, Omit<Key, 'key' | 'shift'>> = {
  Enter: { code: 'Enter', accelerator: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', accelerator: 'Escape', vk: 27 },
  Tab: { code: 'Tab', accelerator: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', accelerator: 'Backspace', vk: 8 },
  ArrowUp: { code: 'ArrowUp', accelerator: 'Up', vk: 38 },
  ArrowDown: { code: 'ArrowDown', accelerator: 'Down', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', accelerator: 'Left', vk: 37 },
  ArrowRight: { code: 'ArrowRight', accelerator: 'Right', vk: 39 },
  ' ': { code: 'Space', accelerator: 'Space', vk: 32, text: ' ' },
  '\n': { code: 'Enter', accelerator: 'Enter', vk: 13, text: '\r' },
}

// A key by its name or a character, as a US layout types it. Any other is refused rather than guessed
export function keyOf(name: string): Key {
  const named = NAMED[name]
  if (named !== undefined) return { key: name === '\n' ? 'Enter' : name, shift: false, ...named }
  if (/^[a-zA-Z]$/.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, accelerator: name.toUpperCase(), vk: name.toUpperCase().charCodeAt(0), text: name, shift: name !== name.toLowerCase() }
  if (/^\d$/.test(name)) return { key: name, code: `Digit${name}`, accelerator: name, vk: name.charCodeAt(0), text: name, shift: false }
  throw new Error(`tier 0's input route has no key ${JSON.stringify(name)}`)
}

// A chord such as Mod+S: Mod is Cmd on macOS and Ctrl elsewhere
export function chordOf(chord: string, mac = process.platform === 'darwin') {
  const parts = chord.split('+')
  const key = keyOf(parts.at(-1)!.length === 1 ? parts.at(-1)!.toLowerCase() : parts.at(-1)!)
  const mods = new Set(parts.slice(0, -1).map(mod => (mod === 'Mod' ? (mac ? 'Meta' : 'Ctrl') : mod)))
  const unknown = [...mods].filter(mod => !['Meta', 'Ctrl', 'Alt', 'Shift'].includes(mod))
  if (unknown.length > 0) throw new Error(`tier 0's input route has no modifier ${unknown.join(', ')}`)
  return { key, meta: mods.has('Meta'), control: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift') || key.shift }
}

// What main heard in before-input-event and before-mouse-event on every window from now on, the harness's own
// handing of a key included. Mouse presses and releases only
export type Heard = { at: number, url: string, kind: 'key' | 'mouse', type: string, key?: string, meta?: boolean, control?: boolean, x?: number, y?: number }
export const watchInput = (app: ElectronApplication) => app.evaluate(({ app, webContents }) => {
  const scope = globalThis as unknown as { tier0Heard?: unknown[] }
  if (scope.tier0Heard !== undefined) return
  const heard: unknown[] = scope.tier0Heard = []
  const watch = (contents: Electron.WebContents) => {
    contents.on('before-input-event', (_event, input) => heard.push({ at: heard.length, url: contents.getURL(), kind: 'key', type: input.type, key: input.key, meta: input.meta, control: input.control }))
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown' || mouse.type === 'mouseUp') heard.push({ at: heard.length, url: contents.getURL(), kind: 'mouse', type: mouse.type, x: mouse.globalX, y: mouse.globalY })
    })
  }
  for (const contents of webContents.getAllWebContents()) watch(contents)
  app.on('web-contents-created', (_event, contents) => watch(contents))
})
// Where the watch stands now, to read what came after
export const mark = (app: ElectronApplication) => app.evaluate(() => ((globalThis as unknown as { tier0Heard?: unknown[] }).tier0Heard ?? []).length)
export const heard = (app: ElectronApplication, since = 0) => app.evaluate((_electron, from) => ((globalThis as unknown as { tier0Heard?: unknown[] }).tier0Heard ?? []).slice(from), since) as Promise<Heard[]>

// Keys typed into the page with focus, each a keyDown, its char and a keyUp, gap ms apart
export async function keys(app: ElectronApplication, page: Page, text: string, gap = 20): Promise<void> {
  for (const char of text) {
    const key = keyOf(char)
    await app.evaluate(({ webContents }, [url, key]) => {
      const contents = webContents.getAllWebContents().find(each => each.getURL() === url)!
      const modifiers = key.shift ? ['shift' as const] : []
      contents.sendInputEvent({ type: 'keyDown', keyCode: key.accelerator, modifiers })
      if (key.text !== undefined) contents.sendInputEvent({ type: 'char', keyCode: key.text, modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode: key.accelerator, modifiers })
    }, [page.url(), key] as const)
    await sleep(gap)
  }
}

// A key or chord pressed and let go in the page's window
export const press = (app: ElectronApplication, page: Page, chord: string) => app.evaluate(({ webContents }, [url, pressed]) => {
  const contents = webContents.getAllWebContents().find(each => each.getURL() === url)!
  const modifiers = (['meta', 'control', 'alt', 'shift'] as const).filter(mod => pressed[mod])
  contents.sendInputEvent({ type: 'keyDown', keyCode: pressed.key.accelerator, modifiers })
  contents.sendInputEvent({ type: 'keyUp', keyCode: pressed.key.accelerator, modifiers })
}, [page.url(), chordOf(chord)] as const)

// Keys Playwright sends never pass the window's before-input-event, and keys sent with sendInputEvent pass it but go
// to the page and never to a frame. So main's own handler is handed each key as the window's input would hand it and,
// when it lets the key go on, the debugger sends it in the same task to the frame holding focus, as the browser sends
// a key main let go on. gap is the time between keys, 0 for a burst. Answers where in the keys each key main dropped
// stood. A string is typed a character at a time, a list names each key
export const typeThroughMain = (app: ElectronApplication, typed: string | readonly string[], gap: number) => app.evaluate(async ({ webContents }, [all, wait]) => {
  const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  const dropped: number[] = []
  for (const [at, { key, code, vk: windowsVirtualKeyCode, text, shift }] of all.entries()) {
    for (const type of ['keyDown', 'keyUp'] as const) {
      let prevented = false
      const input = { type, key, code, control: false, meta: false, alt: false, shift, isAutoRepeat: false }
      contents.emit('before-input-event', { preventDefault: () => { prevented = true } }, input)
      if (prevented && type === 'keyDown') dropped.push(at)
      if (prevented) continue
      const sent = { type, key, code, windowsVirtualKeyCode, modifiers: shift ? 8 : 0, ...(type === 'keyDown' && text !== undefined ? { text } : {}) }
      void contents.debugger.sendCommand('Input.dispatchKeyEvent', sent)
    }
    await new Promise(resolve => setTimeout(resolve, wait))
  }
  return dropped
}, [[...typed].map(keyOf), gap] as const)

// A click at the middle of target, once it is in view and the element hit there in its own frame, sent to its
// window's target through the debugger. Waits until main heard the press and the release in before-mouse-event, else
// throws, so a click that went round main never counts. Answers the screen point main heard. Playwright's trial click
// is no check here: on a row in a plugin frame main heard it press and let go
export async function click(app: ElectronApplication, target: Locator): Promise<{ x: number, y: number }> {
  await target.scrollIntoViewIfNeeded({ timeout: 10_000 })
  const hit = await target.evaluate(element => {
    const box = element.getBoundingClientRect()
    const there = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return there !== null && element.contains(there)
  })
  if (!hit) throw new Error('another element covers the middle of the target')
  const box = await target.boundingBox()
  if (box === null) throw new Error('the target has no box to click')
  const url = target.page().url()
  const since = await mark(app)
  await app.evaluate(async ({ webContents }, [url, x, y]) => {
    const contents = webContents.getAllWebContents().find(each => each.getURL() === url)!
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    const send = (type: string, more: object) => contents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...more })
    await send('mouseMoved', { button: 'none' })
    await send('mousePressed', { button: 'left', clickCount: 1 })
    await send('mouseReleased', { button: 'left', clickCount: 1 })
  }, [url, box.x + box.width / 2, box.y + box.height / 2] as const)
  for (let waited = 0; ; waited += 25) {
    const presses = (await heard(app, since)).filter(input => input.kind === 'mouse' && input.url === url)
    if (presses.some(input => input.type === 'mouseUp')) return { x: presses[0]!.x!, y: presses[0]!.y! }
    if (waited > 2000) throw new Error(`main never heard the click on ${url}`)
    await sleep(25)
  }
}

// Where focus is: each window's focused frame as main reads it, and the active element of every page and frame
export type Focus = {
  main: { url: string, focused: boolean, focusedFrame: string | null }[]
  pages: { url: string, frames: { url: string, hasFocus: boolean, active: string | null }[] }[]
}
export async function readFocus(app: ElectronApplication, only = /^hetu:\/\/(editor|trusted)\//): Promise<Focus> {
  const main = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents => contents.getType() === 'window').map(contents => ({
    url: contents.getURL(), focused: contents.isFocused(), focusedFrame: contents.focusedFrame?.url ?? null,
  })))
  const pages: Focus['pages'] = []
  for (const page of app.windows().filter(each => only.test(each.url()))) {
    const frames = []
    for (const frame of page.frames()) {
      const read = await frame.evaluate(() => {
        const active = document.activeElement
        const named = active === null ? null : [active.tagName.toLowerCase(), active.getAttribute('role'), active.id === '' ? null : `#${active.id}`].filter(part => part !== null).join(' ')
        return { hasFocus: document.hasFocus(), active: named }
      }).catch(() => ({ hasFocus: false, active: null }))
      frames.push({ url: frame.url(), ...read })
    }
    pages.push({ url: page.url(), frames })
  }
  return { main: main.filter(window => only.test(window.url)), pages }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
