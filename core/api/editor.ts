import { z } from 'zod'
import { screenText } from './capabilities.ts'
import type { RefusalCode } from './envelope.ts'
import { floorConstants } from './floor.ts'
import { localName } from './ids.ts'
import { frozen, plain, table } from './plain.ts'
import { VERSION } from './version.ts'

// The editor bridge: what a plugin's worker sends the drawer on its port and what comes back, shaped like CodeMirror.
// The drawer serves it in the editor window and asks the core what each plugin may do with each note. A verb reaches
// a note only with the plugin's luoshu.read covering its path, an edit with luoshu.write too, and the ui item named
// here. Instances and versions are the drawer's: an instance is one open note and its version counts the changes made
// to it since it opened

export const editorVerbs = frozen(['editor.instances', 'editor.read', 'editor.decorate', 'editor.edit', 'editor.bind', 'editor.keys'] as const)
export type EditorVerb = typeof editorVerbs[number]

export type VerbNeeds = { readonly read: boolean, readonly write: boolean, readonly ui: 'ui.decoration' | 'ui.command' | 'ui.keys' | null }

// instances lists only notes the plugin reads, so it needs no read of its own. bind and keys name no note: a command
// says which instance it came from and a key event goes only to a plugin that reads the focused note
export const verbNeeds: Readonly<Record<EditorVerb, VerbNeeds>> = table({
  'editor.instances': { read: false, write: false, ui: null },
  'editor.read': { read: true, write: false, ui: null },
  'editor.decorate': { read: true, write: false, ui: 'ui.decoration' },
  'editor.edit': { read: true, write: true, ui: null },
  'editor.bind': { read: false, write: false, ui: 'ui.command' },
  'editor.keys': { read: false, write: false, ui: 'ui.keys' },
})

// The looks a mark may ask for, drawn with the drawer's own classes. A plugin sends no class and no CSS
export const markStyles = frozen(['strong', 'em', 'strike', 'highlight', 'code', 'link', 'muted', 'error', 'warning', 'info'] as const)
export const lineStyles = frozen(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'codeblock', 'rule'] as const)

// Marks one plugin holds on one note, across its sets, and the sets they're in
export const MAX_MARKS = 5000
export const MAX_MARK_SETS = 16
// What one plugin may have the drawer do in a second: marks drawn and note text read. Past either a call answers
// throttled, so no plugin keeps the editor page busy
export const MARKS_PER_SECOND = 20_000
export const READ_CHARS_PER_SECOND = 4 * 1024 * 1024
export const MAX_WIDGET_TEXT = 200
export const MAX_BINDINGS = 64
// Change sets the drawer keeps per instance to map late data. Data made for an older version is dropped or refused
export const MAX_KEPT_VERSIONS = 500
// Parts in one change list, each a kept length or a replacement
export const MAX_CHANGE_PARTS = 20_000

const position = z.int().min(0)
// The drawer's own ids for open notes, which say nothing about the note
const instance = z.string().regex(/^n[0-9]{1,12}$/)
const version = z.int().min(0)

const range = { from: position, to: position }
export const mark = z.union([
  z.strictObject({ kind: z.literal('mark'), ...range, style: z.enum(markStyles) }).refine(m => m.to > m.from, 'an empty range'),
  z.strictObject({ kind: z.literal('hide'), ...range }).refine(m => m.to > m.from, 'an empty range'),
  // Replaces the range with the text, or sits at a point when the range is empty. Screen text, so nothing in it hides
  // or reorders what follows. The raw view still shows what it covers
  z.strictObject({ kind: z.literal('widget'), ...range, text: screenText(MAX_WIDGET_TEXT) }).refine(m => m.to >= m.from, 'to before from'),
  z.strictObject({ kind: z.literal('line'), from: position, style: z.enum(lineStyles) }),
])
export type Mark = z.infer<typeof mark>
export type MarkStyle = typeof markStyles[number]
export type LineStyle = typeof lineStyles[number]

// A change list as CodeMirror's ChangeSet.toJSON writes it: a kept length, or a replaced length with the lines put in
export const changeJson = z.array(z.union([position, z.tuple([position], z.string())])).max(MAX_CHANGE_PARTS)
export type ChangeJson = z.infer<typeof changeJson>

// A key as CodeMirror names one: up to four modifiers, then one printable character or a named key. A binding holds
// Mod, Ctrl, Alt or Meta, so what the human types into a note never reaches one
const key = z.string().max(40).regex(/^(?:(?:Mod|Ctrl|Alt|Shift|Meta)-){0,4}(?:[!-~]|[A-Z][A-Za-z0-9]{1,15})$/)
  .refine(spec => spec.split(/-(?!$)/).slice(0, -1).some(part => part !== 'Shift'), 'no modifier')

const head = { v: z.literal(VERSION), kind: z.literal('call'), id: z.int().min(1) }
export const bridgeCall = z.discriminatedUnion('verb', [
  z.strictObject({ ...head, verb: z.literal('editor.instances'), args: z.strictObject({}).optional() }),
  z.strictObject({ ...head, verb: z.literal('editor.read'), args: z.strictObject({ instance }) }),
  z.strictObject({
    ...head,
    verb: z.literal('editor.decorate'),
    // set names the plugin's own group of marks on the instance, which a new decorate of the same set replaces
    args: z.strictObject({ instance, version, set: localName, marks: z.array(mark).max(MAX_MARKS) }),
  }),
  z.strictObject({ ...head, verb: z.literal('editor.edit'), args: z.strictObject({ instance, version, changes: changeJson }) }),
  z.strictObject({
    ...head,
    verb: z.literal('editor.bind'),
    // Replaces every binding the plugin held. A key the drawer takes for itself never reaches a binding
    args: z.strictObject({ bindings: z.array(z.strictObject({ key, command: localName })).max(MAX_BINDINGS) }),
  }),
  z.strictObject({ ...head, verb: z.literal('editor.keys'), args: z.strictObject({ on: z.boolean() }) }),
])
export type BridgeCall = z.infer<typeof bridgeCall>

const checked = plain(bridgeCall, floorConstants.argumentBytes)

// A message from a plugin's port as the drawer reads it, null for anything that isn't a call it knows. The relay has
// already held the text to the plugin's cap
export function parseBridgeCall(text: string): BridgeCall | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = checked.safeParse(value)
  return parsed.success ? parsed.data : null
}

export type BridgeReply =
  | { v: typeof VERSION, kind: 'reply', id: number, ok: true, result: unknown }
  | { v: typeof VERSION, kind: 'reply', id: number, ok: false, refusal: { code: RefusalCode } }

export function reply(id: number, result: unknown): BridgeReply {
  return { v: VERSION, kind: 'reply', id, ok: true, result }
}

export function refused(id: number, code: RefusalCode): BridgeReply {
  return { v: VERSION, kind: 'reply', id, ok: false, refusal: { code } }
}

// What the drawer tells a plugin unasked. Each event about an instance goes only to plugins that read its note
export type BridgeEvent = { v: typeof VERSION, kind: 'event' } & (
  | { topic: 'editor.opened' | 'editor.closed', instance: string }
  | { topic: 'editor.changed', instance: string, version: number, changes: ChangeJson }
  | { topic: 'editor.command', command: string, instance: string | null }
  | { topic: 'editor.key', instance: string, key: string }
)

// What each verb answers with
export type BridgeResults = {
  'editor.instances': { instances: { instance: string, path: string, version: number }[] }
  'editor.read': { text: string, version: number, selection: { anchor: number, head: number }[] }
  'editor.decorate': { version: number }
  'editor.edit': { version: number }
  'editor.bind': null
  'editor.keys': null
}
