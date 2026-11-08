import { type Bridge, type Notice, Shell } from './shell.ts'

// The preload's bridge, there only in the window's top frame
const bridge = (window as unknown as { hetu?: Bridge }).hetu

// Each line and notice as text, never markup. A notice is a button that opens the trusted window at its request
function draw(shell: Shell, lines: string[], notices: Notice[]): void {
  const banner = document.getElementById('banner')
  if (banner !== null) {
    banner.replaceChildren(...lines.map(line => {
      const item = document.createElement('li')
      item.textContent = line
      return item
    }))
    banner.hidden = lines.length === 0
  }
  const shown = document.getElementById('notices')
  if (shown === null) return
  shown.replaceChildren(...notices.map(notice => {
    const item = document.createElement('button')
    item.type = 'button'
    item.textContent = notice.text
    item.addEventListener('click', () => shell.open(notice.id))
    return item
  }))
  shown.hidden = notices.length === 0
}

if (bridge !== undefined) {
  const shell: Shell = new Shell(bridge, (lines, notices) => draw(shell, lines, notices))
  document.getElementById('security')?.addEventListener('click', () => shell.open())
  shell.start()
}
