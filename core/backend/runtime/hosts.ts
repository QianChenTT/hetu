import type { run } from '../../sdk/plugin.ts'

// Whether a module's default export is a plugin the SDK runs, as the utility process checks a utility half's
export function isPlugin(value: unknown): value is Parameters<typeof run>[0] {
  if (typeof value !== 'object' || value === null) return false
  const { kind, spec } = value as { kind?: unknown, spec?: { start?: unknown } }
  return kind === 'hetu-plugin' && typeof spec?.start === 'function'
}
