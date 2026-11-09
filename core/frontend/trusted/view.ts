// The trusted window's logic, kept apart from the DOM so it runs in tests. The page hands it the preload's bridge and a
// function that draws a screen as text. Every word on it is the core's or this file's, a plugin's only as an id or a
// quoted scope
import type { HeldRequest, ListedPlugin, SecurityList, StoppedMode } from '../../api/actions.ts'
import type { Capability } from '../../api/capabilities.ts'
import type { Change } from '../../api/changes.ts'
import { floorConstantNames, floorConstants, type FloorConstant } from '../../api/floor.ts'
import { capabilityText } from '../../api/trusted.ts'

export type Bridge = {
  send(message: unknown): void
  listen(listener: (message: unknown) => void): void
}

export type PluginAction = 'approve' | 'switch-on' | 'switch-off' | 'stop' | 'restart' | 'reset' | 'restore' | 'remove'
export type Choice = 'switch-off' | 'recover' | 'quit'

// A line and the change its button asks for, none for a line with no button
export type Switch = { line: string, change: Change | null }

export type Limit = { constant: FloorConstant, floor: number, all: number | null, plugins: { plugin: string, value: number }[] }

export type Screen = {
  stopped: { control: string, lines: string[], choices: Choice[] } | null
  // The oldest request waiting, and how many wait behind it
  request: HeldRequest | null
  behind: number
  plugins: {
    id: string, line: string, actions: PluginAction[], items: { line: string, on: boolean, capability: Capability }[], switches: Switch[]
  }[]
  switches: Switch[]
  limits: Limit[]
  luoshu: string
}

function stoppedScreen(mode: StoppedMode): Screen['stopped'] {
  const lines: string[] = []
  if (mode.control === 'log') lines.push('hetu stopped: the event log can’t write')
  else if (mode.control === 'install') lines.push('hetu stopped: its install list doesn’t check out')
  else if (mode.why === 'tampered') lines.push(`hetu stopped: the security plugin ${mode.control} failed its hash check`)
  else if (mode.why === 'absent') lines.push(`hetu stopped: the security plugin ${mode.control} is missing from the install`)
  else lines.push(`hetu stopped: the security plugin ${mode.control} failed to start${mode.reason !== null ? ` (${mode.reason})` : ''}`)
  if (mode.again) lines.push('hetu already started again once after a failure, so it didn’t start again on its own')
  // Bytes that don't check out are hetu's own files damaged, which only its installer puts back
  const damaged = mode.why !== 'failed' || mode.control === 'install'
  if (damaged) lines.push('Repair hetu with its installer to get its files back')
  if (mode.control === 'log') lines.push('Free space or fix the data folder’s permissions, or stop recording to start without the log')
  const choices: Choice[] = mode.control === 'install' ? ['quit'] : damaged || mode.control === 'log' ? ['switch-off', 'quit'] : ['switch-off', 'recover', 'quit']
  return { control: mode.control, lines, choices }
}

// The stopped mode's switch-off and Recover as the changes they ask for. The log goes off by stopping recording. Quit
// is no change
export function choiceChange(control: string, choice: Choice): Change | null {
  if (choice === 'quit') return null
  if (control === 'log') return { kind: 'recordNothing', on: true }
  return { kind: choice === 'recover' ? 'plugin.reset' : 'plugin.off', plugin: control }
}

// A plugin-folder plugin's class, from the capabilities slot. One it couldn't give counts as 4
function pluginLine(plugin: ListedPlugin): string {
  const from = plugin.from === 'install' ? 'ships with hetu' : 'plugin folder'
  const state = plugin.reason !== null ? `${plugin.state} (${plugin.reason})` : plugin.state
  const known = plugin.from === 'install' ? [] : [plugin.class === null ? 'class unknown, counted as 4' : `class ${plugin.class}`]
  return [plugin.id, from, plugin.place, state, ...(plugin.security ? ['security'] : []), ...known].join(' · ')
}

function actionsOf(plugin: ListedPlugin): PluginAction[] {
  const actions: PluginAction[] = []
  if (plugin.from === 'folder' && plugin.state === 'found' && plugin.reason === 'new') return ['approve', 'remove']
  actions.push(plugin.on ? 'switch-off' : 'switch-on')
  if (plugin.place === 'sandboxed' && plugin.on) {
    if (plugin.state === 'ready' || plugin.state === 'unresponsive' || plugin.state === 'starting') actions.push('stop')
    else if (plugin.state === 'stopped' || plugin.state === 'crashed') actions.push('restart')
  }
  actions.push('reset')
  if (plugin.firstParty) actions.push('restore')
  if (plugin.from === 'folder') actions.push('remove')
  return actions
}

// Each item with its switch. One switched off says when another of its type is still on, since matching paths against
// each other is the gate's and an item off changes nothing for a path a wider one still reaches
function itemsOf(plugin: ListedPlugin): Screen['plugins'][number]['items'] {
  return plugin.items.map(item => {
    const { capability } = item
    const text = capabilityText(capability)
    if (item.firstUse && !item.off) return { line: `${text} · asks at first use`, on: false, capability }
    if (!item.off) return { line: `${text} · on`, on: true, capability }
    const wider = plugin.items.some(other => other !== item && !other.off && !other.firstUse && other.capability.type === capability.type)
    return { line: `${text} · off${wider ? ` · other ${capability.type} items still on may reach the same paths` : ''}`, on: false, capability }
  })
}

const state = (on: boolean) => (on ? 'on' : 'off')

// The switches for all of hetu, each with the change its button asks for, then the per-plugin ones that are on. Unsigned
// builds get a button with plugin provenance, which names them
function switchesOf(list: SecurityList): Switch[] {
  const { switches } = list
  const rows: Switch[] = [
    { line: `Confirm off for this window: ${state(switches.confirmOff)}`, change: { kind: 'confirmOff', on: !switches.confirmOff } },
    { line: `Verification skipped: ${state(switches.skipVerification)}`, change: { kind: 'skipVerification', on: !switches.skipVerification } },
    { line: `Record nothing: ${state(switches.recordNothing)}`, change: { kind: 'recordNothing', on: !switches.recordNothing } },
  ]
  if (switches.devMode.length > 0) rows.push({ line: `dev mode: ${switches.devMode.join(', ')}`, change: null })
  if (switches.execAnyCommand.length > 0) rows.push({ line: `any command: ${switches.execAnyCommand.join(', ')}`, change: null })
  if (switches.allowUnsigned.length > 0) rows.push({ line: `unsigned builds trusted: ${switches.allowUnsigned.length}`, change: null })
  return rows
}

// Dev mode for a plugin-folder plugin, which it loads unhashed, and any command for one holding exec
function pluginSwitches(plugin: ListedPlugin, list: SecurityList): Switch[] {
  const rows: Switch[] = []
  if (plugin.from === 'folder') {
    const on = list.switches.devMode.includes(plugin.id)
    rows.push({ line: `dev mode: ${state(on)}`, change: { kind: 'devMode', plugin: plugin.id, on: !on } })
  }
  if (plugin.items.some(item => item.capability.type === 'exec')) {
    const on = list.switches.execAnyCommand.includes(plugin.id)
    rows.push({ line: `any command: ${state(on)}`, change: { kind: 'exec.anyCommand', plugin: plugin.id, on: !on } })
  }
  return rows
}

function limitsOf(list: SecurityList): Limit[] {
  return floorConstantNames.map(constant => ({
    constant,
    floor: floorConstants[constant],
    all: list.limits.all[constant] ?? null,
    plugins: Object.entries(list.limits.plugins)
      .filter(([, set]) => set[constant] !== undefined)
      .map(([plugin, set]) => ({ plugin, value: set[constant]! }))
      .sort((a, b) => (a.plugin < b.plugin ? -1 : 1)),
  }))
}

// What the human typed for a limit as its change, or null for anything but a whole number from 1 up. The core checks it
// again, a time past the longest timer included
export function limitChange(constant: FloorConstant, typed: string, plugin: string | null): Change | null {
  const text = typed.trim()
  if (!/^[1-9][0-9]{0,15}$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? { kind: 'limit.set', constant, value, plugin } : null
}

export function screen(list: SecurityList): Screen {
  return {
    stopped: list.stopped === null ? null : stoppedScreen(list.stopped),
    request: list.requests[0] ?? null,
    behind: Math.max(0, list.requests.length - 1),
    plugins: list.plugins.map(plugin => ({
      id: plugin.id, line: pluginLine(plugin), actions: actionsOf(plugin), items: itemsOf(plugin), switches: pluginSwitches(plugin, list),
    })),
    switches: switchesOf(list),
    limits: limitsOf(list),
    luoshu: `Notes folder: ${list.luoshu ?? 'none picked'}`,
  }
}

// What a refused Confirm or change tells the human
const notes: Readonly<Record<string, string>> = Object.freeze({
  throttled: 'Too soon after the window showed. Read the change, then confirm',
  invalid: 'What you typed doesn’t match',
  stale: 'The settings changed since this was asked. Ask again',
  failed: 'hetu couldn’t record or apply the change, so nothing changed',
  'not-found': 'That request is gone',
})

type Reply = { kind?: unknown, id?: unknown, ok?: unknown, result?: unknown, refusal?: { code?: unknown }, topic?: unknown, seq?: unknown }

// Hears core.status and core.security, reads the list and draws it, then reads it again each time the core says so.
// Each event is acked. Every change goes back to the core as a request, which applies, waits for the Confirm here or
// is refused
export class TrustedPage {
  private readonly bridge: Bridge
  private readonly draw: (screen: Screen, note: string | null) => void
  private id = 0
  private readonly pending = new Map<number, (reply: Reply) => void>()
  private last: SecurityList | null = null
  private note: string | null = null

  constructor(bridge: Bridge, draw: (screen: Screen, note: string | null) => void) {
    this.bridge = bridge
    this.draw = draw
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
      if (reply.ok === true && stopped !== null) this.call('core.relaunch')
      this.settle(reply)
    })
  }

  cancel(requestId: string): void {
    this.call('security.cancel', { requestId }, reply => this.settle(reply))
  }

  // A choice in the stopped mode that applied at once, with confirmOff on, starts hetu again as a Confirm does
  ask(change: Change): void {
    const stopped = this.last?.stopped ?? null
    this.call('security.request', { change }, reply => {
      const applied = reply.ok === true && (reply.result as { applied?: unknown } | null)?.applied === true
      if (applied && stopped !== null) this.call('core.relaunch')
      this.settle(reply, 'request')
    })
  }

  stop(plugin: string): void {
    this.call('core.stop', { plugin }, reply => this.settle(reply))
  }

  restart(plugin: string): void {
    this.call('core.restart', { plugin }, reply => this.settle(reply))
  }

  relaunch(): void {
    this.call('core.relaunch')
  }

  // The OS folder dialog in main, then the folder picked asked for as luoshu.set, which waits for the Confirm. A
  // cancelled dialog asks for nothing
  pickFolder(): void {
    this.call('core.pickFolder', undefined, reply => {
      if (reply.ok === true && typeof reply.result === 'string') this.ask({ kind: 'luoshu.set', folder: reply.result })
      else if (reply.ok !== true) this.settle(reply)
    })
  }

  // A note of the page's own, such as a value that isn't a number, drawn until the next answer
  say(note: string): void {
    this.note = note
    this.refresh()
  }

  quit(): void {
    this.call('core.quit')
  }

  private settle(reply: Reply, sent: 'request' | 'other' = 'other'): void {
    const code = reply.ok === true ? null : reply.refusal?.code
    // A request answers throttled when its sender's places are full, a Confirm when it came too soon
    if (code === 'throttled' && sent === 'request') this.note = 'Too many requests are waiting. Answer or cancel some first'
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
      this.draw(screen(this.last), this.note)
    })
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
