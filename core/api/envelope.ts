import { z } from 'zod'
import { screenText } from './capabilities.ts'
import { floorConstants } from './floor.ts'
import { localName, MAX_QUALIFIED_LENGTH, pluginId, qualifiedName } from './ids.ts'
import { frozen, plainData } from './plain.ts'
import { pathProblem } from './scope.ts'

// The one version of the envelope. A message with another v is refused before any other field is read
export const VERSION = 1
export const MAX_LABEL_LENGTH = 512

// What travels on a port. Every message carries v and a kind
export const messageKinds = frozen([
  'init', 'ready', 'call', 'reply', 'cancel', 'event', 'ack', 'deps', 'ping', 'pong', 'stop', 'stopped',
] as const)
export type MessageKind = typeof messageKinds[number]

// The kind of a message in this version, or null for another version or no known kind. Read first, so nothing more of
// a message from another version is looked at
export function kindOf(message: unknown): MessageKind | null {
  if (typeof message !== 'object' || message === null) return null
  const { v, kind } = message as { v?: unknown, kind?: unknown }
  if (v !== VERSION || typeof kind !== 'string') return null
  return (messageKinds as readonly string[]).includes(kind) ? kind as MessageKind : null
}

// Call ids, request ids and content tokens. The core mints them at random, so only their shape is checked
export const token = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

// The caller's own label for one of the caller's clients, such as an OAuth client id, which can be a URL. The label
// reaches the callee, guards and the audit and grants nothing
const label = screenText(MAX_LABEL_LENGTH)

const requestFields = {
  v: z.literal(VERSION),
  kind: z.literal('call'),
  id: z.int().nonnegative(),
  action: qualifiedName,
  parent: token.optional(),
  onBehalf: label.optional(),
}

// A call as the caller sends one, exactly these fields. The sender comes from the way in, never from the message. id
// is the caller's own number for matching the reply and parent names a live call delivered on the same port
export const request = z.strictObject({ ...requestFields, args: plainData(floorConstants.argumentBytes) })
export type Request = z.infer<typeof request>

// The same envelope with args left unread. The carrier measures args against the caller's own cap, which the human may
// raise and the watchdog may lower
export const requestEnvelope = z.strictObject({ ...requestFields, args: z.unknown() })

// A caller giving up on a call of its own, named by the id it sent
export const cancel = z.strictObject({ v: z.literal(VERSION), kind: z.literal('cancel'), id: z.int().nonnegative() })

export const refusalCodes = frozen([
  'invalid', 'not-granted', 'not-found', 'needs-confirm', 'switched-off', 'unavailable', 'starting', 'policy-down',
  'guard-refused', 'guard-down', 'throttled', 'timeout', 'stopped', 'crashed', 'failed', 'stale', 'tampered',
] as const)
export type RefusalCode = typeof refusalCodes[number]

// Fixed, so a reason never carries another principal's id, path or lease (the A-05 lesson)
export const reasonCodes = frozen(['declined', 'too-large', 'cycle', 'dependency', 'reserved-id'] as const)
export type ReasonCode = typeof reasonCodes[number]

// action is the caller's own action, as far as the carrier could read one. request names the held security request
// behind needs-confirm
export const refusal = z.strictObject({
  code: z.enum(refusalCodes),
  action: z.string().max(MAX_QUALIFIED_LENGTH, { abort: true }),
  reason: z.enum(reasonCodes).optional(),
  request: token.optional(),
})
export type Refusal = z.infer<typeof refusal>

// The caller's id back with the core's call id, then the result or the refusal
const replyHead = { v: z.literal(VERSION), kind: z.literal('reply'), id: z.int().nonnegative(), callId: token }
export const reply = z.discriminatedUnion('ok', [
  z.strictObject({ ...replyHead, ok: z.literal(true), result: plainData(floorConstants.resultBytes) }),
  z.strictObject({ ...replyHead, ok: z.literal(false), refusal }),
])
export type Reply = z.infer<typeof reply>

export const windowRoles = frozen(['editor', 'trusted'] as const)
export type WindowRole = typeof windowRoles[number]

// Who made a call, as the way in names the caller. half is worker, host, page or a frame's name, which the manifest
// keeps apart from the other three. content is reserved for #97
export const caller = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plugin'), id: pluginId, half: localName, incarnation: z.int().positive() }),
  z.strictObject({ kind: z.literal('window'), role: z.enum(windowRoles), n: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal('content'), plugin: pluginId, token }),
])
export type Caller = z.infer<typeof caller>

// A call as the callee gets it. callId names it in the callee's answer and as the parent of the callee's sub-calls.
// deadline is in ms since the epoch. args were measured against the caller's cap on the way in
export const delivery = z.strictObject({
  v: z.literal(VERSION),
  kind: z.literal('call'),
  callId: token,
  caller,
  action: qualifiedName,
  args: z.unknown(),
  deadline: z.int().nonnegative(),
  onBehalf: label.optional(),
})
export type Delivery = z.infer<typeof delivery>

// The callee's answer to a delivered call. The carrier measures the result against the callee's own cap and builds the
// refusal the caller gets from the code and reason only, so a callee can't hand on a request id the core never made
const answerHead = { v: z.literal(VERSION), kind: z.literal('reply'), callId: token }
export const answer = z.discriminatedUnion('ok', [
  z.strictObject({ ...answerHead, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ ...answerHead, ok: z.literal(false), refusal }),
])
export type Answer = z.infer<typeof answer>

// The carrier telling a callee that a call delivered to it was given up, so its answer is no longer read
export const cancelled = z.strictObject({ v: z.literal(VERSION), kind: z.literal('cancel'), callId: token })

// The bus's own signals, which reach a subscriber unasked and outside its credits. events.dropped names topics the
// subscriber may have missed events on, so it reads again. events.ended names subscriptions the gate refused when the
// bus asked again
export const busSignals = frozen(['events.dropped', 'events.ended'] as const)
export type BusSignal = typeof busSignals[number]

// A path an event names, in the grammar a request's path holds
const eventPath = z.string().superRefine((value, ctx) => {
  const problem = pathProblem(value)
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
})

// An event as the bus pushes it: a topic and maybe a path, never content. seq counts the subscriber's events from 1 and
// is what an ack names. A topic in the events namespace is a signal and never an event
export const event = z.strictObject({
  v: z.literal(VERSION),
  kind: z.literal('event'),
  seq: z.int().positive(),
  topic: qualifiedName.refine(topic => !topic.startsWith('events.'), 'a signal'),
  path: eventPath.optional(),
})
export type BusEvent = z.infer<typeof event>

// A signal carries no seq, since no ack frees it. The topics it names are the subscriber's own
export const signal = z.strictObject({
  v: z.literal(VERSION),
  kind: z.literal('event'),
  topic: z.enum(busSignals),
  topics: z.array(qualifiedName).min(1),
})
export type Signal = z.infer<typeof signal>

// A subscriber done with its events up to seq, which gives the bus room to send it more. The SDK sends one per batch and
// one when it goes idle. A seq past the last event sent counts as the last
export const ack = z.strictObject({ v: z.literal(VERSION), kind: z.literal('ack'), seq: z.int().nonnegative() })
export type Ack = z.infer<typeof ack>
