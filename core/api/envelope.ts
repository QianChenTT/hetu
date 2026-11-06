import { z } from 'zod'
import { screenText } from './capabilities.ts'
import { floorConstants } from './floor.ts'
import { localName, MAX_QUALIFIED_LENGTH, pluginId, qualifiedName } from './ids.ts'
import { frozen, plainData } from './plain.ts'

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

// A call as the caller sends one, exactly these fields. The sender comes from the way in, never from the message. id
// is the caller's own number for matching the reply and parent names a live call delivered on the same port
export const request = z.strictObject({
  v: z.literal(VERSION),
  kind: z.literal('call'),
  id: z.int().nonnegative(),
  action: qualifiedName,
  args: plainData(floorConstants.argumentBytes),
  parent: token.optional(),
  onBehalf: label.optional(),
})
export type Request = z.infer<typeof request>

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
