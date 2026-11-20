import type { ActionResults, CoreViewsPlugin } from '../../api/actions.ts'
import type { PluginState } from '../../api/policy-jobs.ts'
import type { Read } from './verify.ts'
// What other parts read of a known plugin, built from its entry as the plugins manager holds it


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
