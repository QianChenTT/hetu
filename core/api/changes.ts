import { z } from 'zod'
import { folderCapability, screenText } from './capabilities.ts'
import { floorConstantNames, MAX_TIMER_MS, timeConstants } from './floor.ts'
import { isSecurityControl, pluginId } from './ids.ts'
import { frozen } from './plain.ts'

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
  ...pluginKinds, ...grantKinds, 'luoshu.set', ...perPluginSwitches, ...switches, 'allowUnsigned', 'limit.set',
] as const)

export const change = z.discriminatedUnion('kind', [
  // plugin.off covers install and folder plugins alike
  z.strictObject({ kind: z.literal(pluginKinds), plugin: pluginId }),
  // Only folder plugins have grants to change, an install plugin's grants are its manifest
  z.strictObject({ kind: z.literal(grantKinds), plugin: pluginId, capability: folderCapability }),
  z.strictObject({ kind: z.literal('luoshu.set'), folder }),
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
])
export type Change = z.infer<typeof change>
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
    case 'luoshu.set':
      return 'widens'
    case 'grant.narrow':
    case 'item.off':
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
  }
}

// What the human types to prove attention before Confirm arms: a security control's id to switch it off and log to
// stop recording, the moments protection goes away. Every other Confirm has the input delay alone, so typing doesn't
// become a habit
export function mustType(change: Change): string | null {
  if (change.kind === 'plugin.off' && isSecurityControl(change.plugin)) return change.plugin
  if (change.kind === 'recordNothing' && change.on) return 'log'
  return null
}
