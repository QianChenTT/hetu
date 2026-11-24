// The trusted window's logic, kept apart from the DOM so it runs in tests. The page hands it the preload's bridge and a
// function that draws a screen as text. Every word on it is the core's or this file's, a plugin's only as an id or a
// quoted scope
import { stoppedCause, type HeldRequest, type ListedIdentity, type ListedPlugin, type SecurityList, type StoppedMode } from '../../api/actions.ts'
import type { Capability } from '../../api/capabilities.ts'
import type { Change } from '../../api/changes.ts'
import { limitNames, defaultLimits, type LimitName } from '../../api/limits.ts'
import { grantSentence } from '../../api/trusted.ts'
import { watchingModuleIds } from '../../api/ids.ts'
import { installBox, Installer, type InstallBox, type InstallFlow } from './install.ts'
import { startupDue } from '../../api/trusted.ts'
import { startupScreen, type Startup } from './startup.ts'

export type Bridge = {
  send(message: unknown): void
  listen(listener: (message: unknown) => void): void
}

export type PluginAction = 'approve' | 'switch-on' | 'switch-off' | 'stop' | 'restart' | 'reset' | 'remove'
export type Choice = 'retry' | 'switch-off' | 'quit'

// A line and the change its button asks for, none for a line with no button
export type Switch = { line: string, change: Change | null }

// A run of text, a field in quotes being drawn apart from the words around it
export type Part = { text: string, label: boolean }

// A pair's row: its field in quotes, then the rest of its line
export type IdentityRow = { label: string, line: string, change: Change | null }

// The tabs on the left, one drawn at a time on the right. What waits for a Confirm is drawn above whichever is picked
export const tabs = ['start', 'plugins', 'switches', 'notes', 'identities', 'limits'] as const
export type Tab = typeof tabs[number]
const tabLabels: Readonly<Record<Tab, string>> = Object.freeze({
  start: 'Get started', plugins: 'Plugins', switches: 'Switches', notes: 'Notes folder', identities: 'Identities', limits: 'Limits',
})

export type Limit = { constant: LimitName, fixed: number, all: number | null, plugins: { plugin: string, value: number }[] }

export type Screen = {
  stopped: { control: string, lines: string[], choices: Choice[] } | null
  // The oldest request waiting with its heading in parts and for an ask for a pair's items the revoke of the pair its heading
  // shows, then how many wait behind it
  request: (HeldRequest & { heading: Part[], revoke: Change | null }) | null
  behind: number
  plugins: {
    id: string, line: string, actions: PluginAction[], items: { line: string, on: boolean, capability: Capability }[], switches: Switch[]
  }[]
  switches: Switch[]
  // Dev mode's settings: the hash checks skipped, which plugins load unhashed and the unsigned builds trusted
  dev: Switch[]
  limits: Limit[]
  luoshu: string
  installNote: string
  // Each pair with its Revoke, a revoked one with none, then what the list holds
  identities: { rows: IdentityRow[], about: string }
  // The Install button's box, null while nothing is being installed
  installing: InstallBox | null
  // The startup flow's steps and the one drawn, null in the stopped mode
  startup: Startup | null
  // The tab drawn and every tab with its name. mark says what on a tab waits for the human, drawn beside its name so
  // nothing waits unseen on a tab not shown
  tab: Tab
  tabs: { id: Tab, label: string, mark: string | null }[]
}

// A fixed line: the macOS app is the user's to write, unlike Program Files on Windows
const INSTALL_LINE = 'On macOS, programs running as you can change hetu’s install'
// What the identities list holds: the pairs the core holds for this run, each the field its root plugin set
const IDENTITIES_LINE = 'Each is the field a plugin sets on the calls it makes for one of its clients, under that plugin. What it holds and a revoke last until hetu quits'

// A pair's field in quotes as data, then its root plugin and its items, or that it is revoked
function identityRow(pair: ListedIdentity): IdentityRow {
  const label = JSON.stringify(pair.field)
  const under = ` under ${pair.root}`
  if (pair.revoked) return { label, line: `${under} · revoked until hetu quits`, change: null }
  return { label, line: under + pair.items.map(item => ` · ${grantSentence(item)}`).join(''), change: { kind: 'identity.revoke', root: pair.root, field: pair.field } }
}

// A request's heading with the field in quotes as a part of its own, the whole text as one part for any other request
// or one whose text doesn't hold the field. The last place it is found, where a connect's words put the field, so a
// client's name that reads as the field is never the part drawn apart
export function headingOf(request: HeldRequest): Part[] {
  const label = request.field === null ? '' : JSON.stringify(request.field)
  const at = label === '' ? -1 : request.text.lastIndexOf(label)
  if (at < 0) return [{ text: request.text, label: false }]
  const parts = [
    { text: request.text.slice(0, at), label: false }, { text: label, label: true }, { text: request.text.slice(at + label.length), label: false },
  ]
  return parts.filter(part => part.text !== '')
}

// The request drawn first. An ask for a pair's items gets Cancel and revoke beside Confirm and Cancel, the revoke naming
// the pair the request holds, whose field its heading draws
function requestOf(request: HeldRequest): NonNullable<Screen['request']> {
  const revoke: Change | null = request.kind === 'identity.ask' && request.root !== null && request.field !== null
    ? { kind: 'identity.revoke', root: request.root, field: request.field } : null
  return { ...request, heading: headingOf(request), revoke }
}

// The log failing, an install list that doesn't check out and a control that judges yes or no failing at start stop
// hetu. The list is hetu's own files damaged, which only its installer puts back. A control that failed at start is
// tried again or switched off, which counts as the human's switch
function stoppedScreen(mode: StoppedMode): Screen['stopped'] {
  const lines = [stoppedCause(mode)]
  if (mode.why === 'start-failed') {
    lines.push('Try again starts hetu again, for a failure that has passed')
    lines.push(`Start with it switched off runs hetu with ${mode.control} off until you switch it on, after its Confirm and its name typed`)
    return { control: mode.control, lines, choices: ['retry', 'switch-off', 'quit'] }
  }
  const log = mode.control === 'log'
  if (mode.again) lines.push('hetu already started again once after a failure, so it didn’t start again on its own')
  lines.push(log
    ? 'Free space or fix the data folder’s permissions, or stop recording to start without the log'
    : 'Repair hetu with its installer to get its files back')
  const choices: Choice[] = log ? ['switch-off', 'quit'] : ['quit']
  return { control: mode.control, lines, choices }
}

// The stopped mode's switch-off as the change it asks for: the log goes off by switching recording off and a control
// that failed at start by its own switch. Try again and Quit are no change
export function choiceChange(control: string, choice: Choice): Change | null {
  if (choice !== 'switch-off') return null
  return { kind: 'plugin.off', plugin: control === 'log' ? 'recording' : control }
}

// A core module and a core plugin both ship with hetu. A plugin-folder plugin's class, from the grant risk classifier
// policy job. One it couldn't give counts as 4. A security control is locked on while the security view is off
function pluginLine(plugin: ListedPlugin, locked: boolean): string {
  const from = plugin.from === 'folder' ? 'plugin folder' : 'ships with hetu'
  const state = plugin.reason !== null ? `${plugin.state} (${plugin.reason})` : plugin.state
  const known = plugin.from === 'folder' ? [plugin.class === null ? 'class unknown, counted as 4' : `class ${plugin.class}`] : []
  return [
    plugin.id, from, plugin.place, state, ...(plugin.security ? ['security'] : []), ...known, ...(locked ? ['locked while the security view is off'] : []),
    ...(plugin.from === 'core' && (watchingModuleIds as readonly string[]).includes(plugin.id) ? ['its off waits for a Confirm'] : []),
  ].join(' · ')
}

// A core module has its switch alone: it restarts nothing and Recover doesn't reset it. A security control can't be
// switched off while the security view is off, since nothing asks for its typed word
function actionsOf(plugin: ListedPlugin, locked: boolean): PluginAction[] {
  const actions: PluginAction[] = []
  if (locked) return []
  if (plugin.from === 'core') return [plugin.on ? 'switch-off' : 'switch-on']
  if (plugin.from === 'folder' && plugin.state === 'found' && plugin.reason === 'new') return ['approve', 'remove']
  actions.push(plugin.on ? 'switch-off' : 'switch-on')
  // A sandboxed plugin or a utility half stops and starts again within a run, a utility half whose bind failed included
  if ((plugin.place === 'sandboxed' || plugin.place === 'utility') && plugin.on) {
    if (plugin.state === 'ready' || plugin.state === 'unresponsive' || plugin.state === 'starting') actions.push('stop')
    else if (plugin.state === 'stopped' || plugin.state === 'crashed' || plugin.state === 'failed') actions.push('restart')
  }
  actions.push('reset')
  if (plugin.from === 'folder') actions.push('remove')
  return actions
}

// Each item with its switch. One switched off says when another of its type is still on, since matching paths against
// each other is the gate's and an item off changes nothing for a path a wider one still reaches
function itemsOf(plugin: ListedPlugin): Screen['plugins'][number]['items'] {
  return plugin.items.map(item => {
    const { capability } = item
    const text = grantSentence(capability)
    if (item.firstUse && !item.off) return { line: `${text} · asks at first use`, on: false, capability }
    if (!item.off) return { line: `${text} · on`, on: true, capability }
    const wider = plugin.items.some(other => other !== item && !other.off && !other.firstUse && other.capability.type === capability.type)
    return { line: `${text} · off${wider ? ' · another grant of this kind still on may cover the same' : ''}`, on: false, capability }
  })
}

const state = (on: boolean) => (on ? 'on' : 'off')

// The switches for all of hetu, each with the change its button asks for, then the plugins any command is on for
function switchesOf(list: SecurityList): Switch[] {
  const { switches } = list
  const rows: Switch[] = [
    { line: `Confirm off for this window: ${state(switches.confirmOff)}`, change: { kind: 'confirmOff', on: !switches.confirmOff } },
  ]
  if (switches.execAnyCommand.length > 0) rows.push({ line: `any command: ${switches.execAnyCommand.join(', ')}`, change: null })
  return rows
}

// The Dev group: the hash checks skipped, dev mode for each plugin-folder plugin, which then loads unhashed and the
// unsigned builds trusted, which a button with plugin provenance names
function devOf(list: SecurityList): Switch[] {
  const { switches } = list
  const rows: Switch[] = [
    { line: `Verification skipped: ${state(switches.skipVerification)}`, change: { kind: 'skipVerification', on: !switches.skipVerification } },
  ]
  for (const plugin of list.plugins.filter(one => one.from === 'folder')) {
    const on = switches.devMode.includes(plugin.id)
    rows.push({ line: `dev mode for ${plugin.id}: ${state(on)}`, change: { kind: 'devMode', plugin: plugin.id, on: !on } })
  }
  if (switches.allowUnsigned.length > 0) rows.push({ line: `unsigned builds trusted: ${switches.allowUnsigned.length}`, change: null })
  return rows
}

// Any command for a plugin holding exec
function pluginSwitches(plugin: ListedPlugin, list: SecurityList): Switch[] {
  const rows: Switch[] = []
  if (plugin.items.some(item => item.capability.type === 'exec')) {
    const on = list.switches.execAnyCommand.includes(plugin.id)
    rows.push({ line: `any command: ${state(on)}`, change: { kind: 'exec.anyCommand', plugin: plugin.id, on: !on } })
  }
  return rows
}

function limitsOf(list: SecurityList): Limit[] {
  return limitNames.map(constant => ({
    constant,
    fixed: defaultLimits[constant],
    all: list.limits.all[constant] ?? null,
    plugins: Object.entries(list.limits.plugins)
      .filter(([, set]) => set[constant] !== undefined)
      .map(([plugin, set]) => ({ plugin, value: set[constant]! }))
      .sort((a, b) => (a.plugin < b.plugin ? -1 : 1)),
  }))
}

// What the human typed for a limit as its change, or null for anything but a whole number from 1 up. The core checks it
// again, a time past the longest timer included
export function limitChange(constant: LimitName, typed: string, plugin: string | null): Change | null {
  const text = typed.trim()
  if (!/^[1-9][0-9]{0,15}$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? { kind: 'limit.set', constant, value, plugin } : null
}

// tab is the one the human picked, else Get started while the startup flow is due and Plugins after. at is the guide's step
// the human went to or the guide was first drawn at
export function screen(list: SecurityList, flow: InstallFlow | null = null, tab: Tab | null = null, at: number | null = null): Screen {
  const viewOff = list.plugins.some(plugin => plugin.id === 'security-view' && plugin.from === 'core' && !plugin.on)
  return {
    stopped: list.stopped === null ? null : stoppedScreen(list.stopped),
    request: list.requests[0] === undefined ? null : requestOf(list.requests[0]),
    behind: Math.max(0, list.requests.length - 1),
    plugins: list.plugins.map(plugin => {
      const locked = viewOff && plugin.security && plugin.on
      return {
        id: plugin.id, line: pluginLine(plugin, locked), actions: actionsOf(plugin, locked), items: itemsOf(plugin), switches: pluginSwitches(plugin, list),
      }
    }),
    switches: switchesOf(list),
    dev: devOf(list),
    limits: limitsOf(list),
    luoshu: `Notes folder: ${list.luoshu ?? 'none picked'}`,
    installNote: INSTALL_LINE,
    identities: { rows: list.identities.map(identityRow), about: IDENTITIES_LINE },
    installing: installBox(flow),
    startup: startupScreen(list, at),
    tab: tab ?? (startupDue(list) ? 'start' : 'plugins'),
    tabs: tabs.map(id => ({ id, label: tabLabels[id], mark: id === 'plugins' ? waitingMark(list) : null })),
  }
}

// The plugins that wait for the human: a new folder plugin waiting for Approve, one that crashed, failed or stopped
// answering
function waitingMark(list: SecurityList): string | null {
  const waiting = list.plugins.filter(plugin => (plugin.from === 'folder' && plugin.state === 'found' && plugin.reason === 'new')
    || plugin.state === 'crashed' || plugin.state === 'failed' || plugin.state === 'unresponsive').length
  return waiting === 0 ? null : `${waiting} waiting`
}

// What a refused Confirm or change tells the human
const notes: Readonly<Record<string, string>> = Object.freeze({
  throttled: 'Too soon after the window showed. Read the change, then confirm',
  invalid: 'What you typed doesn’t match',
  stale: 'The settings changed since this was asked. Ask again',
  failed: 'hetu couldn’t record or apply the change, so nothing changed',
  'not-found': 'That request is gone',
})

// What a refused request tells the human. A Confirm refused too soon has its own words in notes
const TOO_SOON = 'Too soon after the window showed or gained focus. Wait a moment, then ask again'
const TOO_MANY = 'Too many requests are waiting. Answer or cancel some first'

type Reply = { kind?: unknown, id?: unknown, ok?: unknown, result?: unknown, refusal?: { code?: unknown }, topic?: unknown, seq?: unknown }

// Hears core.status and core.security, reads the list and draws it, then reads it again each time the core says so.
// Each event is acked. Every change goes back to the core as a request, which applies, waits for the Confirm here or
// is refused
export class TrustedPage {
  private readonly bridge: Bridge
  private readonly draw: (screen: Screen, note: string | null) => void
  private readonly inFocusDelay: () => boolean
  private id = 0
  private readonly pending = new Map<number, (reply: Reply) => void>()
  private last: SecurityList | null = null
  private note: string | null = null
  private tab: Tab | null = null
  private step: number | null = null
  readonly installer: Installer

  // inFocusDelay says whether the input delay since the window showed or gained focus still runs
  constructor(bridge: Bridge, draw: (screen: Screen, note: string | null) => void, inFocusDelay: () => boolean = () => false) {
    this.bridge = bridge
    this.draw = draw
    this.inFocusDelay = inFocusDelay
    this.installer = new Installer({
      call: (action, args, then) => this.call(action, args, then),
      settle: (reply, note) => this.settle(reply, 'other', note),
      redraw: () => this.redraw(),
    })
  }

  start(): void {
    this.bridge.listen(message => this.heard(message))
    this.call('events.subscribe', { topics: ['core.status', 'core.security'] })
    this.refresh()
  }

  confirm(requestId: string, typed?: string): void {
    const stopped = this.last?.stopped ?? null
    this.call('security.confirm', typed === undefined ? { requestId } : { requestId, typed }, reply => {
      // A choice in the stopped mode applied, so hetu starts again with it
      if (reply.ok === true && stopped !== null) this.call('app.relaunch')
      this.settle(reply)
    })
  }

  cancel(requestId: string): void {
    this.call('security.cancel', { requestId }, reply => this.settle(reply))
  }

  ask(change: Change): void {
    const stopped = this.last?.stopped ?? null
    this.call('security.request', { change }, reply => this.settleRequest(reply, stopped))
  }

  stop(plugin: string): void {
    this.call('core.stop', { plugin }, reply => this.settle(reply))
  }

  restart(plugin: string): void {
    this.call('core.restart', { plugin }, reply => this.settle(reply))
  }

  relaunch(): void {
    this.call('app.relaunch')
  }

  // The OS folder dialog in main, which asks for the folder picked as luoshu.pick itself, answering as a request does.
  // A cancelled dialog asks for nothing
  pickFolder(): void {
    const stopped = this.last?.stopped ?? null
    this.call('app.pickFolder', undefined, reply => {
      if (reply.ok !== true || reply.result !== null) this.settleRequest(reply, stopped)
    })
  }

  // The tab the human picked, for this window's life
  pickTab(tab: Tab): void {
    this.tab = tab
    this.redraw()
  }

  // The guide's step the human went to with Next, Back or a step's name, for this window's life
  guideTo(step: number): void {
    const last = this.last === null ? 1 : startupScreen(this.last, null)?.steps.length ?? 1
    this.step = Math.min(Math.max(step, 0), last - 1)
    this.redraw()
  }

  // Away from the guide to the plugin list once the flow ended. Its tab shows it again. While it is due there is no way out
  leaveGuide(): void {
    if (this.last !== null && startupDue(this.last)) return
    this.tab = 'plugins'
    this.redraw()
  }

  // A note of the page's own, such as a value that isn't a number, drawn until the next answer
  say(note: string): void {
    this.note = note
    this.refresh()
  }

  quit(): void {
    this.call('app.quit')
  }

  // A choice in the stopped mode that applied at once, with confirmOff on, starts hetu again as a Confirm does
  private settleRequest(reply: Reply, stopped: StoppedMode | null): void {
    const applied = reply.ok === true && (reply.result as { applied?: unknown } | null)?.applied === true
    if (applied && stopped !== null) this.call('app.relaunch')
    this.settle(reply, 'request')
  }

  // said is a note of the caller's own for an answer the core gave
  private settle(reply: Reply, sent: 'request' | 'other' = 'other', said?: string): void {
    const code = reply.ok === true ? null : reply.refusal?.code
    // A Confirm answers throttled when it came too soon. A request answers throttled inside the input delay as well as
    // when its sender's places are full, told apart by the delay this page keeps beside main's
    if (said !== undefined) this.note = said
    else if (code === 'throttled' && sent === 'request') this.note = this.inFocusDelay() ? TOO_SOON : TOO_MANY
    else this.note = typeof code === 'string' ? notes[code] ?? `Refused: ${code}` : null
    this.refresh()
  }

  private call(action: string, args?: unknown, then?: (reply: Reply) => void): void {
    const id = ++this.id
    if (then !== undefined) this.pending.set(id, then)
    this.bridge.send({ v: 1, kind: 'call', id, action, args })
  }

  private refresh(): void {
    this.call('security.list', undefined, reply => {
      if (reply.ok !== true) return
      this.last = reply.result as SecurityList
      this.redraw()
    })
  }

  private redraw(): void {
    // The first tab is picked once from the first list, so an install mid-guide doesn't move the human away
    if (this.last !== null && this.tab === null) this.tab = startupDue(this.last) ? 'start' : 'plugins'
    if (this.last === null) return
    const shown = screen(this.last, this.installer.flow, this.tab, this.step)
    // The guide stays on the step it was first drawn at, so a step done, as by an install, never moves the human on by itself
    if (shown.tab === 'start' && shown.startup !== null) this.step = shown.startup.at
    this.draw(shown, this.note)
  }

  private heard(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const got = message as Reply
    if (got.kind === 'reply' && typeof got.id === 'number') {
      const then = this.pending.get(got.id)
      this.pending.delete(got.id)
      then?.(got)
    } else if (got.kind === 'event' && (got.topic === 'core.status' || got.topic === 'core.security')) {
      if (typeof got.seq === 'number') this.bridge.send({ v: 1, kind: 'ack', seq: got.seq })
      this.refresh()
    }
  }
}
