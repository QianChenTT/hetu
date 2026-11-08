import { run } from '../../sdk/plugin.ts'
import type { HostExports, HostStart } from '../loader/seams.ts'

const ROLES = ['gate', 'guard', 'provider', 'watchdog'] as const

export type HostLoading = {
  // Freezes the built-ins, before the first host half's code runs
  freeze(): void
  importer(url: string): Promise<unknown>
}

function isPlugin(value: unknown): value is Parameters<typeof run>[0] {
  if (typeof value !== 'object' || value === null) return false
  const { kind, spec } = value as { kind?: unknown, spec?: { start?: unknown } }
  return kind === 'hetu-plugin' && typeof spec?.start === 'function'
}

// Imports a host half from the bytes the loader hashed, never from its path, as one data: module, which can import only
// Node's built-ins, so a host half is one bundle. Its default export is its plugin, run on its link like any half, and
// its role exports are what the carrier asks it for. A throw, a rejection or a module with no plugin marks it failed
export async function loadHost(start: HostStart, loading: HostLoading): Promise<HostExports> {
  const file = start.files.find(found => found.path === start.entry)
  if (file === undefined) throw new Error(`${start.entry} isn't among the files the loader hashed`)
  loading.freeze()
  const module = await loading.importer(`data:text/javascript;base64,${Buffer.from(file.bytes).toString('base64')}`) as Record<string, unknown>
  const plugin = module?.default
  if (!isPlugin(plugin)) throw new Error(`${start.entry} has no plugin as its default export`)
  run(plugin, start.link)
  const roles: Record<string, unknown> = {}
  for (const role of ROLES) {
    const held = module[role]
    if (typeof held === 'object' && held !== null) roles[role] = held
  }
  return roles as HostExports
}
