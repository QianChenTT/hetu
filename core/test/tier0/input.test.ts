import { describe, expect, it } from 'vitest'
import { chordOf, keyOf } from './input.ts'

describe('the keys main\'s input route types', () => {
  it('names a letter, a capital, a digit and a named key the way a US layout sends them', () => {
    expect(keyOf('s')).toEqual({ key: 's', code: 'KeyS', accelerator: 'S', vk: 83, text: 's', shift: false })
    expect(keyOf('X')).toMatchObject({ key: 'X', code: 'KeyX', shift: true })
    expect(keyOf('7')).toMatchObject({ code: 'Digit7', text: '7' })
    expect(keyOf('ArrowDown')).toEqual({ key: 'ArrowDown', code: 'ArrowDown', accelerator: 'Down', vk: 40, shift: false })
    expect(keyOf('\n')).toMatchObject({ key: 'Enter', text: '\r' })
  })

  it('refuses a key or a modifier it doesn\'t model rather than guess', () => {
    expect(() => keyOf('é')).toThrow('no key "é"')
    expect(() => keyOf('F5')).toThrow('no key "F5"')
    expect(() => chordOf('Hyper+S')).toThrow('no modifier Hyper')
  })

  it('reads Mod as Cmd on macOS and Ctrl elsewhere', () => {
    expect(chordOf('Mod+S', true)).toMatchObject({ key: { key: 's' }, meta: true, control: false })
    expect(chordOf('Mod+S', false)).toMatchObject({ key: { key: 's' }, meta: false, control: true })
    expect(chordOf('Shift+Tab', true)).toMatchObject({ key: { key: 'Tab' }, shift: true })
  })
})
