import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// What the daemon knows and git doesn't: who asked for what, what was refused and why, what was read, versions between
// commits and writes that bypassed the daemon. Never the content, the diff or the commit's own fields, git has those

export type Level = 'info' | 'warn' | 'error'
export type Event = { ts: string; level: Level; event: string; [field: string]: unknown }

// Set per HTTP request and per tool call, so every event of one call carries the same req id, client and tool
export type CallContext = { req?: string; era?: string; client?: string; ua?: string; tool?: string; source?: string }
export const callContext = new AsyncLocalStorage<CallContext>()

// Kept outside the vault: anything inside it can be rewritten by an agent through write_note
export const DEFAULT_LOG_DIR = process.env.HETU_LOG_DIR ?? path.join(homedir(), '.hetu', 'logs')

export type EventLogOptions = { dir?: string | null; console?: boolean; onEvent?: (e: Event) => void }

export class EventLog {
  private readonly dir: string | null
  private readonly toConsole: boolean
  private readonly onEvent?: (e: Event) => void

  constructor(options: EventLogOptions = {}) {
    this.dir = options.dir === undefined ? DEFAULT_LOG_DIR : options.dir
    this.toConsole = options.console ?? false
    this.onEvent = options.onEvent
    if (this.dir) mkdirSync(this.dir, { recursive: true })
  }

  // One JSON object per line, one file per UTC day
  file(date = new Date()): string | null {
    return this.dir ? path.join(this.dir, `daemon-${date.toISOString().slice(0, 10)}.jsonl`) : null
  }

  emit(event: string, fields: Record<string, unknown> = {}, level: Level = 'info'): void {
    const now = new Date()
    const ctx = callContext.getStore() ?? {}
    const entry: Event = { ts: now.toISOString(), level, event, ...ctx, ...fields }
    for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k]
    const file = this.file(now)
    // Sync append keeps lines whole and in order, the volume is a few lines per tool call
    if (file) appendFileSync(file, JSON.stringify(entry) + '\n')
    if (this.toConsole) {
      const { ts, level: l, event: e, ...rest } = entry
      const detail = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      console.log(`[hetu] ${ts.slice(11, 19)} ${l.padEnd(5)} ${e} ${detail.join(' ')}`)
    }
    this.onEvent?.(entry)
  }
}

// Versions are sha256 hex. 12 characters are enough to match a log line to a tool result
export const short = (version: string | null | undefined) => (version ? version.slice(0, 12) : version)
