import { z } from 'zod'
import { folderCapability, screenText } from './capabilities.ts'
import { agentLabel, MAX_AGENT_NUMBER_DIGITS, MAX_CLIENT_ID_LENGTH } from './envelope.ts'
import { floorConstantNames, MAX_TIMER_MS, timeConstants } from './floor.ts'
import { isSecurityControl, pluginId } from './ids.ts'
import { frozen } from './plain.ts'
import { agentDoor, agentHost } from './policy-jobs.ts'

export const MAX_FOLDER_LENGTH = 4096

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
// A folder on this machine. The StateStore checks that the folder is absolute by the platform's rules, core/api has no
// path module
const folder = screenText(MAX_FOLDER_LENGTH)
const on = z.boolean()

// plugin.reset is Recover's reset: the plugin's storage, cache and start marker cleared and a plugin-folder plugin's
// entry removed, so it waits for approval again
const pluginKinds = [
  'plugin.approve', 'plugin.update', 'plugin.on', 'plugin.off', 'plugin.remove', 'plugin.restore', 'plugin.clearStorage',
  'plugin.reset',
] as const
const grantKinds = ['grant.widen', 'grant.narrow', 'item.on', 'item.off'] as const
const perPluginSwitches = ['devMode', 'exec.anyCommand'] as const
const switches = ['skipVerification', 'confirmOff', 'recordNothing'] as const

// What security.request carries, the only way the security state changes. Only hetu windows send one and only the
// trusted window's Confirm applies one that widens. Each names one target and never the state as a whole
export const changeKinds = frozen([
  ...pluginKinds, ...grantKinds, 'luoshu.pick', ...perPluginSwitches, ...switches, 'allowUnsigned', 'limit.set', 'agent.revoke',
] as const)

export const change = z.discriminatedUnion('kind', [
  // plugin.off covers install and folder plugins alike
  z.strictObject({ kind: z.literal(pluginKinds), plugin: pluginId }),
  // Only folder plugins have grants to change, an install plugin's grants are its manifest
  z.strictObject({ kind: z.literal(grantKinds), plugin: pluginId, capability: folderCapability }),
  z.strictObject({ kind: z.literal('luoshu.pick'), folder }),
  // Dev mode is a list of plugins that load unhashed, exec.anyCommand a list of plugins exec runs any command for
  z.strictObject({ kind: z.literal(perPluginSwitches), plugin: pluginId, on }),
  z.strictObject({ kind: z.literal(switches), on }),
  // allowUnsigned trusts one fixed build, named by the content hash
  z.strictObject({ kind: z.literal('allowUnsigned'), hash: sha256Hex, on }),
  // plugin null sets the constant for every plugin. A time stops at the longest delay a timer takes, so a raise past it
  // is refused here rather than cut short where the timer runs
  z.strictObject({
    kind: z.literal('limit.set'),
    constant: z.enum(floorConstantNames),
    value: z.int().positive(),
    plugin: pluginId.nullable(),
  }).refine(set => !timeConstants.includes(set.constant) || set.value <= MAX_TIMER_MS, { message: `a time past ${MAX_TIMER_MS} ms` }),
  // Every item of one agent's grant goes at once and the label is kept as revoked until mcp-http-handler says it ended its tokens
  z.strictObject({ kind: z.literal('agent.revoke'), agent: agentLabel }),
])
// What moved a class up with no Confirm on screen. by is the plugin whose change it was, null for the classing at start
// and for the grant risk classifier switched on again
export const classCauses = frozen(['approve', 'copy', 'update', 'widen', 'narrow', 'restore', 'remove', 'reset', 'start', 'slot-on'] as const)
const classNumber = z.int().min(0).max(4)

// A notice the core raises alone, never one security.request carries: a plugin's class moved up past where the
// grant risk classifier alerts with no Confirm on screen. The class and its asks are stored already, so the human answers
// it and approves nothing. from is null for a class not known
export const classRaised = z.strictObject({
  kind: z.literal('class.raised'),
  plugin: pluginId,
  from: classNumber.nullable(),
  to: classNumber,
  cause: z.enum(classCauses),
  by: pluginId.nullable(),
})
export type ClassRaised = z.infer<typeof classRaised>

// The most items one ask names, how long it waits for the human before it lapses and how long a label whose ask the
// human cancelled waits before it may ask again
export const MAX_ASK_ITEMS = 8
export const AGENT_ASK_LAPSE_MS = 5 * 60_000
export const AGENT_ASK_PAUSE_MS = 60_000

// Every list of scopes an item holds names one at least, so no item asks for nothing and draws as a type alone. The
// variables of an exec item are no scope, an exec item may pass none
const scoped = (item: object) => Object.entries(item).every(([field, value]) => field === 'env' || !Array.isArray(value) || value.length > 0)
// An item an agent may ask for: any type a plugin-folder plugin may hold, with a scope where its type has one
export const askedCapability = folderCapability.refine(scoped, 'an item with no scope')

// An agent's ask the core raises alone from the agent host's core.agentAsk, never one security.request carries. agent
// is the label of the call from the door the ask was made under and never an argument, capabilities the items it lacks
// in key order. A Confirm adds them to that label's items on the host's entry
export const agentAsk = z.strictObject({
  kind: z.literal('agent.ask'),
  plugin: z.literal(agentHost),
  agent: agentLabel,
  capabilities: z.array(askedCapability).min(1).max(MAX_ASK_ITEMS),
})
export type AgentAsk = z.infer<typeof agentAsk>

// The longest name from a client's document and the longest redirect a connect takes, the highest number of an
// authorization and how long a connect waits for the human before it lapses
export const MAX_CLIENT_NAME_LENGTH = 128
export const MAX_REDIRECT_LENGTH = 2048
export const MAX_AGENT_NUMBER = 10 ** MAX_AGENT_NUMBER_DIGITS - 1
export const AGENT_CONNECT_LAPSE_MS = 60_000

// A format character, such as a zero-width one, draws as nothing and a line or paragraph separator breaks the line,
// neither of which the quotes escape
const unseen = /[\p{Cf}\p{Zl}\p{Zp}]/u
// A client's name as its document gives it: screen text with nothing that draws as nothing
export const clientName = screenText(MAX_CLIENT_NAME_LENGTH).refine(name => name.isWellFormed() && !unseen.test(name), 'a character that draws as nothing')

// The label an authorization of the client gets: the client id, # and the number
export function connectLabel(connect: { client: string, number: number }): string {
  return `${connect.client}#${connect.number}`
}

// A client's connect through mcp-http-handler's door the core raises alone from core.agentConnect, never one security.request
// carries. client is the client id, clientHost its host when it is a URL with one and null otherwise, name the one its
// document gives or null, redirect where the client gets its answer and redirectHost that address's host. The core
// took both hosts. number is the authorization's, which with the client id makes the label. A Confirm changes no state
export const agentConnect = z.strictObject({
  kind: z.literal('agent.connect'),
  plugin: z.literal(agentDoor.plugin),
  client: z.string().max(MAX_CLIENT_ID_LENGTH),
  clientHost: screenText(MAX_CLIENT_ID_LENGTH).nullable(),
  name: clientName.nullable(),
  redirect: screenText(MAX_REDIRECT_LENGTH),
  redirectHost: screenText(MAX_REDIRECT_LENGTH),
  number: z.int().min(1).max(MAX_AGENT_NUMBER),
}).refine(connect => agentLabel.safeParse(connectLabel(connect)).success, 'no agent label')
export type AgentConnect = z.infer<typeof agentConnect>

export type Change = z.infer<typeof change> | ClassRaised | AgentAsk | AgentConnect
export type ChangeKind = Change['kind']

// What applying a change does to what hetu lets through. A narrowing change applies at once with its record. A
// widening one waits for the human's Confirm in the trusted window and so does one that destroys data
export type ChangeEffect = 'narrows' | 'widens' | 'destroys'

// Read from the change's structure alone, never from what a plugin says about it or from the state, so no change
// applied meanwhile can move it. A security control switched off widens and switched back on narrows, every other plugin
// the other way round. A switch that weakens a check widens when it goes on. A limit waits for the Confirm either way:
// a higher value widens and a lower one can starve hetu's own controls or its audit, which the core can't tell apart
// from a safe one
export function changeEffect(change: Change): ChangeEffect {
  switch (change.kind) {
    case 'plugin.approve':
    case 'plugin.update':
    case 'plugin.restore':
    case 'grant.widen':
    case 'item.on':
    case 'luoshu.pick':
      return 'widens'
    case 'grant.narrow':
    case 'item.off':
    case 'agent.revoke':
      return 'narrows'
    case 'plugin.remove':
    case 'plugin.clearStorage':
    case 'plugin.reset':
      return 'destroys'
    case 'plugin.on':
      return isSecurityControl(change.plugin) ? 'narrows' : 'widens'
    case 'plugin.off':
      return isSecurityControl(change.plugin) ? 'widens' : 'narrows'
    case 'devMode':
    case 'exec.anyCommand':
    case 'skipVerification':
    case 'confirmOff':
    case 'recordNothing':
    case 'allowUnsigned':
      return change.on ? 'widens' : 'narrows'
    case 'limit.set':
      return 'widens'
    // Only the core raises one and it always waits for the human
    case 'class.raised':
    case 'agent.ask':
    case 'agent.connect':
      return 'widens'
  }
}

// How long a request of this kind waits for the human before it lapses, null for one that waits until answered. Only
// a request a plugin's call brought about lapses, since the call that asked is long over
export function lapseOf(change: Change): number | null {
  if (change.kind === 'agent.connect') return AGENT_CONNECT_LAPSE_MS
  return change.kind === 'agent.ask' ? AGENT_ASK_LAPSE_MS : null
}

// The plugins whose stop withdraws a waiting request of this kind, since what it would apply is theirs to use. An ask
// is for an agent of the agent host that mcp-http-handler's door named, a connect is mcp-http-handler's to collect
export function withdrawnWith(change: Change): readonly string[] {
  if (change.kind === 'agent.connect') return [agentDoor.plugin]
  return change.kind === 'agent.ask' ? [change.plugin, 'mcp-http-handler'] : []
}

// What the human types to prove attention before Confirm arms: a security control's id to switch it off and log to
// stop recording, the moments protection goes away. Every other Confirm has the input delay alone, so typing doesn't
// become a habit
export function mustType(change: Change): string | null {
  if (change.kind === 'plugin.off' && isSecurityControl(change.plugin)) return change.plugin
  if (change.kind === 'recordNothing' && change.on) return 'log'
  return null
}
