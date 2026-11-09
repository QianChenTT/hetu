import { z } from 'zod'
import { screenText } from './capabilities.ts'
import { bridgeCall } from './editor.ts'
import { floorConstants } from './floor.ts'
import { localName } from './ids.ts'
import { plain, plainData } from './plain.ts'
import { pathProblem } from './scope.ts'
import {
  MAX_CHILDREN_OF_SPLIT, MAX_FRAME_MESSAGE, MAX_NODE_TEXT, MAX_NODES, MAX_OPS, MAX_OPTIONS, MAX_PAYLOAD, MAX_TREE_DEPTH,
} from './ui-limits.ts'
import { VERSION } from './version.ts'

// What plugins draw in the editor window: themes as token values, trees of the drawer's building blocks and the ui
// verbs on a plugin's port to the drawer. Data, schemas and pure functions only, shared by the drawer and the SDK. A
// plugin sends data the drawer draws with its own blocks, never markup or a stylesheet, and every node is tagged with
// its owner by the drawer, never by the plugin

// ---- themes

// A theme sets these and nothing else. The drawer puts each on the base layer and the editor as --hetu-<name>, never
// on the banner, the raw view, titles, owner strips or the views menu
const color = z.string().max(7).regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
// Family names only, unquoted, so no value can close the property or load a font from anywhere
const font = z.string().max(200).regex(/^[A-Za-z0-9 _-]{1,40}(?:, ?[A-Za-z0-9 _-]{1,40}){0,5}$/)
const pixels = (min: number, max: number) => z.string().max(4).regex(/^[0-9]{1,2}px$/)
  .refine(value => Number.parseInt(value, 10) >= min && Number.parseInt(value, 10) <= max, `${min} to ${max}px`)

const tokenShapes = {
  'color-bg': color,
  'color-fg': color,
  'color-muted': color,
  'color-accent': color,
  'color-border': color,
  'color-surface': color,
  'color-editor-bg': color,
  'color-editor-fg': color,
  'color-selection': color,
  'font-ui': font,
  'font-editor': font,
  'font-mono': font,
  'font-size': pixels(10, 24),
  space: pixels(0, 32),
  radius: pixels(0, 16),
}
export type TokenName = keyof typeof tokenShapes
export const tokenNames: readonly TokenName[] = Object.freeze(Object.keys(tokenShapes) as TokenName[])
export type Tokens = Partial<Record<TokenName, string>>

export const themeSpec = z.strictObject({
  tokens: z.strictObject(Object.fromEntries(Object.entries(tokenShapes).map(([name, shape]) => [name, shape.optional()])) as {
    [K in TokenName]: z.ZodOptional<typeof tokenShapes[K]>
  }),
})
export type ThemeSpec = z.infer<typeof themeSpec>

// Each token given as the CSS variable the drawer sets
export function themeVariables(tokens: Tokens): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const name of tokenNames) {
    const value = tokens[name]
    if (value !== undefined) variables[`--hetu-${name}`] = value
  }
  return variables
}

// The editor's text against its background keeps WCAG's 4.5 to 1, else both fall back to hetu's own
export const MIN_CONTRAST = 4.5
export const DEFAULT_EDITOR_COLORS = Object.freeze({ fg: '#1f1f1f', bg: '#ffffff' })

function channels(hex: string): [number, number, number] {
  const digits = hex.slice(1)
  const full = digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits
  return [0, 2, 4].map(at => Number.parseInt(full.slice(at, at + 2), 16)) as [number, number, number]
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(value => {
    const s = value / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// WCAG's contrast ratio of two colors in the token grammar, 1 to 21
export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

// The editor's colors under a theme. The general colors stand in for the editor's own
export function editorColors(tokens: Tokens): { ok: boolean, fg: string, bg: string } {
  const fg = tokens['color-editor-fg'] ?? tokens['color-fg']
  const bg = tokens['color-editor-bg'] ?? tokens['color-bg']
  if (fg === undefined && bg === undefined) return { ok: true, ...DEFAULT_EDITOR_COLORS }
  const pair = { fg: fg ?? DEFAULT_EDITOR_COLORS.fg, bg: bg ?? DEFAULT_EDITOR_COLORS.bg }
  return contrast(pair.fg, pair.bg) >= MIN_CONTRAST ? { ok: true, ...pair } : { ok: false, ...DEFAULT_EDITOR_COLORS }
}

// ---- styles

export const MAX_STYLE_PROPERTIES = 64
export const MAX_STYLE_VALUE = 200

// The properties a plugin may set on its own nodes, as values the drawer puts in with style.setProperty, so a value
// never becomes a selector or a rule. Layout, box looks and text, nothing that loads, draws outside its box or
// stacks above its own layer
export const allowedStyles: ReadonlySet<string> = new Set([
  'display', 'position', 'top', 'right', 'bottom', 'left', 'inset', 'z-index', 'pointer-events',
  'flex', 'flex-direction', 'flex-wrap', 'flex-flow', 'flex-grow', 'flex-shrink', 'flex-basis', 'order',
  'justify-content', 'justify-items', 'justify-self', 'align-items', 'align-self', 'align-content', 'place-items',
  'place-content', 'place-self', 'gap', 'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-area', 'grid-column', 'grid-row', 'grid-auto-flow',
  'grid-auto-columns', 'grid-auto-rows',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio', 'box-sizing',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'overflow', 'overflow-x', 'overflow-y',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-width', 'border-style', 'border-color',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'outline', 'outline-offset',
  'color', 'background-color', 'opacity', 'box-shadow',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align',
  'text-decoration', 'text-transform', 'text-overflow', 'white-space', 'word-break', 'overflow-wrap', 'vertical-align',
  'cursor', 'user-select', 'visibility', 'transform', 'transition',
])

// Values with their own short list
const keywords: Readonly<Record<string, RegExp>> = Object.freeze({
  // fixed would leave the node's box. Sticky stays inside its scroll box
  position: /^(?:static|relative|absolute|sticky)$/,
  // Stacking only within the node's own layer, which the drawer's layers sit above
  'z-index': /^(?:auto|[0-9])$/,
  display: /^(?:block|inline|inline-block|flex|inline-flex|grid|inline-grid|none)$/,
  'pointer-events': /^(?:auto|none)$/,
})

// Anything that loads, escapes the value or names something outside it: url() and its kin, attr() and env(), escapes,
// comments, the end of a declaration or a rule, an at rule, !important and quotes
const loads = /url\(|image\(|image-set\(|cross-fade\(|element\(|expression\(|attr\(|env\(|paint\(|src\(|\\|\/\*|\*\/|[;{}<>@!"'`]/i
const token = /var\(--hetu-([a-z-]+)\)/g

function controls(value: string): boolean {
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function valueProblem(name: string, value: string): string | null {
  if (value.length > MAX_STYLE_VALUE) return `${name} is past ${MAX_STYLE_VALUE} characters`
  if (controls(value)) return `${name} holds a control character`
  if (loads.test(value)) return `${name} holds something that loads or escapes its value`
  const left = value.replace(token, (whole, found: string) => ((tokenNames as readonly string[]).includes(found) ? '' : whole))
  if (/var\(/i.test(left)) return `${name} names a variable that is no hetu token`
  const only = keywords[name]
  if (only !== undefined && !only.test(value.trim())) return `${name} takes no ${value}`
  return null
}

// Why a node's style is refused, null when the drawer takes it
export function styleProblem(style: Record<string, unknown>): string | null {
  const names = Object.keys(style)
  if (names.length > MAX_STYLE_PROPERTIES) return `more than ${MAX_STYLE_PROPERTIES} properties`
  for (const name of names) {
    if (!allowedStyles.has(name)) return `${name} is no property a plugin may set`
    const value = style[name]
    if (typeof value !== 'string') return `${name} is not text`
    const problem = valueProblem(name, value)
    if (problem !== null) return problem
  }
  return null
}

// ---- the tree

export {
  MAX_CHILDREN_OF_SPLIT, MAX_FRAME_MESSAGE, MAX_NODE_TEXT, MAX_NODES, MAX_OPS, MAX_OPTIONS, MAX_PAYLOAD, MAX_SURFACES, MAX_TREE_DEPTH,
} from './ui-limits.ts'

export type Style = Record<string, string>
export type PayloadType = 'note' | 'text'
// What a drag carries: a note's path or plain text. A path is only a name, so the target still needs its own grant
export type Payload = { type: PayloadType, value: string }

type Common = {
  id: string
  style?: Style
  hover?: Style
  focus?: Style
  pressed?: Style
  tip?: string
  // The owner hears a click on this node
  click?: boolean
  drag?: Payload
  accepts?: PayloadType[]
  // A drop zone for views, which only the layout marks
  zone?: string
}

export type UiNode = Common & (
  | { kind: 'box', children?: UiNode[] }
  | { kind: 'scroll', children?: UiNode[] }
  | { kind: 'text', text: string }
  | { kind: 'icon', src: string, alt?: string }
  | { kind: 'button', text: string, disabled?: boolean }
  | { kind: 'input', value: string, placeholder?: string, disabled?: boolean }
  | { kind: 'checkbox', checked: boolean, label?: string, disabled?: boolean }
  | { kind: 'select', value: string, options: { value: string, text: string }[], disabled?: boolean }
  | { kind: 'list', rowHeight: number, rows: UiNode[] }
  | { kind: 'split', direction: 'row' | 'column', children?: UiNode[], sizes?: number[], min?: number[], resizable?: boolean }
  | { kind: 'popover', anchor: string, side: 'below' | 'above' | 'left' | 'right', children?: UiNode[] }
  // The layout's alone: a view instance or every item in rank order, an editor instance or the current one, and the
  // title the drawer draws for a view or an editor instance
  | { kind: 'slot', instance?: string, items?: true }
  | { kind: 'editor', instance: string }
  | { kind: 'title', of: string }
)
export type NodeKind = UiNode['kind']

// The kinds and properties only the layout may place
export const layoutKinds: ReadonlySet<string> = new Set(['slot', 'editor', 'title'])

const nodeId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
export const viewInstance = z.string().regex(/^v[0-9]{1,12}$/)
export const editorInstance = z.string().regex(/^n[0-9]{1,12}$/)

const style = z.record(z.string().max(40), z.string()).superRefine((value, ctx) => {
  const problem = styleProblem(value)
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
})
const note = z.string().superRefine((value, ctx) => {
  const problem = pathProblem(value)
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
})
const payloadType = z.enum(['note', 'text'])
const payload = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('note'), value: note }),
  z.strictObject({ type: z.literal('text'), value: z.string().min(1).max(MAX_PAYLOAD) }),
])
const icon = z.string().refine(value => pathProblem(value) === null && /\.(?:svg|png)$/.test(value), 'an svg or png file of the plugin')
const label = z.string().max(MAX_NODE_TEXT)

const common = {
  id: nodeId,
  style: style.optional(),
  hover: style.optional(),
  focus: style.optional(),
  pressed: style.optional(),
  tip: z.string().max(200).optional(),
  click: z.boolean().optional(),
  drag: payload.optional(),
  accepts: z.array(payloadType).max(2).optional(),
  zone: localName.optional(),
}

// Sizes and minimums, one a child, held to the children it splits
function splitShape(value: { children?: unknown[] | undefined, sizes?: number[] | undefined, min?: number[] | undefined }): boolean {
  if (value.children === undefined) return value.sizes === undefined && value.min === undefined
  const count = value.children.length
  return count >= 2 && count <= MAX_CHILDREN_OF_SPLIT && (value.sizes?.length ?? count) === count && (value.min?.length ?? count) === count
}

export const node: z.ZodType<UiNode> = z.lazy(() => {
  const children = z.array(node).max(MAX_NODES).optional()
  return z.discriminatedUnion('kind', [
    z.strictObject({ ...common, kind: z.literal('box'), children }),
    z.strictObject({ ...common, kind: z.literal('scroll'), children }),
    z.strictObject({ ...common, kind: z.literal('text'), text: label }),
    z.strictObject({ ...common, kind: z.literal('icon'), src: icon, alt: z.string().max(200).optional() }),
    z.strictObject({ ...common, kind: z.literal('button'), text: label, disabled: z.boolean().optional() }),
    z.strictObject({
      ...common, kind: z.literal('input'), value: label, placeholder: z.string().max(200).optional(), disabled: z.boolean().optional(),
    }),
    z.strictObject({ ...common, kind: z.literal('checkbox'), checked: z.boolean(), label: label.optional(), disabled: z.boolean().optional() }),
    z.strictObject({
      ...common,
      kind: z.literal('select'),
      value: z.string().max(200),
      options: z.array(z.strictObject({ value: z.string().max(200), text: z.string().max(200) })).max(MAX_OPTIONS),
      disabled: z.boolean().optional(),
    }),
    z.strictObject({ ...common, kind: z.literal('list'), rowHeight: z.int().min(8).max(400), rows: z.array(node).max(MAX_NODES) }),
    z.strictObject({
      ...common,
      kind: z.literal('split'),
      direction: z.enum(['row', 'column']),
      children,
      sizes: z.array(z.int().min(0).max(16_384)).optional(),
      min: z.array(z.int().min(0).max(16_384)).optional(),
      resizable: z.boolean().optional(),
    }).refine(splitShape, 'sizes and minimums one a child, 2 to 8 children'),
    z.strictObject({ ...common, kind: z.literal('popover'), anchor: nodeId, side: z.enum(['below', 'above', 'left', 'right']), children }),
    z.strictObject({ ...common, kind: z.literal('slot'), instance: viewInstance.optional(), items: z.literal(true).optional() })
      .refine(value => (value.instance === undefined) !== (value.items === undefined), 'one instance or every item'),
    z.strictObject({ ...common, kind: z.literal('editor'), instance: z.union([editorInstance, z.literal('current')]) }),
    z.strictObject({ ...common, kind: z.literal('title'), of: z.union([viewInstance, editorInstance]) }),
  ]) as unknown as z.ZodType<UiNode>
})

export type Op =
  | { op: 'tree', root: UiNode }
  | { op: 'set', node: UiNode }
  | { op: 'props', node: UiNode }
  | { op: 'text', id: string, text: string }
  | { op: 'insert', parent: string, at: number, node: UiNode }
  | { op: 'remove', id: string }

// tree replaces the surface, set a node and its subtree by id, props every property of a node but its children, text
// the text of a text or button, insert a child at a place and remove a node with its subtree
export const op: z.ZodType<Op> = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('tree'), root: node }),
  z.strictObject({ op: z.literal('set'), node }),
  z.strictObject({ op: z.literal('props'), node }),
  z.strictObject({ op: z.literal('text'), id: nodeId, text: label }),
  z.strictObject({ op: z.literal('insert'), parent: nodeId, at: z.int().min(0).max(MAX_NODES), node }),
  z.strictObject({ op: z.literal('remove'), id: nodeId }),
]) as unknown as z.ZodType<Op>

type Step = { field: 'children' | 'rows', index: number }
type Found = { path: Step[], visited: number }

function kids(value: UiNode, field: Step['field']): UiNode[] | undefined {
  return (value as { children?: UiNode[], rows?: UiNode[] })[field]
}

// The way from the root to the node with that id, depth first
function find(root: UiNode, id: string): Found | null {
  let visited = 0
  const stack: { at: UiNode, path: Step[] }[] = [{ at: root, path: [] }]
  while (stack.length > 0) {
    const { at, path } = stack.pop() as { at: UiNode, path: Step[] }
    visited++
    if (at.id === id) return { path, visited }
    for (const field of ['rows', 'children'] as const) {
      const list = kids(at, field)
      if (list === undefined) continue
      for (let index = list.length - 1; index >= 0; index--) stack.push({ at: list[index] as UiNode, path: [...path, { field, index }] })
    }
  }
  return null
}


// A copy of the tree with the node at path replaced, or removed for null. Only the nodes on the way are copied
function replaced(root: UiNode, path: Step[], change: (found: UiNode) => UiNode | null): UiNode | null {
  if (path.length === 0) return change(root)
  const [step, ...rest] = path as [Step, ...Step[]]
  const list = [...(kids(root, step.field) as UiNode[])]
  const next = replaced(list[step.index] as UiNode, rest, change)
  if (next === null) list.splice(step.index, 1)
  else list[step.index] = next
  return { ...root, [step.field]: list } as UiNode
}

type Applied = { root: UiNode, visited: number } | { problem: string }

function applyOne(root: UiNode, each: Exclude<Op, { op: 'tree' }>): Applied {
  const target = each.op === 'set' || each.op === 'props' ? each.node.id : each.op === 'insert' ? each.parent : each.id
  const found = find(root, target)
  if (found === null) return { problem: `no node ${target}` }
  const { path, visited } = found
  let problem: string | null = null
  const next = replaced(root, path, at => {
    switch (each.op) {
      case 'set':
        return each.node
      case 'props': {
        if (each.node.kind !== at.kind) problem = `${target} is a ${at.kind}`
        else if ('children' in each.node) problem = 'props carries no children'
        const held = kids(at, 'children')
        return held === undefined ? each.node : { ...each.node, children: held } as UiNode
      }
      case 'text':
        if (at.kind !== 'text' && at.kind !== 'button') problem = `${target} holds no text`
        return { ...at, text: each.text } as UiNode
      case 'insert': {
        if (!['box', 'scroll', 'split', 'popover'].includes(at.kind)) problem = `${target} holds no children`
        const list = [...(kids(at, 'children') ?? [])]
        if (each.at > list.length) problem = `${target} has ${list.length} children`
        list.splice(each.at, 0, each.node)
        return { ...at, children: list } as UiNode
      }
      case 'remove':
        if (path.length === 0) problem = 'the root stays'
        return null
    }
  })
  if (problem !== null) return { problem }
  if (next === null) return { problem: 'the root stays' }
  return { root: next, visited }
}

// Why a whole tree is refused, with the nodes looked at
function treeProblem(root: UiNode, layout: boolean): { problem: string | null, visited: number } {
  const ids = new Set<string>()
  const anchors: string[] = []
  const stack: { at: UiNode, depth: number }[] = [{ at: root, depth: 1 }]
  let visited = 0
  while (stack.length > 0) {
    const { at, depth } = stack.pop() as { at: UiNode, depth: number }
    visited++
    if (visited > MAX_NODES) return { problem: `more than ${MAX_NODES} nodes`, visited }
    if (depth > MAX_TREE_DEPTH) return { problem: `deeper than ${MAX_TREE_DEPTH}`, visited }
    if (ids.has(at.id)) return { problem: `the id ${at.id} twice`, visited }
    ids.add(at.id)
    if (!layout && (layoutKinds.has(at.kind) || at.zone !== undefined)) return { problem: `only the layout places a ${at.kind === 'box' ? 'zone' : at.kind}`, visited }
    if (at.kind === 'split' && !splitShape(at)) return { problem: `the split ${at.id} doesn't match its children`, visited }
    if (at.kind === 'popover') anchors.push(at.anchor)
    for (const field of ['children', 'rows'] as const) for (const child of kids(at, field) ?? []) stack.push({ at: child, depth: depth + 1 })
  }
  const missing = anchors.find(anchor => !ids.has(anchor))
  return { problem: missing === undefined ? null : `a popover anchored to no node ${missing}`, visited }
}

// The surface after the operations, or why they are refused, in which case the surface keeps what it had. visited
// counts the nodes looked at, which the drawer charges against the plugin's second. layout says the owner is the
// layout, which alone places slots, editors, titles and zones
export function applyOps(tree: UiNode | null, ops: readonly Op[], options: { layout: boolean }): { tree: UiNode, visited: number } | { problem: string } {
  let root = tree
  let visited = 0
  for (const each of ops) {
    if (each.op === 'tree') {
      root = each.root
      continue
    }
    if (root === null) return { problem: 'no tree yet' }
    const step = applyOne(root, each)
    if ('problem' in step) return { problem: step.problem }
    visited += step.visited
    root = step.root
  }
  if (root === null) return { problem: 'no tree' }
  const checked = treeProblem(root, options.layout)
  if (checked.problem !== null) return { problem: checked.problem }
  return { tree: root, visited: visited + checked.visited }
}

// ---- the ui verbs on a plugin's port to the drawer

const head = { v: z.literal(VERSION), kind: z.literal('call'), id: z.int().min(1) }
const ops = z.array(op).max(MAX_OPS)
// A key as CodeMirror names one. A view's own bindings fire only while focus is in one of its instances, so a key
// without a modifier is the owner's own input there. The drawer refuses the core keys after naming them its way
const key = z.string().max(40).regex(/^(?:(?:Mod|Ctrl|Alt|Shift|Meta)-){0,4}(?:[!-~]|[A-Z][A-Za-z0-9]{1,15})$/)
export const MAX_VIEW_BINDINGS = 64

export const uiCall = z.discriminatedUnion('verb', [
  z.strictObject({ ...head, verb: z.literal('view.open'), args: z.strictObject({ view: localName }) }),
  z.strictObject({ ...head, verb: z.literal('view.close'), args: z.strictObject({ instance: viewInstance }) }),
  z.strictObject({ ...head, verb: z.literal('view.title'), args: z.strictObject({ instance: viewInstance, title: screenText(64) }) }),
  z.strictObject({ ...head, verb: z.literal('view.draw'), args: z.strictObject({ instance: viewInstance, ops }) }),
  z.strictObject({ ...head, verb: z.literal('view.post'), args: z.strictObject({ instance: viewInstance, data: plainData(MAX_FRAME_MESSAGE) }) }),
  z.strictObject({
    ...head,
    verb: z.literal('view.bind'),
    args: z.strictObject({ bindings: z.array(z.strictObject({ key, command: localName })).max(MAX_VIEW_BINDINGS) }),
  }),
  z.strictObject({ ...head, verb: z.literal('layout.draw'), args: z.strictObject({ ops }) }),
  // Opens a note in the editor, only inside the plugin's read or list scope. A drawer verb, since the drawer holds
  // the open notes and the plugin's port names its owner
  z.strictObject({ ...head, verb: z.literal('editor.open'), args: z.strictObject({ path: note }) }),
])
export type UiCall = z.infer<typeof uiCall>
export type UiVerb = UiCall['verb']

// The item each ui verb needs. editor.open needs the note inside the read or list scope too
export const uiNeeds: Readonly<Record<UiVerb, 'ui.view' | 'ui.layout'>> = Object.freeze({
  'view.open': 'ui.view',
  'view.close': 'ui.view',
  'view.title': 'ui.view',
  'view.draw': 'ui.view',
  'view.post': 'ui.view',
  'view.bind': 'ui.view',
  'layout.draw': 'ui.layout',
  'editor.open': 'ui.view',
})

const drawerCall = z.discriminatedUnion('verb', [...bridgeCall.options, ...uiCall.options])
export type DrawerCall = z.infer<typeof drawerCall>
const checked = plain(drawerCall, floorConstants.argumentBytes)

// A message from a plugin's port as the drawer reads it: an editor bridge call or a ui call, null for anything else
export function parseDrawerCall(text: string): DrawerCall | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = checked.safeParse(value)
  return parsed.success ? parsed.data : null
}

// ---- what the drawer tells plugins

// A view instance as the layout sees it: the manifest's title, never one set while running, which could carry a note's
// name. favorite is its place in the human's favorites. down says its owner isn't running
export type LayoutView = {
  instance: string
  owner: string
  view: string
  kind: 'view' | 'item'
  title: string
  size: { min?: number, preferred?: number, max?: number }
  priority: number | null
  favorite: number | null
  down: boolean
}

// What the layout plans from. slots are the sizes Chromium gave its slot and editor nodes. editors are the open notes
// by their opaque ids and current the one the human worked in last
export type LayoutState = {
  width: number
  height: number
  views: LayoutView[]
  editors: string[]
  current: string | null
  slots: Record<string, { width: number, height: number }>
}

// What the human did to a node. drop carries the payload the human dragged onto it
export type NodeEventType = 'click' | 'input' | 'change' | 'submit' | 'drop'

export type UiEvent = { v: typeof VERSION, kind: 'event' } & (
  | { topic: 'view.opened', instance: string, view: string }
  | { topic: 'view.closed', instance: string }
  | { topic: 'view.shown', instance: string, width: number, height: number }
  | { topic: 'view.hidden', instance: string }
  | { topic: 'view.event', instance: string, node: string, type: NodeEventType, value?: string | boolean, payload?: Payload }
  | { topic: 'view.message', instance: string, data: unknown }
  | { topic: 'view.command', instance: string, command: string }
  | { topic: 'view.resized', instance: string, node: string, sizes: number[] }
  | { topic: 'layout.state', state: LayoutState }
  | { topic: 'layout.event', node: string, type: NodeEventType, value?: string | boolean, payload?: Payload }
  | { topic: 'layout.drop', instance: string, zone: string, x: number, y: number }
  | { topic: 'layout.resized', node: string, sizes: number[] }
  | { topic: 'layout.open', instance: string }
  | { topic: 'layout.close', instance: string }
)
export type UiTopic = UiEvent['topic']

// What each ui verb answers with
export type UiResults = {
  'view.open': { instance: string }
  'view.close': null
  'view.title': null
  'view.draw': null
  'view.post': null
  'view.bind': null
  'layout.draw': null
  'editor.open': null
}
