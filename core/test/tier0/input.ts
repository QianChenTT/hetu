// Main's input route for tier 0 and the end-to-end tests: input handed to a window the way the OS hands it, through
// main's own hooks, where Playwright's keys go round them
import type { ElectronApplication } from 'playwright'

// Keys Playwright sends never pass the window's before-input-event, and keys sent with sendInputEvent pass it but go
// to the page and never to a frame. So main's own handler is handed each key as the window's input would hand it and,
// when it lets the key go on, the debugger sends it in the same task to the frame holding focus, as the browser sends
// a key main let go on. gap is the time between keys, 0 for a burst. Answers where in text each key main dropped stood
export const typeThroughMain = (app: ElectronApplication, text: string, gap: number) => app.evaluate(async ({ webContents }, [typed, wait]) => {
  const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  const dropped: number[] = []
  for (const [at, key] of [...typed].entries()) {
    const code = `Key${key.toUpperCase()}`
    const windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0)
    for (const type of ['keyDown', 'keyUp'] as const) {
      let prevented = false
      const input = { type, key, code, control: false, meta: false, alt: false, shift: false, isAutoRepeat: false }
      contents.emit('before-input-event', { preventDefault: () => { prevented = true } }, input)
      if (prevented && type === 'keyDown') dropped.push(at)
      if (prevented) continue
      const sent = type === 'keyDown' ? { type, key, code, text: key, windowsVirtualKeyCode } : { type, key, code, windowsVirtualKeyCode }
      void contents.debugger.sendCommand('Input.dispatchKeyEvent', sent)
    }
    await new Promise(resolve => setTimeout(resolve, wait))
  }
  return dropped
}, [text, gap] as const)
