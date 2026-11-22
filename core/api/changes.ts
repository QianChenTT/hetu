import { z } from 'zod'
import { folderCapability, pairCapability, screenText, seenText } from './capabilities.ts'
import { label } from './envelope.ts'
import { limitNames, MAX_TIMER_MS, timeLimitNames } from './limits.ts'
import { isSecurityControl, pluginId, watchingModuleIds } from './ids.ts'
import { frozen } from './plain.ts'

export const MAX_FOLDER_LENGTH = 4096

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
// A folder on this machine. The StateStore checks that the folder is absolute by the platform's rules, core/api has no
// path module
const folder = screenText(MAX_FOLDER_LENGTH)
const on = z.boolean()

// plugin.reset is Recover's reset: the plugin's storage and cache cleared and a plugin-folder plugin's entry removed, so
// it waits for approval again. A core module has none
const pluginKinds = [
  'plugin.approve', 'plugin.update', 'plugin.on', 'plugin.off', 'plugin.remove', 'plugin.clearStorage', 'plugin.reset',
] as const
const grantKinds = ['grant.widen', 'grant.narrow', 'item.on', 'item.off'] as const
const perPluginSwitches = ['devMode', 'exec.anyCommand'] as const
const switches = ['skipVerification', 'confirmOff'] as const

// What security.request carries, the only way the security state changes. Only hetu windows send one and only the
// trusted window's Confirm applies one that widens. Each names one target and never the state as a whole
export const changeKinds = frozen([
  ...pluginKinds, ...grantKinds, 'luoshu.pick', ...perPluginSwitches, ...switches, 'allowUnsigned', 'limit.set', 'identity.revoke',
] as const)

export const change = z.discriminatedUnion('kind', [
  // plugin.off covers core modules, install and folder plugins alike
  z.strictObject({ kind: z.literal(pluginKinds), plugin: pluginId }),
  // Only folder plugins have grants to change, a core plugin's grants are its manifest
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
    constant: z.enum(limitNames),
    value: z.int().positive(),
    plugin: pluginId.nullable(),
  }).refine(set => !timeLimitNames.includes(set.constant) || set.value <= MAX_TIMER_MS, { message: `a time past ${MAX_TIMER_MS} ms` }),
  // Every item of one pair goes at once and the pair, the root plugin's id and the field, is refused for the rest of
  // the run
  z.strictObject({ kind: z.literal('identity.revoke'), root: pluginId, field: label }),
])
// What moved a class up with no Confirm on screen. by is the plugin whose change it was, null for the classing at start
// and for the grant risk classifier switched on again. copy and restore were the first-party copy at start and its
// restore, which nothing causes any more. Kept, so a notice an older build owed still reads and is answered
export const classCauses = frozen(['approve', 'copy', 'update', 'widen', 'narrow', 'restore', 'remove', 'reset', 'start', 'slot-on'] as const)
// A class as a state file or a notice holds it, from 0 to 4
export const classNumber = z.int().min(0).max(4)

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

// The most items one ask names, how long it waits for the human before it lapses and how long a pair whose ask the
// human cancelled waits before it may ask again
export const MAX_ASK_ITEMS = 8
export const IDENTITY_ASK_LAPSE_MS = 5 * 60_000
export const IDENTITY_ASK_PAUSE_MS = 60_000

// Every list of scopes an item holds names one at least, so no item asks for nothing and draws as a type alone. The
// variables of an exec item are no scope, an exec item may pass none
const scoped = (item: object) => Object.entries(item).every(([field, value]) => field === 'env' || !Array.isArray(value) || value.length > 0)
// An item a pair may be asked for: a type a pair may hold, with a scope where its type has one
export const askedCapability = pairCapability.refine(scoped, 'an item with no scope')

// An ask for a pair's items the core raises alone from core.identityAsk, never one security.request carries. plugin is
// the plugin the root of the chain called, which asked. root and field are the chain's pair, read from the chain and
// never from an argument. capabilities are the items the pair lacks in key order. A Confirm adds them to the pair's
// items for the run
export const identityAsk = z.strictObject({
  kind: z.literal('identity.ask'),
  plugin: pluginId,
  root: pluginId,
  field: label,
  capabilities: z.array(askedCapability).min(1).max(MAX_ASK_ITEMS),
})
export type IdentityAsk = z.infer<typeof identityAsk>

// The longest client id, name from a client's document and redirect a connect takes, then how long a connect waits for
// the human before it lapses
export const MAX_CLIENT_ID_LENGTH = 255
export const MAX_CLIENT_NAME_LENGTH = 128
export const MAX_REDIRECT_LENGTH = 2048
export const CONSENT_LAPSE_MS = 60_000

// A client's name as its document gives it
export const clientName = seenText(MAX_CLIENT_NAME_LENGTH)

// A client's connect the core raises alone from core.consentAsk, never one security.request carries. plugin is the
// plugin whose host half asked, which sets field on the calls it makes for the client once the human confirmed it,
// client is the client id, clientHost its host when it is a URL with one and null otherwise, name the one its document
// gives or null, redirect where the client gets its answer and redirectHost that address's host, both null for a client
// on this computer that reaches the plugin over its local pipe. The core took both hosts. A Confirm changes no state
export const consentAsk = z.strictObject({
  kind: z.literal('consent.ask'),
  plugin: pluginId,
  client: screenText(MAX_CLIENT_ID_LENGTH),
  clientHost: screenText(MAX_CLIENT_ID_LENGTH).nullable(),
  name: clientName.nullable(),
  redirect: screenText(MAX_REDIRECT_LENGTH).nullable(),
  redirectHost: screenText(MAX_REDIRECT_LENGTH).nullable(),
  field: label,
}).refine(given => (given.redirect === null) === (given.redirectHost === null), 'redirectHost beside redirect only')
export type ConsentAsk = z.infer<typeof consentAsk>

export type Change = z.infer<typeof change> | ClassRaised | IdentityAsk | ConsentAsk
export type ChangeKind = Change['kind']

// What applying a change does to what hetu lets through. A narrowing change applies at once with its record. A
// widening one waits for the human's Confirm in the trusted window and so does one that destroys data
export type ChangeEffect = 'narrows' | 'widens' | 'destroys'

// A security control, or a core module that watches though it is none, whose off widens
const guards = (id: string) => isSecurityControl(id) || (watchingModuleIds as readonly string[]).includes(id)

// Read from the change's structure alone, never from what a plugin says about it or from the state, so no change
// applied meanwhile can move it. A security control switched off widens and switched back on narrows, every other plugin
// the other way round. A switch that weakens a check widens when it goes on. A limit waits for the Confirm either way:
// a higher value widens and a lower one can starve hetu's own controls or its audit, which the core can't tell apart
// from a safe one
export function changeEffect(change: Change): ChangeEffect {
  switch (change.kind) {
    case 'plugin.approve':
    case 'plugin.update':
    case 'grant.widen':
    case 'item.on':
    case 'luoshu.pick':
      return 'widens'
    case 'grant.narrow':
    case 'item.off':
    case 'identity.revoke':
      return 'narrows'
    case 'plugin.remove':
    case 'plugin.clearStorage':
    case 'plugin.reset':
      return 'destroys'
    case 'plugin.on':
      return guards(change.plugin) ? 'narrows' : 'widens'
    case 'plugin.off':
      return guards(change.plugin) ? 'widens' : 'narrows'
    case 'devMode':
    case 'exec.anyCommand':
    case 'skipVerification':
    case 'confirmOff':
    case 'allowUnsigned':
      return change.on ? 'widens' : 'narrows'
    case 'limit.set':
      return 'widens'
    // Only the core raises one and it always waits for the human
    case 'class.raised':
    case 'identity.ask':
    case 'consent.ask':
      return 'widens'
  }
}

// How long a request of this kind waits for the human before it lapses, null for one that waits until answered. Only
// a request a plugin's call brought about lapses, since the call that asked is long over
export function lapseOf(change: Change): number | null {
  if (change.kind === 'consent.ask') return CONSENT_LAPSE_MS
  return change.kind === 'identity.ask' ? IDENTITY_ASK_LAPSE_MS : null
}

// The plugins whose stop withdraws a waiting request of this kind, since what it would apply is theirs to use. An ask
// is for the pair of the root plugin, made by the plugin it called, a connect is the asking plugin's to collect
export function withdrawnWith(change: Change): readonly string[] {
  if (change.kind === 'consent.ask') return [change.plugin]
  return change.kind === 'identity.ask' ? [change.plugin, change.root] : []
}
