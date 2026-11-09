import { describe, expect, it } from 'vitest'
import { coreKeyOf, keyName, normalKey } from '../frontend/mount/keys.ts'

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

describe('the core keys', () => {
  const at = (key: string, code: string, mods: { ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean } = {}) =>
    ({ ...press(key, mods), code })

  it('takes Mod with /, P, S and Q on a US layout', () => {
    expect(coreKeyOf(at('/', 'Slash', { ctrlKey: true }), false)).toBe('raw')
    expect(coreKeyOf(at('p', 'KeyP', { ctrlKey: true }), false)).toBe('open')
    expect(coreKeyOf(at('s', 'KeyS', { ctrlKey: true }), false)).toBe('save')
    expect(coreKeyOf(at('q', 'KeyQ', { metaKey: true }), true)).toBe('quit')
  })

  it('takes them by the physical key on a layout whose letters are not Latin', () => {
    expect(coreKeyOf(at('ы', 'KeyS', { ctrlKey: true }), false)).toBe('save')
    expect(coreKeyOf(at('з', 'KeyP', { ctrlKey: true }), false)).toBe('open')
  })

  it('takes the raw view where / needs Shift, as Ctrl+Shift+7 on a German layout', () => {
    expect(coreKeyOf(at('/', 'Digit7', { ctrlKey: true, shiftKey: true }), false)).toBe('raw')
  })

  it('leaves Mod with Shift on P, S and Q, Alt chords and keys without Mod to the editor and plugins', () => {
    expect(coreKeyOf(at('S', 'KeyS', { ctrlKey: true, shiftKey: true }), false)).toBe(null)
    expect(coreKeyOf(at('s', 'KeyS', { ctrlKey: true, altKey: true }), false)).toBe(null)
    expect(coreKeyOf(at('s', 'KeyS'), false)).toBe(null)
    expect(coreKeyOf(at('s', 'KeyS', { ctrlKey: true }), true)).toBe(null)
  })
})
