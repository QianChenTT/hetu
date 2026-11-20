import type { ActionResults, CoreViewsPlugin } from '../../api/actions.ts'
import { table } from '../../api/plain.ts'
import type { PluginInfo, PluginState } from '../../api/policy-jobs.ts'
import type { Read } from './verify.ts'

// What other parts read of a known plugin, built from its entry as the plugins manager holds it

const none: Readonly<Record<string, { readonly from?: readonly string[] }>> = table({})

// A known plugin as the router reads it from the plugin table: the running incarnation's number or the last one
type Known = Viewed & { readonly place: PluginInfo['place'], readonly live: { readonly n: number } | null, readonly incarnations: number }

export function infoOf(k: Known): PluginInfo {
  const manifest = k.read.manifest
  return {
    state: k.state,
    place: k.place,
    incarnation: k.live?.n ?? k.incarnations,
    serves: manifest?.entries.host !== undefined ? 'host' : 'worker',
    actions: manifest?.provides?.actions ?? none,
    topics: manifest?.provides?.topics ?? [],
  }
}

// A plugin as core.views reads it: its id, its state and what reading its bytes found
type Viewed = { readonly id: string, readonly state: PluginState, readonly read: Read }

// Each plugin that declares views or a theme, whatever its state, so the views menu lists a view whose plugin is down.
// Not one whose bytes failed their check or whose manifest is refused, since its text can't be trusted
export function viewsOf(known: Iterable<Viewed>): ActionResults['core.views'] {
  const plugins: CoreViewsPlugin[] = []
  for (const k of known) {
    const manifest = k.read.manifest
    if (manifest === null || k.read.problem !== null || k.state === 'refused') continue
    const views = manifest.views ?? {}
    if (Object.keys(views).length === 0 && manifest.theme === undefined) continue
    plugins.push({
      plugin: k.id, name: manifest.name, running: k.state === 'ready', worker: manifest.entries.worker !== undefined,
      views: { ...views }, theme: manifest.theme ?? null,
    })
  }
  return { plugins }
}
