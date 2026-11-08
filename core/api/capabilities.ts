import { z } from 'zod'
import { pluginId, qualifiedName } from './ids.ts'
import { frozen } from './plain.ts'
import { hidesOnScreen, scope } from './scope.ts'

// Scopes one type may hold across a whole list, so one ** can't hide among hundreds of narrow ones
export const MAX_SCOPES_PER_TYPE = 64
// Entries in one list of capabilities
export const MAX_CAPABILITIES = 64
export const MAX_TEXT_LENGTH = 512

// Text a screen shows unchanged, so nothing in it can hide there or reorder what follows it
export function screenText(max: number) {
  return z.string().min(1).max(max, { abort: true }).refine(value => !hidesOnScreen(value), 'a character that could hide')
}

export const text = screenText(MAX_TEXT_LENGTH)

function scopes<T extends z.ZodType>(item: T) {
  return z.array(item).max(MAX_SCOPES_PER_TYPE)
}

// The fixed list. A new type needs a new core API version and a plugin can't invent one
export const capabilityTypes = frozen([
  'luoshu.read', 'luoshu.write', 'net.fetch', 'ui.panel', 'ui.decoration', 'ui.command', 'ui.statusBar', 'ui.keys',
  'events.subscribe', 'storage', 'history', 'exec', 'plugin.call', 'guard.hook', 'log.read',
] as const)

// Guards load only from the install, so a plugin-folder manifest asking for one of these is refused and allow all
// never covers them
export const installOnlyTypes = frozen(['guard.hook'] as const)

export const capability = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(['luoshu.read', 'luoshu.write']), paths: scopes(scope) }),
  z.strictObject({ type: z.literal('net.fetch'), hosts: scopes(text) }),
  z.strictObject({ type: z.literal(['ui.panel', 'ui.decoration', 'ui.command', 'ui.statusBar', 'ui.keys']) }),
  z.strictObject({ type: z.literal('events.subscribe'), topics: scopes(qualifiedName) }),
  z.strictObject({ type: z.literal('storage') }),
  // Paths too, so history reaches no note the plugin can't name
  z.strictObject({ type: z.literal('history'), access: z.enum(['read', 'commit']), paths: scopes(scope) }),
  // Exact argument arrays, never a string a shell would split
  z.strictObject({
    type: z.literal('exec'),
    commands: scopes(z.array(text).min(1).max(MAX_SCOPES_PER_TYPE)),
    env: scopes(text),
  }),
  z.strictObject({ type: z.literal('plugin.call'), targets: scopes(pluginId) }),
  z.strictObject({ type: z.literal('guard.hook') }),
  z.strictObject({ type: z.literal('log.read') }),
])
export type Capability = z.infer<typeof capability>
export type CapabilityType = Capability['type']

export function isInstallOnly(type: string): boolean {
  return (installOnlyTypes as readonly string[]).includes(type)
}

export const folderCapability = capability.refine(granted => !isInstallOnly(granted.type), 'a type only install plugins hold')

// Counted per type and scope field across the list, so splitting a type over many entries doesn't get past the cap
function capped<T extends z.ZodType<Capability>>(item: T) {
  return z.array(item).max(MAX_CAPABILITIES).superRefine((list, ctx) => {
    const counts = new Map<string, number>()
    for (const granted of list) {
      for (const [field, value] of Object.entries(granted)) {
        if (!Array.isArray(value)) continue
        const key = `${granted.type} ${field}`
        const count = (counts.get(key) ?? 0) + value.length
        counts.set(key, count)
        if (count > MAX_SCOPES_PER_TYPE) {
          ctx.addIssue({ code: 'custom', message: `more than ${MAX_SCOPES_PER_TYPE} ${field} for ${granted.type}` })
          return
        }
      }
    }
  })
}

export const capabilities = capped(capability)
export const folderCapabilities = capped(folderCapability)

// One item as text that is the same whatever order its fields came in, so two copies of an item compare equal and an
// ask can name the item it would grant
export function capabilityKey(granted: Capability): string {
  const fields = granted as Record<string, unknown>
  return JSON.stringify(Object.keys(fields).sort().map(key => [key, fields[key]]))
}
