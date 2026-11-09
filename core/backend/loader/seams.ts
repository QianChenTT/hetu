import type { Caller } from '../../api/envelope.ts'
import type { FloorConstant } from '../../api/floor.ts'
import type { Capabilities, Gate, Guard, LuoshuRole, Provider, StorageRole, Watchdog } from '../../api/slots.ts'
import type { Field } from '../../lib/event-log.ts'
import type { PluginFile } from '../../lib/hash-files.ts'
import type { Landing, Port } from '../carrier/seams.ts'

// The carrier says what became of a floor record, so the type lives with it
export type { Landing }

// What the loader needs from the carrier, a small interface the loader's tests fake. register, handle and end are the
// carrier's own. The join builds send, record, changed, stopping and limit in the carrier
export type CarrierLink = {
  // Binds a half's port to its caller. The loader calls it in the same step that mints the port
  register(port: Port, caller: Caller): void
  // A host half's in-process way in, bound like a port
  handle(caller: Caller, receive: (message: unknown) => void): { post: (message: unknown) => void }
  // Ends a way: a planned stop or a revoked incarnation. Its calls answer code and nothing more arrives from it
  end(caller: Caller, code?: 'stopped' | 'crashed'): void
  // A lifecycle message down a half's own way: init, deps or stop. Dropped when the way is gone
  send(caller: Caller, message: unknown): void
  // A floor record into the floor lane, never blocking. The promise settles with landed once that
  // one record is on disk. It settles at once with muted while the human turned recording off. It settles with lost
  // when the backlog dropped it, the log refused it or the lane closed with it still waiting. It never rejects. A copy,
  // an update or a restore applies only on landed or muted, so a record the log can't write yet holds the change back
  // until it lands or the loader gives up. A loader that gives up aborts signal, which takes a record still waiting
  // out of the backlog and settles it lost
  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing>
  // A slot state, a plugin state or the StateView changed, so the carrier asks the gate about live subscriptions again
  changed(): void
  // Shutdown has begun. The six slot states have no stopping and the carrier reads anything else as failed, so
  // shutdown says so here instead. From this call on the carrier answers stopped where it would answer policy-down,
  // guard-down or unavailable for a slot, a guard or a provider that is down. It writes no slot change as a failure
  // either. The loader keeps reporting the six states, a guard stopping or stopped for shutdown as failed, so nothing
  // passes unguarded and nothing reads as down
  stopping(): void
  // Writes what the audit queue and the floor backlog hold, waiting at most ms, and gives back how many records still
  // wait. Record nothing's switch drains first, so its own record is the last one written
  drain(ms: number): Promise<number>
  // Recording didn't go off after a drain, so the audit writer goes on
  resume(): void
  // A floor constant as it applies to one plugin: the human's value for it or for all, lowered by the watchdog. The
  // loader takes readyMs and stopGraceMs from here so both follow the same values the carrier enforces
  limit(plugin: string, name: FloorConstant): number
}

// What a host half's module gives the core once imported: the role interfaces it holds. The carrier asks them
// through the loader, which hands one on only while its plugin is ready
export type HostExports = { gate?: Gate, guard?: Guard, provider?: Provider, watchdog?: Watchdog, luoshu?: LuoshuRole, capabilities?: Capabilities, storage?: StorageRole }

// A host half's end of its in-process way. Messages the carrier sends before listen are kept for it
export type HostLink = { post(message: unknown): void, listen(listener: (message: unknown) => void): void }

export type WorkerStart = { id: string, incarnation: number, code: Buffer, port: unknown }
export type HostStart = { id: string, incarnation: number, root: string, files: readonly PluginFile[], entry: string, link: HostLink }

// What the loader needs from the runtime, the only part that touches Electron, faked in the loader's tests
export type Runtime = {
  // Both ends of a new channel for plugin id: core for the carrier and plugin for the half's code. MessageChannelMain in
  // Electron, whose core end reads only text within the plugin's cap
  channel(id: string): { core: Port, plugin: unknown }
  // Starts a worker from the verified bytes. The worker host page gets { id, incarnation, code } and the port. A throw
  // means it couldn't start
  startWorker(start: WorkerStart): void
  // Imports a host half from the verified files and starts it on its link. Resolves with the roles the module holds. A
  // throw or a rejection marks the half failed. root is where the files came from, for the import hook the Electron
  // runtime picks
  startHost(start: HostStart): Promise<HostExports>
  // Ends a worker with terminate(). Ending one already dead decides nothing
  terminate(id: string, incarnation: number): void
}
