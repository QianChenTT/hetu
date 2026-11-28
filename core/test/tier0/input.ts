// Main's input route for tier 0 and the end-to-end tests: input handed to a window the way the OS hands it, through
// main's own hooks, where Playwright's keys go round them. Measured on the driven build with hidden windows:
// - Playwright's keys never reach main's before-input-event. sendInputEvent's keys do, and go to the page, never to
//   the frame holding focus
// - sendInputEvent's mouse reaches before-mouse-event with no screen point, so main's hetu:press lands at the page's
//   corner, and the event never reaches a plugin frame
// - a CDP mouse event sent to the window's own target, as Playwright's mouse also sends it, goes through the
//   browser's hit-testing like a real one: main hears it in before-mouse-event with its screen point and the frame
//   under it gets it
// - Playwright's trial click on a row in a plugin frame sends a real press and release, which main hears
// What none of them pass through is the OS: which window is under the pointer and key, the activating click, IME
import type { ElectronApplication, Frame, Locator, Page } from 'playwright'
import { coreKeyOf } from '../../api/keys.ts'
import { INPUT_DELAY_MS } from '../../api/trusted.ts'

// The routes a run names in its record
export const ROUTES = {
  keys: 'keys: sendInputEvent to the window, through main\'s before-input-event',
  frameKeys: 'frame keys: main\'s before-input-event handed each key, then CDP to the focused frame',
  mouse: 'mouse: CDP to the window\'s target after a hit check from the page down, heard by main\'s before-mouse-event and got by the target',
} as const

export type Key = { key: string, code: string, accelerator: string, vk: number, text?: string, shift: boolean, location: number }
const NAMED: Record<string, Omit<Key, 'key' | 'shift' | 'location'>> = {
  Enter: { code: 'Enter', accelerator: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', accelerator: 'Escape', vk: 27 },
  Tab: { code: 'Tab', accelerator: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', accelerator: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', accelerator: 'Delete', vk: 46 },
  Home: { code: 'Home', accelerator: 'Home', vk: 36 },
  End: { code: 'End', accelerator: 'End', vk: 35 },
  PageUp: { code: 'PageUp', accelerator: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', accelerator: 'PageDown', vk: 34 },
  ArrowUp: { code: 'ArrowUp', accelerator: 'Up', vk: 38 },
  ArrowDown: { code: 'ArrowDown', accelerator: 'Down', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', accelerator: 'Left', vk: 37 },
  ArrowRight: { code: 'ArrowRight', accelerator: 'Right', vk: 39 },
  ' ': { code: 'Space', accelerator: 'Space', vk: 32, text: ' ' },
  '\n': { code: 'Enter', accelerator: 'Enter', vk: 13, text: '\r' },
}
// US layout punctuation: the unshifted character, its physical key and virtual key code, then the shifted character
const PUNCTUATION: [string, string, number, string][] = [
  ['`', 'Backquote', 192, '~'], ['-', 'Minus', 189, '_'], ['=', 'Equal', 187, '+'], ['[', 'BracketLeft', 219, '{'],
  [']', 'BracketRight', 221, '}'], ['\\', 'Backslash', 220, '|'], [';', 'Semicolon', 186, ':'], ['\'', 'Quote', 222, '"'],
  [',', 'Comma', 188, '<'], ['.', 'Period', 190, '>'], ['/', 'Slash', 191, '?'],
]
const SHIFTED_DIGITS = ')!@#$%^&*('
// The modifier keys as pressed on their own, the left one of each
const MODIFIER_KEYS = {
  Shift: { key: 'Shift', code: 'ShiftLeft', accelerator: 'Shift', vk: 16, shift: false, location: 1 },
  Ctrl: { key: 'Control', code: 'ControlLeft', accelerator: 'Control', vk: 17, shift: false, location: 1 },
  Alt: { key: 'Alt', code: 'AltLeft', accelerator: 'Alt', vk: 18, shift: false, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', accelerator: 'Meta', vk: 91, shift: false, location: 1 },
} as const satisfies Record<string, Key>

// A key by its name or a character, as a US layout types it. Any other is refused rather than guessed
export function keyOf(name: string): Key {
  const named = NAMED[name]
  if (named !== undefined) return { key: name === '\n' ? 'Enter' : name, shift: false, location: 0, ...named }
  if (/^[a-zA-Z]$/.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, accelerator: name.toUpperCase(), vk: name.toUpperCase().charCodeAt(0), text: name, shift: name !== name.toLowerCase(), location: 0 }
  if (/^\d$/.test(name)) return { key: name, code: `Digit${name}`, accelerator: name, vk: name.charCodeAt(0), text: name, shift: false, location: 0 }
  const digit = SHIFTED_DIGITS.indexOf(name)
  if (digit !== -1) return { key: name, code: `Digit${digit}`, accelerator: String(digit), vk: 48 + digit, text: name, shift: true, location: 0 }
  const mark = PUNCTUATION.find(([plain, , , shifted]) => name === plain || name === shifted)
  if (mark !== undefined) return { key: name, code: mark[1], accelerator: mark[0], vk: mark[2], text: name, shift: name === mark[3], location: 0 }
  throw new Error(`tier 0's input route has no key ${JSON.stringify(name)}`)
}

export type Chord = { key: Key, meta: boolean, control: boolean, alt: boolean, shift: boolean }
// A chord such as Mod+S or Mod++: Mod is Cmd on macOS and Ctrl elsewhere. A single character is that key alone
export function chordOf(chord: string, mac = process.platform === 'darwin'): Chord {
  const split = chord.length > 1 && chord.endsWith('+') ? [...chord.slice(0, -2).split('+').filter(part => part !== ''), '+'] : chord.length === 1 ? [chord] : chord.split('+')
  const last = split.at(-1)!
  const key = keyOf(last.length === 1 && split.length > 1 ? last.toLowerCase() : last)
  const mods = new Set(split.slice(0, -1).map(mod => (mod === 'Mod' ? (mac ? 'Meta' : 'Ctrl') : mod)))
  const unknown = [...mods].filter(mod => !['Meta', 'Ctrl', 'Alt', 'Shift'].includes(mod))
  if (unknown.length > 0) throw new Error(`tier 0's input route has no modifier ${unknown.join(', ')}`)
  return { key, meta: mods.has('Meta'), control: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift') || key.shift }
}

// What main heard in before-input-event and before-mouse-event on every window from now on, the harness's own
// handing of a key included. Mouse presses and releases only. prevented is whether any of main's handlers called
// preventDefault: the watch is prepended, so it runs first on each event and wraps the event's preventDefault, which
// every later handler calls. A handler main adds after the watch still goes through the wrap
export type Heard = { at: number, url: string, kind: 'key' | 'mouse', type: string, key?: string, meta?: boolean, control?: boolean, x?: number, y?: number, prevented: boolean }
export const watchInput = (app: ElectronApplication) => app.evaluate(({ app, webContents }) => {
  const scope = globalThis as unknown as { tier0Heard?: unknown[] }
  if (scope.tier0Heard !== undefined) return
  const heard: unknown[] = scope.tier0Heard = []
  const noted = (event: { preventDefault(): void }, entry: Record<string, unknown>) => {
    const full = { at: heard.length, ...entry, prevented: false }
    heard.push(full)
    const prevent = event.preventDefault.bind(event)
    event.preventDefault = () => {
      full.prevented = true
      prevent()
    }
  }
  const watch = (contents: Electron.WebContents) => {
    contents.prependListener('before-input-event', (event, input) => noted(event, { url: contents.getURL(), kind: 'key', type: input.type, key: input.key, meta: input.meta, control: input.control }))
    contents.prependListener('before-mouse-event', (event, mouse) => {
      if (mouse.type === 'mouseDown' || mouse.type === 'mouseUp') noted(event, { url: contents.getURL(), kind: 'mouse', type: mouse.type, x: mouse.globalX, y: mouse.globalY })
    })
  }
  for (const contents of webContents.getAllWebContents()) watch(contents)
  app.on('web-contents-created', (_event, contents) => watch(contents))
})
// Where the watch stands now, to read what came after
export const mark = (app: ElectronApplication) => app.evaluate(() => ((globalThis as unknown as { tier0Heard?: unknown[] }).tier0Heard ?? []).length)
// What main heard since a mark, only on url or only of kind when given, filtered in main
export const heard = (app: ElectronApplication, since = 0, only: { url?: string, kind?: Heard['kind'] } = {}) => app.evaluate((_electron, [from, only]) => {
  const all = ((globalThis as unknown as { tier0Heard?: Heard[] }).tier0Heard ?? [])
  const found: Heard[] = []
  for (let at = from; at < all.length; at++) {
    const each = all[at]!
    if ((only.url === undefined || each.url === only.url) && (only.kind === undefined || each.kind === only.kind)) found.push(each)
  }
  return found
}, [since, only] as const)

// Main's keys go to the page, so with focus in a frame only a core key, which main takes for the page, reaches
// anything. Any other key is refused here, pointing at frameKeys
async function refuseInFrame(app: ElectronApplication, page: Page, what: string): Promise<void> {
  const frame = await app.evaluate(({ webContents }, url) => {
    const focused = webContents.getAllWebContents().find(each => each.getURL() === url)!.focusedFrame
    return focused !== null && focused !== undefined && focused.parent !== null ? focused.url : null
  }, page.url())
  if (frame !== null) throw new Error(`${what} would go to the page while focus is in the frame ${frame}: type into a frame with frameKeys`)
}
const isCore = (chord: Chord, mac = process.platform === 'darwin') =>
  coreKeyOf({ key: chord.key.key, code: chord.key.code, ctrlKey: chord.control, metaKey: chord.meta, altKey: chord.alt, shiftKey: chord.shift }, mac) !== null

// Keys typed into the page with focus, each a keyDown, its char and a keyUp, gap ms apart
export async function keys(app: ElectronApplication, page: Page, text: string, gap = 20): Promise<void> {
  await refuseInFrame(app, page, `typing ${JSON.stringify(text)}`)
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
export async function press(app: ElectronApplication, page: Page, chord: string): Promise<void> {
  const pressed = chordOf(chord)
  if (!isCore(pressed)) await refuseInFrame(app, page, chord)
  await app.evaluate(({ webContents }, [url, pressed]) => {
    const contents = webContents.getAllWebContents().find(each => each.getURL() === url)!
    const modifiers = (['meta', 'control', 'alt', 'shift'] as const).filter(mod => pressed[mod])
    contents.sendInputEvent({ type: 'keyDown', keyCode: pressed.key.accelerator, modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode: pressed.key.accelerator, modifiers })
  }, [page.url(), pressed] as const)
}

// Keys Playwright sends never pass the window's before-input-event, and keys sent with sendInputEvent pass it but go
// to the page and never to a frame. So main's own handler is handed each key as the window's input would hand it and,
// when it lets the key go on, the debugger sends it in the same task to the frame holding focus, as the browser sends
// a key main let go on. A chord's modifiers go down before its key and up after it, each through main the same way.
// gap is the time between keys, 0 for a burst. Answers where in the keys each key main dropped stood. A string is
// typed a character at a time, a list names each key or chord. page is the window, the editor's by default
export const typeThroughMain = (app: ElectronApplication, typed: string | readonly string[], gap: number, page?: Page) => app.evaluate(async ({ webContents }, [all, wait, url]) => {
  const contents = webContents.getAllWebContents().find(each => each.getURL() === url)
  if (contents === undefined) throw new Error(`no window shows ${url}`)
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  const dropped: number[] = []
  // Every send is awaited, but only once all keys went: a keyboard doesn't wait for the page to take a key before the
  // next, and a page held busy would otherwise hold the typing back with it
  const sends: Promise<unknown>[] = []
  for (const [at, { key: main, modifiers: held, flags }] of all.entries()) {
    let down = 0
    const pass = (key: typeof main, type: 'keyDown' | 'keyUp', mods: typeof flags) => {
      let prevented = false
      const input = { type, key: key.key, code: key.code, control: mods.control, meta: mods.meta, alt: mods.alt, shift: mods.shift, isAutoRepeat: false, isComposing: false, location: key.location }
      contents.emit('before-input-event', { preventDefault: () => { prevented = true } }, input)
      if (prevented) return false
      const bits = (mods.alt ? 1 : 0) | (mods.control ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0)
      const plain = !mods.control && !mods.meta && !mods.alt
      const text = type === 'keyDown' && key.text !== undefined && plain ? { text: key.text } : {}
      sends.push(contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: type === 'keyDown' && text.text === undefined ? 'rawKeyDown' : type, key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, modifiers: bits, location: key.location, ...text }))
      return true
    }
    // Each modifier down in turn, with the flags of those down so far, then the key with all of them
    const so = { control: false, meta: false, alt: false, shift: false }
    for (const [flag, key] of held) {
      so[flag] = true
      pass(key, 'keyDown', { ...so })
      down++
    }
    if (!pass(main, 'keyDown', flags)) dropped.push(at)
    pass(main, 'keyUp', flags)
    for (const [flag, key] of held.slice(0, down).reverse()) {
      so[flag] = false
      pass(key, 'keyUp', { ...so })
    }
    await new Promise(resolve => setTimeout(resolve, wait))
  }
  try {
    await Promise.all(sends)
  } catch (err) {
    throw new Error(contents.debugger.isAttached() ? `CDP refused a key: ${String(err)}` : `the debugger on ${url} detached: DevTools opened or the page went away`)
  }
  return dropped
}, [(typeof typed === 'string' ? [...typed] : typed).map(each => {
  const chord = chordOf(each)
  const held = (['control', 'alt', 'meta', 'shift'] as const).filter(flag => chord[flag]).map(flag => [flag, MODIFIER_KEYS[({ control: 'Ctrl', alt: 'Alt', meta: 'Meta', shift: 'Shift' } as const)[flag]]] as const)
  return { key: chord.key, modifiers: held, flags: { control: chord.control, meta: chord.meta, alt: chord.alt, shift: chord.shift } }
}), gap, page?.url() ?? 'hetu://editor/'] as const)

// Main dropped the click: its handler prevented the press, as the trusted window's input delay does
export class Dropped extends Error {}

export type Clicked = { x: number, y: number, page: { x: number, y: number }, intended: { x: number, y: number } }

// Hit check from the page down: at each frame on the way the element hit at the point is the next frame's element,
// and in the target's own frame the target or what it holds, open shadow roots entered. Answers what was hit instead
const hitFromPage = async (page: Page, target: Locator, at: { x: number, y: number }): Promise<string | null> => {
  const handle = await target.elementHandle({ timeout: 10_000 })
  if (handle === null) return 'nothing'
  const chain: Frame[] = []
  for (let frame = await handle.ownerFrame(); frame !== null && frame !== page.mainFrame(); frame = frame.parentFrame()) chain.unshift(frame)
  let point = at
  for (const frame of [...chain.map(child => ({ child })), { child: null }]) {
    const element = frame.child === null ? handle : await frame.child.frameElement()
    const found: { miss: string } | { next: { x: number, y: number } } = await element.evaluate((node, [point, isFrame]) => {
      const wanted = node as Element
      let hit = wanted.ownerDocument.elementFromPoint(point.x, point.y)
      while (hit?.shadowRoot !== null && hit?.shadowRoot !== undefined) {
        const inner = hit.shadowRoot.elementFromPoint(point.x, point.y)
        if (inner === null || inner === hit) break
        hit = inner
      }
      const name = hit === null ? 'nothing' : `${hit.tagName.toLowerCase()}${hit.id === '' ? '' : `#${hit.id}`}`
      if (hit === null || (isFrame ? hit !== wanted : !wanted.contains(hit) && hit !== wanted)) return { miss: name }
      const box = wanted.getBoundingClientRect()
      const style = getComputedStyle(wanted)
      return { next: { x: point.x - box.left - wanted.clientLeft - parseFloat(style.paddingLeft), y: point.y - box.top - wanted.clientTop - parseFloat(style.paddingTop) } }
    }, [point, frame.child !== null] as const)
    if ('miss' in found) return frame.child === null ? found.miss : `${found.miss}, outside the box of the frame ${frame.child.url()}`
    point = found.next
  }
  return null
}

// A click at the middle of target sent to its window's target through the debugger, as Playwright's mouse sends one.
// Before it: the target enabled, its box the same two frames running and the hit check from the page down. After it:
// main heard exactly one press then one release on the window at the intended point, main let both through, and the
// target got pointerdown and pointerup. Any of those failing throws naming which, Dropped for a press main prevented.
// Playwright's trial click is no check here, since in a plugin frame it presses for real. emit is an event main emits
// on the target's window in the same task as the press, as the window gaining focus emits it, so the press lands
// inside whatever the event starts. A press it starts no delay for is dropped no differently. holdMs holds the press
// that long before the release, as a long press
export type ClickOptions = { emit?: 'focus', holdMs?: number }
export async function click(app: ElectronApplication, target: Locator, timeout = 10_000, options: ClickOptions = {}): Promise<Clicked> {
  const page = target.page()
  const url = page.url()
  await target.scrollIntoViewIfNeeded({ timeout })
  let box: { x: number, y: number, width: number, height: number } | null = null
  for (const end = Date.now() + timeout; ; await sleep(50)) {
    const disabled = await target.evaluate(element => (element as HTMLButtonElement).disabled === true || element.closest('[aria-disabled="true"]') !== null)
    const first = await target.boundingBox()
    await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const second = await target.boundingBox()
    const stable = first !== null && second !== null && JSON.stringify(first) === JSON.stringify(second)
    if (!disabled && stable) {
      box = second
      break
    }
    if (Date.now() > end) throw new Error(disabled ? 'the target stayed disabled' : 'the target never held still: its box moved between two frames')
  }
  const intended = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const missed = await hitFromPage(page, target, intended)
  if (missed !== null) throw new Error(`the middle of the target hits ${missed}, not the target`)
  const token = `t${Math.random().toString(36).slice(2)}`
  const handle = (await target.elementHandle())!
  const frame = (await handle.ownerFrame())!
  await handle.evaluate((element, token) => {
    const got = { down: 0, up: 0 }
    Object.assign(window, { [token]: got })
    for (const [type, field] of [['pointerdown', 'down'], ['pointerup', 'up']] as const) {
      window.addEventListener(type, event => {
        if (event.composedPath().includes(element)) got[field]++
      }, true)
    }
  }, token)
  const since = await mark(app)
  const emitted = await app.evaluate(async ({ webContents, BrowserWindow }, [url, x, y, emit, hold]) => {
    const contents = webContents.getAllWebContents().find(each => each.getURL() === url)!
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    const send = (type: string, more: object) => contents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...more })
    let at: number | null = null
    let gap: number | null = null
    try {
      await send('mouseMoved', { button: 'none' })
      if (emit !== null) {
        BrowserWindow.fromWebContents(contents)!.emit(emit)
        at = Date.now()
      }
      await send('mousePressed', { button: 'left', clickCount: 1 })
      // On main's clock, from the event to the press handed through main's handlers
      if (at !== null) gap = Date.now() - at
      if (hold > 0) await new Promise(resolve => setTimeout(resolve, hold))
      await send('mouseReleased', { button: 'left', clickCount: 1 })
    } catch (err) {
      throw new Error(contents.debugger.isAttached() ? `CDP refused the click: ${String(err)}` : `the debugger on ${url} detached: DevTools opened or the page went away`)
    }
    return gap
  }, [url, intended.x, intended.y, options.emit ?? null, options.holdMs ?? 0] as const)
  if (emitted !== null && emitted >= INPUT_DELAY_MS) throw new Error(`a harness miss: the press reached main ${emitted} ms after the emitted ${options.emit}, past the ${INPUT_DELAY_MS} ms a delay it started runs`)
  let presses: Heard[] = []
  for (const end = Date.now() + 2000; !presses.some(input => input.type === 'mouseUp'); await sleep(25)) {
    if (Date.now() > end) throw new Error(`main never heard the click on ${url}`)
    presses = await heard(app, since, { url, kind: 'mouse' })
  }
  if (presses.map(input => input.type).join() !== 'mouseDown,mouseUp') throw new Error(`main heard ${presses.map(input => input.type).join(', ')} for one click on ${url}`)
  if (presses.some(input => input.prevented)) throw new Dropped(`main dropped the click on ${url}`)
  const seen = await app.evaluate(({ BrowserWindow, webContents }, [url, x, y]) => {
    const contents = webContents.getAllWebContents().find(each => each.getURL() === url)!
    const content = BrowserWindow.fromWebContents(contents)!.getContentBounds()
    const zoom = contents.getZoomFactor()
    return { x: (x - content.x) / zoom, y: (y - content.y) / zoom }
  }, [url, presses[0]!.x!, presses[0]!.y!] as const)
  if (Math.abs(seen.x - intended.x) > 1 || Math.abs(seen.y - intended.y) > 1) throw new Error(`main heard the click at ${JSON.stringify(seen)} on the page, not at ${JSON.stringify(intended)}`)
  let got = { down: 0, up: 0 }
  for (const end = Date.now() + 2000; got.down === 0 || got.up === 0; await sleep(25)) {
    if (Date.now() > end) break
    got = await frame.evaluate(token => (window as unknown as Record<string, { down: number, up: number }>)[token]!, token).catch(() => got)
  }
  if (got.down !== 1 || got.up !== 1) throw new Error(`main heard the click but the target got ${got.down} pointerdown and ${got.up} pointerup: something over it took the click`)
  return { x: presses[0]!.x!, y: presses[0]!.y!, page: seen, intended }
}

// Lets go of every debugger the route attached, so a quit doesn't leave one on a closing window
export const detachDebuggers = (app: ElectronApplication) => app.evaluate(({ webContents }) => {
  for (const contents of webContents.getAllWebContents()) if (contents.debugger.isAttached()) contents.debugger.detach()
})

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
