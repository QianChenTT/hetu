import { capabilityKey, type Capability, type CapabilityType } from '../../../api/capabilities.ts'
import type { Caller } from '../../../api/envelope.ts'
import { commandKey } from '../../../api/exec.ts'
import { compileScopes } from '../../../api/scope.ts'
import type { Access, Decision, Gate, GrantedItem, Scope, GrantsSnapshot } from '../../../api/policy-jobs.ts'
import { windowGrants } from '../../../api/windows.ts'

// How the gate reads each type's scope: paths through the matcher, every topic named, the target, held with no scope
// at all, access for history, whose paths count only under an item of the same access, command for exec's whole
// argument array, or none for a type whose provider hasn't brought the fields the gate would need, which refuses
export type Rule = 'paths' | 'topics' | 'target' | 'held' | 'access' | 'command' | 'none'

export const scopeRules: Readonly<Record<CapabilityType, Rule>> = Object.freeze({
  'luoshu.read': 'paths',
  'luoshu.write': 'paths',
  'luoshu.list': 'paths',
  'events.subscribe': 'topics',
  'plugin.call': 'target',
  'log.read': 'held',
  'ui.view': 'held',
  'ui.decoration': 'held',
  'ui.command': 'held',
  'ui.layout': 'held',
  'ui.keys': 'held',
  'ui.edit': 'paths',
  'ui.read': 'paths',
  storage: 'held',
  'guard.hook': 'held',
  // Scope holds no host yet
  'net.fetch': 'none',
  history: 'access',
  exec: 'command',
})

// One item as the gate matches it, compiled once per grants snapshot. access is a history item's own
type Compiled = { type: string, off: boolean, firstUse: boolean, key: string, access?: string, covers: (part: string) => boolean }

const on = (item: Compiled) => !item.off && !item.firstUse

// any says the human let exec run any command for the item's plugin, which lifts an exec item's list and nothing else
function compile(item: GrantedItem, foldCase: boolean, any = false): Compiled {
  const { capability, off, firstUse } = item
  if (typeof capability !== 'object' || capability === null || typeof capability.type !== 'string') throw new Error('an item with no capability')
  if (typeof off !== 'boolean' || typeof firstUse !== 'boolean') throw new Error('an item with no switch')
  const rule = scopeRules[capability.type]
  let covers: (part: string) => boolean = () => false
  if (rule === 'paths' && 'paths' in capability) covers = compileScopes(capability.paths, { foldCase })
  if (rule === 'topics' && 'topics' in capability) covers = set(capability.topics)
  if (rule === 'target' && 'targets' in capability) covers = set(capability.targets)
  if (rule === 'held') covers = () => true
  if (rule === 'access' && capability.type === 'history') {
    return { type: capability.type, off, firstUse, key: capabilityKey(capability), access: capability.access, covers: compileScopes(capability.paths, { foldCase }) }
  }
  // The whole argument array as one key, so a command matches only the same arguments in the same order
  if (rule === 'command' && capability.type === 'exec') covers = any ? () => true : set(capability.commands.map(commandKey))
  return { type: capability.type, off, firstUse, key: capabilityKey(capability), covers }
}

function set(values: readonly string[]): (part: string) => boolean {
  const held = new Set(values)
  return part => held.has(part)
}

// What a call reaches that the rule judges, each part needing an item that covers it. null when the scope lacks the
// field the rule needs, which refuses
function partsOf(rule: Rule, scope: Scope): readonly string[] | null {
  if (rule === 'paths') return Array.isArray(scope.paths) && scope.paths.length > 0 ? scope.paths : null
  if (rule === 'topics') return Array.isArray(scope.topics) && scope.topics.length > 0 ? scope.topics : null
  if (rule === 'target') return typeof scope.target === 'string' ? [scope.target] : null
  if (rule === 'held') return ['']
  if (rule === 'access') {
    if (scope.access !== 'read' && scope.access !== 'commit') return null
    return Array.isArray(scope.paths) && scope.paths.length > 0 ? scope.paths : null
  }
  if (rule === 'command') {
    const { command } = scope
    return Array.isArray(command) && command.length > 0 && command.every(arg => typeof arg === 'string') ? [commandKey(command)] : null
  }
  return null
}

type Held = {
  view: number, foldCase: boolean, plugins: Map<string, Compiled[]>, windows: Map<string, Compiled[]>, agents: Map<string, Compiled[]>
}

// One list of items against one access: allowed, asking for the first item whose first use asks, switched off or not
// granted
function judgeItems(items: readonly Compiled[], access: Access, view: number): Decision {
  const refused = (code: 'not-granted' | 'switched-off'): Decision => ({ allow: false, code, view })
  const rule = scopeRules[access.capability] ?? 'none'
  const parts = partsOf(rule, access.scope)
  if (parts === null) return refused('not-granted')
  // A history item counts only for the access it names, so a read item never covers a commit
  const ofType = items.filter(item => item.type === access.capability && (rule !== 'access' || item.access === access.scope.access))
  let switchedOff = false
  let ask: string | null = null
  for (const part of parts) {
    const inside = ofType.filter(item => item.covers(part))
    if (inside.length === 0) return refused('not-granted')
    if (inside.some(on)) continue
    const asking = inside.find(item => !item.off)
    if (asking === undefined) switchedOff = true
    else ask ??= asking.key
  }
  if (switchedOff) return refused('switched-off')
  // The raw stage can only refuse, so an item whose first use asks passes there and asks at the canonical one
  if (ask !== null && access.stage === 'canonical') return { ask, view }
  return { allow: true, view }
}

// The gate the gate plugin holds. It decides on the newest grants snapshot and on core/api's fixed window grants, and keeps
// nothing else between calls
export function createGate(): Gate {
  let held: Held | null = null

  function itemsOf(caller: Caller): readonly Compiled[] {
    if (held === null) throw new Error('no grants snapshot yet')
    if (caller.kind === 'plugin') return held.plugins.get(caller.id) ?? []
    if (caller.kind === 'window') return held.windows.get(caller.role) ?? []
    // A content caller is reserved for #97 and holds nothing
    return []
  }

  // An agent's items that are on, none for a label the view doesn't hold. An agent's item has no first use of its own
  // to ask about, so one switched off or asking covers nothing
  function agentItems(agent: string): readonly Compiled[] {
    if (held === null) throw new Error('no grants snapshot yet')
    return (held.agents.get(agent) ?? []).filter(on)
  }

  const reads = (items: readonly Compiled[], path: string) => items.some(item => item.type === 'luoshu.read' && on(item) && item.covers(path))
  // A name is listed through luoshu.list, or through luoshu.read, which lists what it reads
  const lists = (items: readonly Compiled[], path: string) =>
    items.some(item => (item.type === 'luoshu.list' || item.type === 'luoshu.read') && on(item) && item.covers(path))

  return {
    // A call for an agent needs the caller's own items and the agent's both to hold it. The agent's items are judged
    // first and their refusal is not-granted, so an agent learns nothing of the caller's own items it isn't granted. The
    // caller's answer stands once the agent's allow. An ask is only ever for the caller's own item
    decide(access: Access): Decision {
      const own = judgeItems(itemsOf(access.caller), access, held!.view)
      if (access.agent === undefined) return own
      const agent = judgeItems(agentItems(access.agent), access, held!.view)
      if (!('allow' in agent) || agent.allow !== true) return { allow: false, code: 'not-granted', view: held!.view }
      return own
    },

    canRead(caller: Caller, path: string, agent?: string): boolean {
      return reads(itemsOf(caller), path) && (agent === undefined || reads(agentItems(agent), path))
    },

    canList(caller: Caller, path: string, agent?: string): boolean {
      return lists(itemsOf(caller), path) && (agent === undefined || lists(agentItems(agent), path))
    },

    verbs(plugin: string, window: string): string[] {
      if (held === null || window !== 'editor') return []
      const items = held.plugins.get(plugin) ?? []
      // A ui item scoped by paths reaches only the notes it names, so gate.reach asks about it per note
      const whole = (item: Compiled) => item.type.startsWith('ui.') && scopeRules[item.type as CapabilityType] === 'held' && on(item)
      return [...new Set(items.filter(whole).map(item => item.type))]
    },

    // Every item compiled once here. A throw marks the gate failed, so a view it can't read leaves it refusing
    stateChanged(next: GrantsSnapshot): void {
      const { n, foldCase, plugins, execAny } = next
      if (!Number.isSafeInteger(n) || typeof foldCase !== 'boolean' || typeof plugins !== 'object' || plugins === null) {
        throw new Error('a grants snapshot the gate can\'t read')
      }
      if (!Array.isArray(execAny) || !execAny.every(id => typeof id === 'string')) throw new Error('a grants snapshot with no execAny list')
      const any = new Set(execAny)
      const compiled = new Map<string, Compiled[]>()
      for (const [id, items] of Object.entries(plugins)) {
        if (!Array.isArray(items)) throw new Error('a plugin with no items')
        compiled.set(id, items.map(item => compile(item, foldCase, any.has(id))))
      }
      const windows = new Map<string, Compiled[]>()
      for (const [role, grants] of Object.entries(windowGrants)) {
        windows.set(role, grants.map((capability: Capability) => compile({ capability, off: false, firstUse: false }, foldCase)))
      }
      // By label in a Map, so a label every object knows finds only its own items. exec's any command is a plugin's
      // switch and lifts no agent's item
      const agents = new Map<string, Compiled[]>()
      const given: unknown = next.agents === undefined ? {} : next.agents
      if (typeof given !== 'object' || given === null || Array.isArray(given)) throw new Error('a grants snapshot whose agents the gate can\'t read')
      for (const [label, items] of Object.entries(given)) {
        if (!Array.isArray(items)) throw new Error('an agent with no items')
        agents.set(label, items.map(item => compile(item as GrantedItem, foldCase)))
      }
      held = { view: n, foldCase, plugins: compiled, windows, agents }
    },
  }
}
