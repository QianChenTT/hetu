import { z } from 'zod'
import { providerActions } from './actions.ts'

// The provider actions an agent may call through mcp, each as the tool its row's agent entry makes. The core writes
// every word an agent reads here and no plugin adds to them

// One tool as MCP's tools/list answers it. inputSchema is the JSON Schema of what an agent sends
export type ListedTool = { name: string, description: string, inputSchema: Record<string, unknown> }

// A tool found by name: the provider action it calls and the schema an agent's arguments are parsed with first
export type FoundTool = { action: string, args: z.ZodObject }

// The tools in the provider table's order, made afresh each call so no caller can change what the next one reads
export function toolList(): ListedTool[] {
  const listed: ListedTool[] = []
  for (const spec of Object.values(providerActions)) {
    if (spec.agent === undefined) continue
    const { name, description, args } = spec.agent
    listed.push({ name, description, inputSchema: z.toJSONSchema(args, { io: 'input' }) as Record<string, unknown> })
  }
  return listed
}

// The tool an agent named, null for a name no row's agent entry holds. The action is always the row the entry sits on
export function toolFor(name: string): FoundTool | null {
  for (const [action, spec] of Object.entries(providerActions)) {
    if (spec.agent !== undefined && spec.agent.name === name) return { action, args: spec.agent.args }
  }
  return null
}
