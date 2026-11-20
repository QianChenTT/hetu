import { actionPathProblem } from '../../../api/actions.ts'
import { capabilityTypes, scopedUiTypes } from '../../../api/capabilities.ts'
import type { Caller, RefusalCode } from '../../../api/envelope.ts'
import { frozen } from '../../../api/plain.ts'
import { policyJobStates, type Call, type Gate, type GateTime, type LiveCall, type PluginTable, type PolicyJobState } from '../../../api/policy-jobs.ts'

// The gate's own actions, gate.reach and gate.filterReadable, which the router hands here as it hands any core action,
// and the gate's time each caller may spend in a second, which listings spend too. A refusal is thrown

export type GateActionsOptions = {
  // The gate while it serves, else null
  gate: () => Gate | null
  // The plugins manager's table, for the gate's state and the grants snapshot's number, null until it is built
  table: () => PluginTable | null
  // filterMsPerSecond for the plugin, or for a window with null
  limit: (plugin: string | null) => number
  // A clock no change of the wall clock moves
  clock: () => number
  // A throw of the gate, recorded as a fault at this step
  fault: (step: string) => void
}

export type GateActions = { serve: (call: Call) => Promise<unknown>, time: GateTime }

// How far a throttled filterReadable for a live call got: the paths it was asked about, the gate and grants snapshot
// the answers came from, how many were asked about and the indexes kept
type Progress = { paths: readonly string[], gate: Gate, view: number | null, asked: number, kept: number[] }

const refuse = (code: RefusalCode) => frozen({ code })

const isState = (value: unknown): value is PolicyJobState => (policyJobStates as readonly unknown[]).includes(value)

export function createGateActions(options: GateActionsOptions): GateActions {
  // The gate's time spent for each principal in the current second
  const seconds = new Map<string, { second: number, spent: number }>()
  // Kept with the live call the router hands, so it goes when the call does
  const progress = new WeakMap<LiveCall, Progress>()

  // A state that can't be read is failed and a number that can't be read is none, as the router reads them
  const state = (): PolicyJobState => {
    try {
      const read = options.table()?.policyJob('gate')
      return isState(read) ? read : 'failed'
    } catch {
      return 'failed'
    }
  }
  const view = (): number | null => {
    try {
      const read = options.table()?.view()
      return Number.isSafeInteger(read) ? read as number : null
    } catch {
      return null
    }
  }
  const held = (): Gate | null => {
    try {
      return options.gate() ?? null
    } catch {
      return null
    }
  }
  // A fault that can't be recorded is lost
  const fault = (step: string) => {
    try {
      options.fault(step)
    } catch {}
  }
  const secondOf = (principal: string) => {
    const now = options.clock()
    let spent = seconds.get(principal)
    if (spent === undefined || now - spent.second >= 1000 || now < spent.second) {
      spent = { second: now, spent: 0 }
      seconds.set(principal, spent)
    }
    return spent
  }
  const time: GateTime = {
    spent: (principal, plugin) => secondOf(principal).spent >= options.limit(plugin),
    charge: (principal, ms) => {
      secondOf(principal).spent += ms
    },
  }

  // What a plugin may do with one note through the editor bridge, which the drawer asks before it serves the plugin
  // anything about the note: read it, write it, list its name and the ui items it holds, from the gate with the plugin
  // as the caller at the canonical stage. A write whose item still asks at first use counts as none, since the bridge
  // raises no prompt. Everything with the gate off by the human, policy-down while it starts or is down, as for any
  // call
  function reach(args: unknown): unknown {
    const { plugin, path } = args as { plugin: string, path?: string }
    const now = state()
    if (now === 'off') {
      const verbs = capabilityTypes.filter(type => type.startsWith('ui.') && !(scopedUiTypes as readonly string[]).includes(type))
      const any = path !== undefined
      return { read: any, edit: any, uiRead: any, list: any, verbs }
    }
    const gate = now === 'on' ? held() : null
    if (gate === null) throw refuse('policy-down')
    const caller: Caller = frozen({ kind: 'plugin', id: plugin, half: 'worker', incarnation: 1 })
    try {
      const given = gate.verbs(plugin, 'editor')
      const verbs = Array.isArray(given) ? given.filter(verb => typeof verb === 'string') : []
      if (path === undefined) return { read: false, edit: false, uiRead: false, list: false, verbs }
      const read = gate.canRead(caller, path) === true
      const list = gate.canList(caller, path) === true
      // An edit through the editor needs ui.edit on the note, never luoshu.write. ui.read is a read the drawer serves
      // only for a note the human opened
      const allows = (action: string, capability: 'ui.edit' | 'ui.read') => {
        const decision = gate.decide(frozen({ stage: 'canonical', caller, action, capability, scope: frozen({ paths: [path] }) }))
        return 'allow' in decision && decision.allow === true
      }
      const edit = allows('editor.edit', 'ui.edit')
      const uiRead = allows('editor.read', 'ui.read')
      return { read, edit, uiRead, list, verbs }
    } catch {
      fault('reach')
      throw refuse('policy-down')
    }
  }

  // The paths the asking callee may read itself that the live call's own caller may read too, every path with the gate
  // off and policy-down while the gate is starting or failed. A store from an older build may hold a dot segment or a
  // spelling no action takes, so a path a callee read is taken in and the contract's path check drops such a path from
  // the answer, gate on or off, while the call still answers. One message asks the gate up to twice per path,
  // synchronously in main. Scopes shaped for the matcher's worst case make each ask slow, so the gate's time counts
  // against the live call's caller, filterMsPerSecond each second, so one that floods a plugin with calls spends only
  // its own. Past it the call answers throttled and the live call keeps how far it got, so the next try goes on from
  // there and any call finishes within its deadline. That progress is dropped once the gate or the grants snapshot
  // changed, so no answer from before a narrowing stands. For a live call that acts for an agent, the paths the agent
  // may read too. The door's own call names mcp-http-handler as its caller, which reads nothing and passes the answer
  // on to the agent, so there the agent's grant stands in for the caller's
  function filterReadable(call: Call): unknown {
    const { live } = call
    const paths = (call.args as { paths: string[] }).paths.filter(path => actionPathProblem(path) === null)
    if (live === undefined || !live.open()) throw refuse('invalid')
    const now = state()
    if (now === 'off') return paths
    const gate = now === 'on' ? held() : null
    if (gate === null) throw refuse('policy-down')
    if (time.spent(live.principal, live.plugin)) throw refuse('throttled')
    const budget = options.limit(live.plugin)
    const spent = secondOf(live.principal)
    const started = options.clock()
    const current = view()
    const before = progress.get(live)
    progress.delete(live)
    const same = before !== undefined && before.gate === gate && before.view === current
      && before.paths.length === paths.length && before.paths.every((path, at) => path === paths[at])
    const going: Progress = same ? before : { paths: [...paths], gate, view: current, asked: 0, kept: [] }
    try {
      while (going.asked < paths.length) {
        const path = paths[going.asked]
        const kept = gate.canRead(call.caller, path, live.agent) === true && (live.door || gate.canRead(live.caller, path) === true)
        if (kept) going.kept.push(going.asked)
        going.asked++
        if (going.asked < paths.length && spent.spent + options.clock() - started >= budget) break
      }
    } catch {
      fault('canRead')
      throw refuse('policy-down')
    } finally {
      spent.spent += options.clock() - started
    }
    if (going.asked < paths.length) {
      progress.set(live, going)
      throw refuse('throttled')
    }
    return going.kept.map(at => paths[at])
  }

  return {
    serve: async call => (call.action === 'gate.reach' ? reach(call.args) : filterReadable(call)),
    time,
  }
}
