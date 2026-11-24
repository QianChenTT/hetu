// A view frame's side of its view: the frame's script waits for the port the drawer sends on its first load and talks
// to its own plugin's worker over it, plain data as JSON text. The frame holds no power of its own: whatever it needs
// comes from its worker, which holds the plugin's grants. The port comes with hetu's theme as CSS variables and the
// drawer sends each change of theme on it as an object, never as text, so no worker message reads as one. The theme is
// offered: a frame may use it or ignore it. A note dragged out of the frame carries DRAG_PREFIX and a token hetu minted
// for the plugin and the note as its text/plain, which opens the note as the human's when dropped on the editor

export { DRAG_PREFIX } from '../api/ui-limits.ts'

// hetu's theme, each --hetu-<name> variable with its value
export type Theme = Readonly<Record<string, string>>

export type FrameView = {
  // Plain data to the plugin's worker
  post(data: unknown): void
  // What the worker posts, to one handler, a later one taking its place. What came before the first waits for it
  onMessage(handler: (data: unknown) => void): void
  theme(): Theme
  onTheme(handler: (theme: Theme) => void): void
  // Opens the note in front as the human's, as a click on a note row of a tree view does. Counted only right after the
  // human pressed in one of the plugin's frames or pressed Enter or Space in it, one open each time, so call it from
  // that click or key. Any other open does nothing: the worker's editor.open opens a note in the background
  open(path: string): void
  // A token for dragging the note out of the frame, null when the plugin's luoshu.read doesn't reach it. Set DRAG_PREFIX
  // and the token as the drag's text/plain on dragstart. A token opens the note once and lasts 30 minutes at most, so
  // ask when a row is drawn and again after each drag
  dragToken(path: string): Promise<string | null>
}

type FrameEvent = { source: unknown, data: unknown, ports: readonly MessagePort[] }

export type FrameScope = {
  readonly parent: unknown
  addEventListener(type: 'message', listener: (event: FrameEvent) => void): void
  removeEventListener(type: 'message', listener: (event: FrameEvent) => void): void
}

// Only --hetu- names with text values, whatever else comes
function themeOf(variables: unknown): Theme {
  const entries = typeof variables === 'object' && variables !== null ? Object.entries(variables) : []
  return Object.freeze(Object.fromEntries(entries.filter(([name, value]) => name.startsWith('--hetu-') && typeof value === 'string')))
}

// The most messages kept for the first handler, the oldest dropped past it
const MAX_WAITING = 100
// One connection a scope, so a second connect answers the same view
const connecting = new WeakMap<object, Promise<FrameView>>()

export function connect(scope: FrameScope = globalThis as unknown as FrameScope): Promise<FrameView> {
  const held = connecting.get(scope)
  if (held !== undefined) return held
  const made = new Promise<FrameView>(resolve => {
    const listener = (event: FrameEvent) => {
      const data = event.data as { v?: unknown, kind?: unknown, variables?: unknown } | null
      const port = event.ports[0]
      if (event.source !== scope.parent || data?.v !== 1 || data.kind !== 'view' || port === undefined) return
      scope.removeEventListener('message', listener)
      let theme = themeOf(data.variables)
      let onTheme: ((theme: Theme) => void) | null = null
      let onMessage: ((data: unknown) => void) | null = null
      const waiting: unknown[] = []
      // Each drag token asked for and not yet answered, by its number
      const tokens = new Map<number, (token: string | null) => void>()
      let asked = 0
      port.onmessage = message => {
        const sent = message.data as { v?: unknown, kind?: unknown, variables?: unknown, ask?: unknown, token?: unknown } | string | null
        if (typeof sent !== 'string') {
          const answer = sent?.v === 1 && sent.kind === 'drag-token' && typeof sent.ask === 'number' ? tokens.get(sent.ask) : undefined
          if (answer !== undefined) {
            tokens.delete(sent?.ask as number)
            answer(typeof sent?.token === 'string' ? sent.token : null)
          }
          if (sent?.v !== 1 || sent.kind !== 'theme') return
          theme = themeOf(sent.variables)
          onTheme?.(theme)
          return
        }
        let value: unknown
        try {
          value = JSON.parse(sent)
        } catch {
          return
        }
        if (onMessage !== null) onMessage(value)
        else if (waiting.push(value) > MAX_WAITING) waiting.shift()
      }
      resolve({
        post: value => port.postMessage(JSON.stringify(value)),
        onMessage: handler => {
          onMessage = handler
          // Each kept message reaches the handler even when it throws on one, the first throw going on after
          let thrown: { err: unknown } | null = null
          for (const value of waiting.splice(0)) {
            try {
              handler(value)
            } catch (err) {
              thrown ??= { err }
            }
          }
          if (thrown !== null) throw thrown.err
        },
        theme: () => theme,
        onTheme: handler => {
          onTheme = handler
        },
        // An object, which the drawer takes as asked of hetu and never hands the worker
        open: path => port.postMessage({ v: 1, kind: 'open', path }),
        dragToken: path => new Promise(resolve => {
          const ask = ++asked
          tokens.set(ask, resolve)
          port.postMessage({ v: 1, kind: 'drag-token', ask, path })
        }),
      })
    }
    scope.addEventListener('message', listener)
  })
  connecting.set(scope, made)
  return made
}
