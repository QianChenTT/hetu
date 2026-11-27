import { describe, expect, it } from 'vitest'
import { chordOf, keyOf } from './input.ts'

describe('the keys main\'s input route types', () => {
  it('names a letter, a capital, a digit and a named key the way a US layout sends them', () => {
    expect(keyOf('s')).toEqual({ key: 's', code: 'KeyS', accelerator: 'S', vk: 83, text: 's', shift: false, location: 0 })
    expect(keyOf('X')).toMatchObject({ key: 'X', code: 'KeyX', shift: true })
    expect(keyOf('7')).toMatchObject({ code: 'Digit7', text: '7' })
    expect(keyOf('ArrowDown')).toEqual({ key: 'ArrowDown', code: 'ArrowDown', accelerator: 'Down', vk: 40, shift: false, location: 0 })
    expect(keyOf('\n')).toMatchObject({ key: 'Enter', text: '\r' })
    for (const [name, vk] of [['Delete', 46], ['Home', 36], ['End', 35], ['PageUp', 33], ['PageDown', 34]] as const) expect(keyOf(name)).toMatchObject({ code: name, vk, shift: false })
  })

  it('names US punctuation and the shifted symbols by their physical key', () => {
    expect(keyOf('/')).toMatchObject({ code: 'Slash', vk: 191, text: '/', shift: false })
    expect(keyOf('?')).toMatchObject({ code: 'Slash', accelerator: '/', text: '?', shift: true })
    expect(keyOf('+')).toMatchObject({ code: 'Equal', accelerator: '=', shift: true })
    expect(keyOf('!')).toMatchObject({ code: 'Digit1', accelerator: '1', text: '!', shift: true })
    expect(keyOf('(')).toMatchObject({ code: 'Digit9', shift: true })
    expect(keyOf('"')).toMatchObject({ code: 'Quote', shift: true })
  })

  it('refuses a key or a modifier it doesn\'t model rather than guess', () => {
    expect(() => keyOf('é')).toThrow('no key "é"')
    expect(() => keyOf('F5')).toThrow('no key "F5"')
    expect(() => chordOf('Hyper+S')).toThrow('no modifier Hyper')
  })

  it('reads Mod as Cmd on macOS and Ctrl elsewhere, Mod++ as Mod with plus and a capital as shifted', () => {
    expect(chordOf('Mod+S', true)).toMatchObject({ key: { key: 's' }, meta: true, control: false })
    expect(chordOf('Mod+S', false)).toMatchObject({ key: { key: 's' }, meta: false, control: true })
    expect(chordOf('Shift+Tab', true)).toMatchObject({ key: { key: 'Tab' }, shift: true })
    expect(chordOf('Mod++', true)).toMatchObject({ key: { key: '+', code: 'Equal' }, meta: true, shift: true })
    expect(chordOf('+')).toMatchObject({ key: { key: '+' }, meta: false, shift: true })
    expect(chordOf('X')).toMatchObject({ key: { key: 'X' }, shift: true })
  })
})
