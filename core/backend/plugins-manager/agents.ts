import { agentHost } from '../../api/policy-jobs.ts'
import type { Plugin } from '../boot/header.ts'
import { cleared, handedBack, setAside } from './marks.ts'
import { PluginsLifecycle } from './lifecycle.ts'

// The revoked marks an older state may still hold on the agent host's entry or in the switches, carried through a
// Reset, a Remove and the next approval as before
export abstract class PluginsAgents extends PluginsLifecycle {
  // A mark dropped to make room for a newer one
  protected markDropped(dropped: readonly string[], agent: string | null): void {
    for (const target of dropped) this.note('agent.markDropped', { target, for: agent })
  }

  // Before the agent host's entry goes in a Reset or a Remove: its marks held in the switches
  protected async setMarksAside(id: string): Promise<void> {
    if (id !== agentHost) return
    const aside = setAside(this.state.switches, this.state.plugins[id] ?? null)
    if (aside === null) return
    await this.writeSwitches(aside.switches)
    this.markDropped(aside.dropped, null)
  }

  // The agent host's next entry with the marks the switches hold
  protected withMarks(id: string, entry: Plugin): Plugin {
    if (id !== agentHost) return entry
    const back = handedBack(entry, this.state.switches)
    this.markDropped(back.dropped, null)
    return back.entry
  }

  // Once the agent host's entry holds the marks, the switches hold none
  protected async marksHandedBack(id: string): Promise<void> {
    if (id !== agentHost) return
    const next = cleared(this.state.switches)
    if (next !== null) await this.writeSwitches(next)
  }
}
