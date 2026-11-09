import { z } from 'zod'
import { VERSION } from './envelope.ts'
import { MAX_ID_LENGTH, pluginId } from './ids.ts'
import { pluginVersion } from './install.ts'
import { API_VERSION, MAX_LIST } from './manifest.ts'
import { frozen } from './plain.ts'

// Why a plugin is refused, found, waiting, off, stopped, crashed or failed, as the plugin list shows it and init hands
// on as lastStop. Fixed codes, so none carries another principal's id, path or lease
export const stopReasons = frozen([
  // its check: files gone, a manifest outside the schema or naming another id, an api range outside this core, bytes
  // that don't match, a null signer allowUnsigned doesn't name, the first-party signer on another id, a reserved id, a
  // requires list it may not have, a slot, provider or guard id with no host half, a requires cycle, a state entry that
  // failed its check or is in a newer format
  'missing', 'invalid', 'install-only', 'id', 'api', 'tampered', 'unsigned', 'signer', 'reserved-id', 'requires',
  'place', 'cycle', 'entry', 'newer',
  // found with no entry yet, waiting for the human's approval
  'new',
  // its run: no ready in time, a start that threw, its way closed or flooded, held by its start marker, a throw from
  // the gate's stateChanged, a security control whose module gave no role
  'start-timeout', 'start-failed', 'closed', 'flood', 'marker', 'state-changed', 'no-role',
  // held back because a security control failed and hetu stopped
  'control-failed',
  // who stopped it: the human's switch, the watchdog, the human, the core's own shutdown, an update or a removal. A host
  // half switched back on after it ran waits for Restart hetu, since a host half starts once per run
  'off', 'watchdog', 'human', 'shutdown', 'update', 'removed', 'restart-hetu',
] as const)
export type StopReason = typeof stopReasons[number]

// What a requirement was when its dependent had to wait
export const dependencyWhys = frozen(['absent', 'new', 'off', 'refused', 'api', 'failed', 'crashed', 'waiting', 'stopped'] as const)
export type DependencyWhy = typeof dependencyWhys[number]

const whys = dependencyWhys.join('|')
const dependency = new RegExp(`^dependency:([a-z0-9]+(?:[_-][a-z0-9]+)*):(?:${whys})$`)

// A dependent names only its own direct requirement, an id it declared itself, with why that one can't serve it
export function dependencyReason(id: string, why: DependencyWhy): string {
  return `dependency:${id}:${why}`
}

export const reason = z.string().max(MAX_ID_LENGTH + 32, { abort: true }).refine(
  value => (stopReasons as readonly string[]).includes(value) || (dependency.test(value) && pluginId.safeParse(value.split(':')[1]).success),
  'not a fixed reason',
)

// What a plugin hears of each of its own requires and plugin.call targets: ready to call, starting, which the SDK
// retries, or not there
export const depStates = frozen(['ready', 'starting', 'unavailable'] as const)
export type DepState = typeof depStates[number]

const deps = z.record(pluginId, z.enum(depStates))
  .refine(entries => Object.keys(entries).length <= 2 * MAX_LIST, 'too many')
  .transform(entries => Object.assign(Object.create(null), entries) as typeof entries)

const head = { v: z.literal(VERSION) }

// The core's first message on a half's way. lastStop is why the plugin last stopped or waited in this run, null on its
// first start. previousVersion is the version an update replaced, until the new version reaches ready once. dataDir
// goes to an install plugin's host half only
export const init = z.strictObject({
  ...head,
  kind: z.literal('init'),
  id: pluginId,
  incarnation: z.int().positive(),
  api: z.literal(API_VERSION),
  deps,
  lastStop: reason.nullable(),
  previousVersion: pluginVersion.nullable(),
  dataDir: z.string().min(1).optional(),
})
export type Init = z.infer<typeof init>

// The state of the plugin's requires and plugin.call targets again, sent whenever one of them changes
export const depsMessage = z.strictObject({ ...head, kind: z.literal('deps'), deps })
export type Deps = z.infer<typeof depsMessage>

// From the plugin once its start resolved. Carries nothing, the way in names the half
export const ready = z.strictObject({ ...head, kind: z.literal('ready') })

// From the core: flush within graceMs and answer stopped, after which the way is ended either way
export const stop = z.strictObject({ ...head, kind: z.literal('stop'), graceMs: z.int().nonnegative() })
export type Stop = z.infer<typeof stop>

export const stopped = z.strictObject({ ...head, kind: z.literal('stopped') })

// The heartbeat on a worker's port. A plugin that misses heartbeatMisses in a row reads unresponsive until it answers
export const ping = z.strictObject({ ...head, kind: z.literal('ping') })
export const pong = z.strictObject({ ...head, kind: z.literal('pong') })
