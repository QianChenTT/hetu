import { describe, expect, it } from 'vitest'
import { keyName, normalKey } from '../frontend/mount/keys.ts'

const press = (key: string, mods: { ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean } = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

describe('naming a key', () => {
  it('names Ctrl as Mod off macOS and Cmd as Mod on it, then Alt and Shift, with a letter in lower case', () => {
    expect(keyName(press('K', { ctrlKey: true, shiftKey: true }), false)).toBe('Mod-Shift-k')
    expect(keyName(press('k', { metaKey: true }), true)).toBe('Mod-k')
    expect(keyName(press('/', { ctrlKey: true }), false)).toBe('Mod-/')
    expect(keyName(press('ArrowUp', { altKey: true }), false)).toBe('Alt-ArrowUp')
    expect(keyName(press('a'), false)).toBe('a')
  })

  it('keeps Ctrl apart on macOS and Meta apart off it', () => {
    expect(keyName(press('k', { ctrlKey: true }), true)).toBe('Ctrl-k')
    expect(keyName(press('k', { metaKey: true }), false)).toBe('Meta-k')
  })

  it('names a lone modifier as nothing', () => {
    expect(keyName(press('Shift', { shiftKey: true }), false)).toBe(null)
    expect(keyName(press('Control', { ctrlKey: true }), false)).toBe(null)
  })
})

describe('a key a binding names', () => {
  it('comes to the same name in any order, Ctrl read as Mod off macOS', () => {
    expect(normalKey('Shift-Mod-K', false)).toBe('Mod-Shift-k')
    expect(normalKey('Ctrl-k', false)).toBe('Mod-k')
    expect(normalKey('Alt-Mod-/', false)).toBe('Mod-Alt-/')
    expect(normalKey('Ctrl-k', true)).toBe('Ctrl-k')
    expect(normalKey('Mod--', false)).toBe('Mod--')
  })
})
