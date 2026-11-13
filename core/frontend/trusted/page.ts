import type { Change } from '../../api/changes.ts'
import { INPUT_DELAY_MS } from '../../api/trusted.ts'
import { type Bridge, choiceChange, type Choice, limitChange, type PluginAction, type Screen, type Switch, TrustedPage } from './view.ts'

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

// A switch's line with the button that asks for its change
function switchLine(page: TrustedPage, row: Switch, className?: string): HTMLParagraphElement {
  const line = element('p', row.line)
  if (className !== undefined) line.className = className
  const { change } = row
  if (change !== null) line.append(button('on' in change && change.on ? 'Switch on' : 'Switch off', () => page.ask(change)))
  return line
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
      for (const own of plugin.switches) row.append(switchLine(page, own, 'item'))
      list.append(row)
    }
    parts.push(list)

    const switches = element('section')
    switches.append(element('h2', 'Switches'))
    for (const row of shown.switches) switches.append(switchLine(page, row))
    switches.append(element('p', 'hetu recommends keeping every security plugin on'))
    parts.push(switches)

    const luoshu = element('section')
    luoshu.className = 'luoshu'
    luoshu.append(element('h2', 'Notes'))
    const folderLine = element('p', shown.luoshu)
    folderLine.append(button('Pick a folder', () => page.pickFolder()))
    luoshu.append(folderLine, element('p', 'A new folder waits for your Confirm'))
    parts.push(luoshu)

    const install = element('section')
    install.className = 'install'
    install.append(element('h2', 'Install'), element('p', shown.install))
    parts.push(install)

    const limits = element('section')
    limits.className = 'limits'
    limits.append(element('h2', 'Limits'))
    limits.append(element('p', 'Each runs at the floor’s value unless you set one, for all plugins or for one. Every change waits for your Confirm'))
    for (const limit of shown.limits) {
      const row = element('div')
      row.className = 'limit'
      const set = [...(limit.all !== null ? [`all: ${limit.all}`] : []), ...limit.plugins.map(one => `${one.plugin}: ${one.value}`)]
      row.append(element('p', [limit.constant, `floor ${limit.floor}`, ...set].join(' · ')))
      const value = element('input')
      value.inputMode = 'numeric'
      value.autocomplete = 'off'
      value.spellcheck = false
      value.setAttribute('aria-label', `New value for ${limit.constant}`)
      const who = element('select')
      who.setAttribute('aria-label', `Who ${limit.constant} is set for`)
      who.append(new Option('all plugins', ''))
      for (const plugin of shown.plugins) who.append(new Option(plugin.id, plugin.id))
      row.append(value, who, button('Set', () => {
        const change = limitChange(limit.constant, value.value, who.value === '' ? null : who.value)
        if (change === null) page.say('Type a whole number from 1 up')
        else page.ask(change)
      }))
      limits.append(row)
    }
    parts.push(limits)

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
