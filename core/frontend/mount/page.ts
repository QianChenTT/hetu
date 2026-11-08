import { type Bridge, Shell } from './shell.ts'

// The preload's bridge, there only in the window's top frame
const bridge = (window as unknown as { hetu?: Bridge }).hetu

// Each line as text, never markup
function draw(lines: string[]): void {
  const banner = document.getElementById('banner')
  if (banner === null) return
  banner.replaceChildren(...lines.map(line => {
    const item = document.createElement('li')
    item.textContent = line
    return item
  }))
  banner.hidden = lines.length === 0
}

if (bridge !== undefined) new Shell(bridge, draw).start()
