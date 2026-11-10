import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Caller } from 'hetu-core/api/envelope.ts'
import type { Call } from 'hetu-core/api/slots.ts'
import { createHistory, type History, type HistoryOptions } from '../src/history.ts'

export const git: Caller = { kind: 'plugin', id: 'git', half: 'worker', incarnation: 1 }
export const editor: Caller = { kind: 'window', role: 'editor', n: 0 }

export type Place = { base: string, notes: string, dataDir: string, installDir: string }

const made: string[] = []

// A notes folder with hetu's own folders beside it, each of which exists wherever hetu runs
export async function place(): Promise<Place> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-history-')))
  made.push(base)
  const where = { base, notes: path.join(base, 'notes'), dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') }
  for (const dir of [where.notes, where.dataDir, where.installDir]) await mkdir(dir, { recursive: true })
  return where
}

export async function cleanup(): Promise<void> {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

// History started on the data folder and opened on the notes folder
export async function started(where: Place, options: HistoryOptions = {}): Promise<History> {
  const history = createHistory(options)
  await history.start(where.dataDir)
  history.role.open({ folder: where.notes, dataDir: where.dataDir, installDir: where.installDir })
  return history
}

let n = 0
export type Asking = { caller?: Caller, onBehalf?: string }

export const callOf = (action: string, args: unknown, as: Asking = {}): Call => ({
  callId: `c${++n}`, caller: as.caller ?? git, action, args, deadline: Date.now() + 30000,
  ...(as.onBehalf !== undefined ? { onBehalf: as.onBehalf } : {}),
})

// prepare then perform, as the carrier makes a call. A refusal from either comes back as { refused }
export async function ask(history: History, action: string, args: unknown, as: Asking = {}): Promise<unknown> {
  const call = callOf(action, args, as)
  const prepared = await history.provider.prepare(call)
  if (!('scope' in prepared)) return { refused: prepared }
  try {
    return await history.provider.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  }
}

export type Listed = { commit: string, author: string, committer: string, date: string, message: string }
export const commitOf = async (history: History, paths: string[], message = 'save', as: Asking = {}) =>
  (await ask(history, 'history.commit', { paths, message }, as) as { commit: string | null }).commit
export const logOf = async (history: History, at: string, limit?: number) =>
  (await ask(history, 'history.log', limit === undefined ? { path: at } : { path: at, limit }) as { commits: Listed[] }).commits
