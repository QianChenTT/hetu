import type { Change } from '../../api/changes.ts'
import { INPUT_DELAY_MS } from '../../api/trusted.ts'
import { type Bridge, choiceChange, type Choice, type PluginAction, type Screen, TrustedPage } from './view.ts'

// The preload's bridge, there only in the window's top frame
const bridge = (window as unknown as { hetu?: Bridge }).hetu

// Every string goes in as text, never markup
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  if (text !== undefined) made.textContent = text
  return made
}

function button(text: string, act: () => void): HTMLButtonElement {
  const made = element('button', text)
  made.type = 'button'
  made.addEventListener('click', act)
  return made
}

// Confirm stays disabled for the input delay after the window shows or gains focus. Main drops the input anyway, this
// only shows it
let armedAt = performance.now() + INPUT_DELAY_MS
const confirms = new Set<HTMLButtonElement>()
const typedOk = new WeakMap<HTMLButtonElement, () => boolean>()
function arm(): void {
  const armed = performance.now() >= armedAt
  for (const confirm of confirms) confirm.disabled = !armed || !(typedOk.get(confirm)?.() ?? true)
  if (!armed) setTimeout(arm, armedAt - performance.now() + 10)
}
window.addEventListener('focus', () => {
  armedAt = performance.now() + INPUT_DELAY_MS
  arm()
})
// A new request drawn under Confirm waits the delay too, as the core does, so a click aimed at the one before can't land
let drawnRequest: string | null = null

function draw(page: TrustedPage, shown: Screen, note: string | null): void {
  const root = document.getElementById('root')
  if (root === null) return
  confirms.clear()
  const parts: HTMLElement[] = []

  if (shown.stopped !== null) {
    const section = element('section')
    section.className = 'stopped'
    for (const line of shown.stopped.lines) section.append(element('p', line))
    const { control } = shown.stopped
    const labels: Record<Choice, string> = { 'switch-off': 'Start with it switched off', recover: 'Recover', quit: 'Quit' }
    for (const choice of shown.stopped.choices) {
      section.append(button(labels[choice], () => {
        const change = choiceChange(control, choice)
        if (change === null) page.quit()
        else page.ask(change)
      }))
    }
    parts.push(section)
  }

  if (shown.request !== null) {
    const request = shown.request
    if (request.id !== drawnRequest) armedAt = Math.max(armedAt, performance.now() + INPUT_DELAY_MS)
    drawnRequest = request.id
    const section = element('section')
    section.className = 'request'
    section.append(element('h1', request.text))
    const notes = element('ul')
    for (const line of request.notes) notes.append(element('li', line))
    section.append(notes)
    let typed: HTMLInputElement | null = null
    if (request.type !== null) {
      const label = element('label', `Type ${request.type} to confirm `)
      typed = element('input')
      typed.autocomplete = 'off'
      typed.spellcheck = false
      typed.addEventListener('input', arm)
      label.append(typed)
      section.append(label)
    }
    const confirm = button('Confirm', () => page.confirm(request.id, typed?.value))
    confirms.add(confirm)
    if (typed !== null) typedOk.set(confirm, () => typed.value === request.type)
    section.append(confirm, button('Cancel', () => page.cancel(request.id)))
    if (shown.behind > 0) section.append(element('p', `${shown.behind} more waiting`))
    parts.push(section)
  }

  if (note !== null) {
    const shownNote = element('p', note)
    shownNote.className = 'note'
    parts.push(shownNote)
  }

  if (shown.stopped === null) {
    const list = element('section')
    list.className = 'plugins'
    list.append(element('h2', 'Plugins'))
    for (const plugin of shown.plugins) {
      const row = element('div')
      row.className = 'plugin'
      row.append(element('p', plugin.line))
      for (const action of plugin.actions) row.append(button(actionLabels[action], () => act(page, plugin.id, action)))
      for (const item of plugin.items) {
        const line = element('p', item.line)
        line.className = 'item'
        line.append(button(item.on ? 'Switch off' : 'Switch on', () => page.ask({
          kind: item.on ? 'item.off' : 'item.on', plugin: plugin.id, capability: item.capability,
        } as Change)))
        row.append(line)
      }
      list.append(row)
    }
    parts.push(list)

    const switches = element('section')
    switches.append(element('h2', 'Switches'))
    for (const line of shown.switches) switches.append(element('p', line))
    switches.append(element('p', 'hetu recommends keeping every security plugin on'))
    parts.push(switches)

    parts.push(button('Restart hetu', () => page.relaunch()))
    parts.push(button('Quit', () => page.quit()))
  }

  root.replaceChildren(...parts)
  arm()
}

const actionLabels: Record<PluginAction, string> = {
  approve: 'Approve', 'switch-on': 'Switch on', 'switch-off': 'Switch off', stop: 'Stop', restart: 'Restart',
  reset: 'Reset', restore: 'Restore', remove: 'Remove',
}

function act(page: TrustedPage, plugin: string, action: PluginAction): void {
  if (action === 'stop') return page.stop(plugin)
  if (action === 'restart') return page.restart(plugin)
  const kinds = {
    approve: 'plugin.approve', 'switch-on': 'plugin.on', 'switch-off': 'plugin.off', reset: 'plugin.reset',
    restore: 'plugin.restore', remove: 'plugin.remove',
  } as const
  page.ask({ kind: kinds[action], plugin })
}

if (bridge !== undefined) {
  const page: TrustedPage = new TrustedPage(bridge, (shown, note) => draw(page, shown, note))
  page.start()
}
