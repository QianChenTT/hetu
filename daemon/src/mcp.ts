import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { VaultError, type ErrorCode, type VaultCore } from './core.ts'
import { callContext } from './log.ts'

const INSTRUCTIONS = `hetu vault daemon. Every file in the vault (notes, artifacts, settings) is read and written through these tools, never with file or shell tools.
Workflow: acquire_lease on every file you will change (all at once) -> read_note for each -> edit_note or write_note with the version you read -> release_lease when done. Releasing makes one git commit holding exactly the leased files.
A lease expires after about 2 minutes without a write and is then committed as it is. On StaleVersion read the file again and retry. On LeaseHeld another writer has the file, wait or pick other work.`

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

// Errors that are part of normal agent work. Anything else (a path outside the vault, a write outside the lease,
// a lease id that doesn't exist) is a sign of a confused or misbehaving client and logs as a warning
const ROUTINE: ErrorCode[] = ['LeaseHeld', 'StaleVersion', 'TextNotFound', 'NotUnique', 'NotFound']

// The client names itself in each 2026-07-28 request. Self-reported, so it identifies nothing, but it helps reading the log
function clientName(ctx: unknown): string | undefined {
  const meta = (ctx as { mcpReq?: { _meta?: Record<string, unknown> } } | undefined)?.mcpReq?._meta
  const info = meta?.['io.modelcontextprotocol/clientInfo'] as { name?: string; version?: string } | undefined
  return info?.name ? `${info.name}${info.version ? `/${info.version}` : ''}` : undefined
}

// Never logs note text, old_text or new_text. Git has the content, the log only says who touched what
function summary(args: Record<string, unknown>) {
  const { lease_id, path, paths, folder, label } = args
  return { lease: lease_id, path, paths, folder, label }
}

function run(core: VaultCore, tool: string, args: Record<string, unknown>, ctx: unknown, task: () => Promise<unknown>): Promise<Result> {
  const parent = callContext.getStore() ?? {}
  return callContext.run({ ...parent, tool, client: clientName(ctx) ?? parent.client }, async (): Promise<Result> => {
    const started = performance.now()
    const ms = () => Math.round(performance.now() - started)
    try {
      const value = await task()
      core.events.emit('mcp.call', { ...summary(args), outcome: 'success', ms: ms() })
      return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
    } catch (err) {
      if (err instanceof VaultError) {
        core.events.emit(
          'mcp.call',
          { ...summary(args), outcome: 'failure', error: err.code, details: err.details, ms: ms() },
          ROUTINE.includes(err.code) ? 'info' : 'warn',
        )
        const body = { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true }
      }
      core.events.emit('mcp.call', { ...summary(args), outcome: 'error', error: String(err), ms: ms() }, 'error')
      throw err
    }
  })
}

const filePath = z.string().describe('Vault-relative path with forward slashes, for example notes/plan.md')
const version = z.string().describe('The version returned by read_note, acquire_lease or the last write')

// Built fresh for every HTTP request. All state lives in the shared core, so every session sees one lease table
export function buildServer(core: VaultCore): McpServer {
  const server = new McpServer({ name: 'hetu', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'list_notes',
    {
      description: 'List files in the vault (or one folder) with their versions and current lease holders',
      inputSchema: z.object({ folder: z.string().optional().describe('Vault-relative folder, omit for the whole vault') }),
      annotations: { readOnlyHint: true },
    },
    (args, ctx) => {
      const { folder } = args
      return run(core, 'list_notes', args, ctx, () => core.listNotes(folder))
    },
  )

  server.registerTool(
    'read_note',
    {
      description: 'Read a file. Returns its text, its version (pass it to edit_note or write_note) and who holds a lease on it',
      inputSchema: z.object({ path: filePath }),
      annotations: { readOnlyHint: true },
    },
    (args, ctx) => {
      const { path } = args
      return run(core, 'read_note', args, ctx, () => core.readNote(path))
    },
  )

  server.registerTool(
    'acquire_lease',
    {
      description:
        'Lease every file you are about to change, in one call. All or nothing: if any path is held by another writer the call fails with LeaseHeld and nothing is leased. Paths that do not exist yet can be leased to create them. Only leased files can be written with this lease',
      inputSchema: z.object({
        paths: z.array(filePath).min(1).describe('Every file this edit will touch'),
        label: z.string().optional().describe('Short name for you, shown to other writers and used as the commit author'),
        ttl_seconds: z.number().int().min(10).max(3600).optional().describe('Lease length, renewed by each write. Default 120'),
      }),
    },
    (args, ctx) => {
      const { paths, label, ttl_seconds } = args
      return run(core, 'acquire_lease', args, ctx, () => core.acquireLease(paths, label, ttl_seconds))
    },
  )

  server.registerTool(
    'edit_note',
    {
      description:
        'Replace one exact occurrence of old_text with new_text in a leased file. Fails with NotUnique if old_text appears more than once, StaleVersion if the file changed since base_version',
      inputSchema: z.object({
        lease_id: z.string(),
        path: filePath,
        old_text: z.string(),
        new_text: z.string(),
        base_version: version,
      }),
    },
    (args, ctx) => {
      const { lease_id, path, old_text, new_text, base_version } = args
      return run(core, 'edit_note', args, ctx, () => core.editNote(lease_id, path, old_text, new_text, base_version))
    },
  )

  server.registerTool(
    'write_note',
    {
      description:
        'Replace the whole text of a leased file, or create it. base_version is the version you read, or null to create a file that does not exist yet',
      inputSchema: z.object({
        lease_id: z.string(),
        path: filePath,
        text: z.string(),
        base_version: version.nullable(),
      }),
    },
    (args, ctx) => {
      const { lease_id, path, text, base_version } = args
      return run(core, 'write_note', args, ctx, () => core.writeNote(lease_id, path, text, base_version))
    },
  )

  server.registerTool(
    'release_lease',
    {
      description:
        'Finish editing. Makes one git commit holding exactly the leased files that changed and frees them for other writers. Always call this when done',
      inputSchema: z.object({
        lease_id: z.string(),
        message: z.string().optional().describe('What you changed and why, goes into the commit body'),
      }),
    },
    (args, ctx) => {
      const { lease_id, message } = args
      return run(core, 'release_lease', args, ctx, () => core.releaseLease(lease_id, message))
    },
  )

  server.registerTool(
    'note_history',
    {
      description: 'Recent commits that touched a file, newest first, with author and message',
      inputSchema: z.object({ path: filePath, limit: z.number().int().min(1).max(100).optional() }),
      annotations: { readOnlyHint: true },
    },
    (args, ctx) => {
      const { path, limit } = args
      return run(core, 'note_history', args, ctx, () => core.history(path, limit))
    },
  )

  return server
}
