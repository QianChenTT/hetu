// The core keys, which main reads off a window's input before the page and the editor page reads again: their names and
// how a key event is told to be one. Both sides need them, so they are the contract's

// A key event as both sides see it
export type Pressed = { key: string, ctrlKey: boolean, metaKey: boolean, altKey: boolean, shiftKey: boolean }

export const CORE_KEY_NAMES = Object.freeze(['raw', 'save', 'quit'] as const)
export type CoreKey = typeof CORE_KEY_NAMES[number]

// The core keys as the page takes them, before CodeMirror and any binding: Mod with /, S or Q and no Alt. Each is known
// by the character typed or by the physical key, so Mod+S saves on a layout whose S types another letter, and the raw
// view opens where / needs Shift, as on a German layout. S and Q take no Shift, which plugins may bind. Mod+P is a
// plugin's to bind
export function coreKeyOf(event: Pressed & { code: string }, mac: boolean): CoreKey | null {
  if (!(mac ? event.metaKey : event.ctrlKey) || event.altKey) return null
  if (event.key === '/' || event.code === 'Slash') return 'raw'
  if (event.shiftKey) return null
  const letter = event.key.toLowerCase()
  if (letter === 's' || event.code === 'KeyS') return 'save'
  if (letter === 'q' || event.code === 'KeyQ') return 'quit'
  return null
}
