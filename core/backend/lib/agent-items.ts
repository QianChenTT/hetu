import { z } from 'zod'
import { capabilityKey, folderCapabilities, folderCapability, type Capability } from '../../api/capabilities.ts'
import { agentLabel } from '../../api/envelope.ts'

// Items for agents an entry holds in all, across every agent
export const MAX_AGENT_ITEMS = 256
// One item of an agent's grant: the label the agent door names the agent by in the agent label's form and an item in
// the shape the plugin's own are in. Within one agent no item twice and the caps of a plugin's own list
export const agentItems = z.array(z.strictObject({ agent: agentLabel, capability: folderCapability }))
  .max(MAX_AGENT_ITEMS, { abort: true })
  .superRefine((items, ctx) => {
    const byAgent = new Map<string, Capability[]>()
    for (const { agent, capability } of items) byAgent.set(agent, [...byAgent.get(agent) ?? [], capability])
    for (const held of byAgent.values()) {
      if (new Set(held.map(capabilityKey)).size !== held.length) ctx.addIssue({ code: 'custom', message: 'an item twice for one agent' })
      if (!folderCapabilities.safeParse(held).success) ctx.addIssue({ code: 'custom', message: 'past the caps for one agent' })
    }
  })
