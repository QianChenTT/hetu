// Key names as the drawer compares them: Mod, Ctrl, Alt, Shift and Meta in that order, then the key, a single character
// in lower case. Mod is Ctrl off macOS and Cmd on it, as CodeMirror reads it, so a binding and a key pressed name the
// same key whichever way a plugin spelled it

type Pressed = { key: string, ctrlKey: boolean, metaKey: boolean, altKey: boolean, shiftKey: boolean }

const ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta']
const lone = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'OS'])

function named(mods: Set<string>, key: string): string {
  const base = key.length === 1 ? key.toLowerCase() : key
  return [...ORDER.filter(mod => mods.has(mod)), base].join('-')
}

// A key event's name, null for a modifier pressed alone
export function keyName(event: Pressed, mac: boolean): string | null {
  if (lone.has(event.key)) return null
  const mods = new Set<string>()
  if (mac ? event.metaKey : event.ctrlKey) mods.add('Mod')
  if (mac && event.ctrlKey) mods.add('Ctrl')
  if (!mac && event.metaKey) mods.add('Meta')
  if (event.altKey) mods.add('Alt')
  if (event.shiftKey) mods.add('Shift')
  return named(mods, event.key)
}

// A key a binding names, in the same form. Ctrl off macOS and Cmd on it are Mod
export function normalKey(spec: string, mac: boolean): string {
  const parts = spec.split(/-(?!$)/)
  const key = parts.pop() ?? ''
  const mods = new Set<string>()
  for (const part of parts) {
    if (part === 'Mod' || part === 'Cmd' || (mac ? part === 'Meta' : part === 'Ctrl')) mods.add('Mod')
    else mods.add(part)
  }
  return named(mods, key)
}
