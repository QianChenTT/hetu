import { z } from 'zod'
import { folderCapability, screenText } from './capabilities.ts'
import { floorConstantNames, MAX_TIMER_MS, timeConstants } from './floor.ts'
import { pluginId } from './ids.ts'
import { frozen } from './plain.ts'

export const MAX_FOLDER_LENGTH = 4096

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
// A folder on this machine. The loader checks that the folder is absolute, core/api has no path module
const folder = screenText(MAX_FOLDER_LENGTH)
const on = z.boolean()

const pluginKinds = [
  'plugin.approve', 'plugin.update', 'plugin.on', 'plugin.off', 'plugin.remove', 'plugin.restore', 'plugin.clearStorage',
] as const
const grantKinds = ['grant.widen', 'grant.narrow', 'item.on', 'item.off'] as const
const perPluginSwitches = ['devMode', 'exec.anyCommand'] as const
const switches = ['skipVerification', 'confirmOff', 'recordNothing'] as const

// What security.request carries, the only way the security state changes. Only hetu windows send one and only the
// trusted window's Confirm applies one that widens. Each names one target and never the state as a whole
export const changeKinds = frozen([
  ...pluginKinds, ...grantKinds, 'vault.set', ...perPluginSwitches, ...switches, 'allowUnsigned', 'limit.set',
] as const)

export const change = z.discriminatedUnion('kind', [
  // plugin.off covers install and folder plugins alike
  z.strictObject({ kind: z.literal(pluginKinds), plugin: pluginId }),
  // Only folder plugins have grants to change, an install plugin's grants are its manifest
  z.strictObject({ kind: z.literal(grantKinds), plugin: pluginId, capability: folderCapability }),
  z.strictObject({ kind: z.literal('vault.set'), folder }),
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
