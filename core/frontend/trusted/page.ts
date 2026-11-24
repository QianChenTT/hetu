import type { Change } from '../../api/changes.ts'
import { INPUT_DELAY_MS } from '../../api/trusted.ts'
import { Arming } from './arming.ts'
import { controlKey, sameControl } from './focus.ts'
import { installSay, type InstallBox } from './install.ts'
import type { Startup } from './startup.ts'
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

// A field in quotes, drawn in a fixed-width face that wraps anywhere, so I and l read apart and its end stays in view
// however long it is
function labelOf(text: string): HTMLSpanElement {
  const made = element('span', text)
  made.className = 'label'
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

// Confirm stays disabled for the input delay after the window shows or gains focus and after something new is drawn
// under it, and while what it confirms isn't ready
const arming = new Arming(() => performance.now(), INPUT_DELAY_MS)
const confirms = new Set<HTMLButtonElement>()
const ready = new WeakMap<HTMLButtonElement, () => boolean>()
function arm(): void {
  const wait = arming.wait()
  for (const confirm of confirms) confirm.disabled = wait > 0 || !(ready.get(confirm)?.() ?? true)
  if (wait > 0) setTimeout(arm, wait + 10)
}
window.addEventListener('focus', () => {
  arming.focused()
  arm()
})

// What was typed in each link field, kept across draws
const typedLinks = new Map<string, string>()

// The Install button's controls: main's dialog for a zip or a folder, or a link whose release the core looks up
function installControls(page: TrustedPage, field: string, words: string, suggested: string): HTMLDivElement {
  const controls = element('div')
  controls.className = 'install-controls'
  const label = element('label', `${words} `)
  const link = element('input')
  link.type = 'url'
  link.autocomplete = 'off'
  link.spellcheck = false
  link.value = typedLinks.get(field) ?? suggested
  link.dataset.key = `link:${field}`
  link.addEventListener('input', () => typedLinks.set(field, link.value))
  label.append(link)
  controls.append(
    button('Install from a zip', () => page.installer.pick('zip')), button('Install from a folder', () => page.installer.pick('folder')),
    label, button('Find its release', () => page.installer.find(link.value)),
  )
  return controls
}

// A release's zips to pick from, or the plugins found with a box to tick each and its grants as sentences, then
// Install, which waits the delay like a Confirm since its request can apply at once
function installSection(page: TrustedPage, box: InstallBox): HTMLElement {
  const section = element('section')
  section.className = 'request installing'
  const heading = element('h1', box.step === 'assets' ? box.heading : 'Install these plugins')
  heading.id = 'installing-heading'
  section.setAttribute('aria-labelledby', heading.id)
  section.append(heading)
  if (box.step === 'assets') {
    for (const [place, asset] of box.assets.entries()) section.append(button(asset.line, () => page.installer.asset(place)))
    section.append(button('Cancel', () => page.installer.cancel()))
    return section
  }
  const unsigned = element('p', box.unsigned)
  unsigned.className = 'unsigned'
  section.append(element('p', box.source), unsigned)
  for (const row of box.plugins) {
    const group = element('fieldset')
    const legend = element('legend')
    const label = element('label')
    const tick = element('input')
    tick.type = 'checkbox'
    tick.dataset.key = `tick:${row.id}`
    tick.checked = row.picked
    tick.disabled = row.problem !== null || box.busy
    tick.addEventListener('change', () => page.installer.tick(row.id, tick.checked))
    label.append(tick, document.createTextNode(` ${row.label}`))
    legend.append(label)
    const grants = element('ul')
    grants.setAttribute('aria-label', `What ${row.id} may do`)
    for (const grant of row.grants) grants.append(element('li', grant))
    const risk = element('p', row.line)
    if (row.high) risk.className = 'high'
    group.append(legend, risk, grants)
    if (row.lines.length > 0) {
      const why = element('ul')
      why.className = 'why'
      why.setAttribute('aria-label', `Why ${row.id} has its class`)
      for (const line of row.lines) why.append(element('li', line))
      group.append(why)
    }
    if (row.problem !== null) {
      const why = element('p', row.problem)
      why.className = 'note'
      group.append(why)
    }
    section.append(group)
  }
  section.append(element('p', 'Install asks for your Confirm on each plugin ticked with what it may do. The Confirm copies them into the plugin folder and approves them'))
  // The staging drawn goes with the click, so a newer one never installs from a click on this one
  const confirm = button('Install', () => page.installer.install(box.staged))
  confirms.add(confirm)
  ready.set(confirm, () => box.ready && !box.busy)
  section.append(confirm, button('Cancel', () => page.installer.cancel()))
  return section
}

// The page's own menu, which shows the startup screen again
function menu(page: TrustedPage): HTMLDetailsElement {
  const made = element('details')
  made.className = 'menu'
  made.append(element('summary', 'Menu'), button('Show the startup screen again', () => page.showStartup()))
  return made
}

// The four steps above the rest, each with what it has done and the control it offers, then Close for now
function startupSection(page: TrustedPage, startup: Startup): HTMLElement {
  const section = element('section')
  section.className = 'startup'
  const heading = element('h2', 'Start with hetu in four steps')
  heading.id = 'startup-heading'
  section.setAttribute('aria-labelledby', heading.id)
  const steps = element('ol')
  for (const step of startup.steps) {
    const item = element('li')
    item.append(element('h3', step.title), ...step.lines.map(line => element('p', line)))
    if (step.done !== null) {
      const done = element('p', step.done)
      done.className = 'done'
      item.append(done)
    }
    if (step.offers === 'folder') item.append(button('Pick a folder', () => page.pickFolder()))
    if (step.offers === 'install') item.append(installControls(page, 'startup', 'or from a GitHub link, a suggestion to edit or replace', startup.suggested))
    steps.append(item)
  }
  section.append(heading, steps, button('Close for now', () => page.closeStartup()))
  return section
}

function draw(page: TrustedPage, shown: Screen, note: string | null): void {
  const root = document.getElementById('root')
  if (root === null) return
  confirms.clear()
  arming.show('request', shown.request?.id ?? null)
  arming.show('staging', shown.installing?.step === 'found' ? shown.installing.staged : null)
  const parts: HTMLElement[] = []

  if (shown.stopped === null) parts.push(menu(page))
  if (shown.startup !== null) parts.push(startupSection(page, shown.startup))

  if (shown.stopped !== null) {
    const section = element('section')
    section.className = 'stopped'
    for (const line of shown.stopped.lines) section.append(element('p', line))
    const { control } = shown.stopped
    const labels: Record<Choice, string> = { retry: 'Try again', 'switch-off': 'Start with it switched off', quit: 'Quit' }
    for (const choice of shown.stopped.choices) {
      section.append(button(labels[choice], () => {
        const change = choiceChange(control, choice)
        if (change !== null) page.ask(change)
        else if (choice === 'retry') page.relaunch()
        else page.quit()
      }))
    }
    parts.push(section)
  }

  if (shown.request !== null) {
    const request = shown.request
    const section = element('section')
    section.className = 'request'
    const heading = element('h1')
    heading.append(...request.heading.map(part => (part.label ? labelOf(part.text) : document.createTextNode(part.text))))
    section.append(heading)
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
    if (typed !== null) ready.set(confirm, () => typed.value === request.type)
    section.append(confirm, button('Cancel', () => page.cancel(request.id)))
    // A revoke narrows, so it applies at once with no delay: the ask goes and the label never asks again
    const { revoke } = request
    if (revoke !== null) section.append(button('Cancel and revoke', () => page.ask(revoke)))
    if (shown.behind > 0) section.append(element('p', `${shown.behind} more waiting`))
    parts.push(section)
  }

  if (shown.installing !== null) parts.push(installSection(page, shown.installing))

  if (note !== null) {
    const shownNote = element('p', note)
    shownNote.className = 'note'
    parts.push(shownNote)
  }

  if (shown.stopped === null) {
    const list = element('section')
    list.className = 'plugins'
    list.append(element('h2', 'Plugins'), installControls(page, 'list', 'or from a GitHub link', ''))
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

    // Dev mode is a group of settings, each loosening what loads
    const dev = element('section')
    dev.append(element('h2', 'Dev'))
    for (const row of shown.dev) dev.append(switchLine(page, row))
    parts.push(dev)

    const luoshu = element('section')
    luoshu.className = 'luoshu'
    luoshu.append(element('h2', 'Notes'))
    const folderLine = element('p', shown.luoshu)
    folderLine.append(button('Pick a folder', () => page.pickFolder()))
    luoshu.append(folderLine, element('p', 'A new folder waits for your Confirm'))
    parts.push(luoshu)

    const identities = element('section')
    identities.className = 'identities'
    identities.append(element('h2', 'Identities'), element('p', shown.identities.about))
    for (const row of shown.identities.rows) {
      const line = element('p')
      line.className = 'identity'
      line.append(labelOf(row.label), document.createTextNode(row.line))
      const { change } = row
      if (change !== null) line.append(button('Revoke', () => page.ask(change)))
      identities.append(line)
    }
    parts.push(identities)

    const install = element('section')
    install.className = 'install'
    install.append(element('h2', 'Install'), element('p', shown.installNote))
    parts.push(install)

    const limits = element('section')
    limits.className = 'limits'
    limits.append(element('h2', 'Limits'))
    limits.append(element('p', 'Each runs at the fixed value unless you set one, for all plugins or for one. Every change waits for your Confirm'))
    for (const limit of shown.limits) {
      const row = element('div')
      row.className = 'limit'
      const set = [...(limit.all !== null ? [`all: ${limit.all}`] : []), ...limit.plugins.map(one => `${one.plugin}: ${one.value}`)]
      row.append(element('p', [limit.constant, `fixed ${limit.fixed}`, ...set].join(' · ')))
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

  const focused = focusedIn(root)
  root.replaceChildren(...parts)
  if (focused !== null) refocus(root, focused)
  say(note ?? installSay(shown.installing))
  arm()
}

const CONTROLS = 'button, input, select, summary'
type Focused = { key: string, nth: number, start: number | null, end: number | null }

// The control that has focus in the page, by its key and its place among its namesakes, with the caret of a field
function focusedIn(root: HTMLElement): Focused | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null
  const key = controlKey(active)
  const controls = [...root.querySelectorAll<HTMLElement>(CONTROLS)]
  const nth = controls.filter(control => controlKey(control) === key).indexOf(active)
  const field = active instanceof HTMLInputElement && active.type !== 'checkbox' ? active : null
  return { key, nth, start: field?.selectionStart ?? null, end: field?.selectionEnd ?? null }
}

function refocus(root: HTMLElement, focused: Focused): void {
  const again = sameControl([...root.querySelectorAll<HTMLElement>(CONTROLS)], focused.key, focused.nth)
  if (again === null) return
  again.focus({ preventScroll: true })
  if (again instanceof HTMLInputElement && focused.start !== null) again.setSelectionRange(focused.start, focused.end)
}

// The status line a screen reader reads out, set only when what it says changes so a redraw says nothing again
let said: string | null = null
function say(text: string | null): void {
  const status = document.getElementById('status')
  if (status === null || text === said) return
  said = text
  if (text !== null) status.textContent = text
}

const actionLabels: Record<PluginAction, string> = {
  approve: 'Approve', 'switch-on': 'Switch on', 'switch-off': 'Switch off', stop: 'Stop', restart: 'Restart',
  reset: 'Reset', remove: 'Remove',
}

function act(page: TrustedPage, plugin: string, action: PluginAction): void {
  if (action === 'stop') return page.stop(plugin)
  if (action === 'restart') return page.restart(plugin)
  const kinds = {
    approve: 'plugin.approve', 'switch-on': 'plugin.on', 'switch-off': 'plugin.off', reset: 'plugin.reset', remove: 'plugin.remove',
  } as const
  page.ask({ kind: kinds[action], plugin })
}

if (bridge !== undefined) {
  const page: TrustedPage = new TrustedPage(bridge, (shown, note) => draw(page, shown, note), () => arming.focusDelayRuns())
  page.start()
}
