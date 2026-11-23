import { describe, expect, it } from 'vitest'
import { controlKey, sameControl, type Control } from '../frontend/trusted/focus.ts'
import { installSay, type InstallBox } from '../frontend/trusted/install.ts'

// A control as the page draws it, in the section of the class named
function control(over: { tag?: string, key?: string, aria?: string, label?: string, text?: string, section?: string }): Control {
  return {
    tagName: over.tag ?? 'BUTTON',
    dataset: over.key === undefined ? {} : { key: over.key },
    getAttribute: name => (name === 'aria-label' ? over.aria ?? null : null),
    textContent: over.text ?? '',
    closest: () => (over.section === undefined ? null : { className: over.section }),
    labels: over.label === undefined ? null : [{ textContent: over.label }],
  }
}

describe('keeping focus across a redraw', () => {
  it('knows a control by the key it was drawn with, else by its section, tag and name', () => {
    expect(controlKey(control({ key: 'tick:search', text: 'anything' }))).toBe('tick:search')
    expect(controlKey(control({ section: 'plugins', text: ' Switch off ' }))).toBe('plugins|BUTTON|Switch off')
    expect(controlKey(control({ tag: 'INPUT', aria: 'New value for readyMs', section: 'limits' }))).toBe('limits|INPUT|New value for readyMs')
    expect(controlKey(control({ tag: 'INPUT', label: 'or from a GitHub link ' }))).toBe('|INPUT|or from a GitHub link')
  })

  it('finds the same control among its namesakes by its place', () => {
    const drawn = [control({ section: 'plugins', text: 'Stop' }), control({ section: 'plugins', text: 'Remove' }), control({ section: 'plugins', text: 'Stop' })]
    expect(sameControl(drawn, 'plugins|BUTTON|Stop', 1)).toBe(drawn[2])
    expect(sameControl(drawn, 'plugins|BUTTON|Stop', 2)).toBeNull()
    expect(sameControl(drawn, 'plugins|BUTTON|Quit', 0)).toBeNull()
  })
})

describe('what the page says aloud of the install box', () => {
  it('says what was found and where, a release\'s zips to pick from and nothing with no box', () => {
    const found: InstallBox = {
      step: 'found', staged: 's1', source: 'From the zip "a.zip"', unsigned: '', ready: true, busy: false,
      plugins: [{ id: 'a', label: '', line: '', high: false, lines: [], grants: [], problem: null, picked: true }, { id: 'b', label: '', line: '', high: false, lines: [], grants: [], problem: 'x', picked: false }],
    }
    expect(installSay(found)).toBe('2 plugins found. From the zip "a.zip". Tick the ones to install, then Install')
    expect(installSay({ ...found, plugins: found.plugins.slice(0, 1) })).toBe('1 plugin found. From the zip "a.zip". Tick the ones to install, then Install')
    expect(installSay({ step: 'assets', heading: 'Pick a zip from the release "v1" of "x"', assets: [] })).toBe('Pick a zip from the release "v1" of "x"')
    expect(installSay(null)).toBeNull()
  })
})
