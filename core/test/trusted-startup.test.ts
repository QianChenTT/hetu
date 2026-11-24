import { describe, expect, it } from 'vitest'
import type { ListedPlugin, SecurityList } from '../api/actions.ts'
import { layoutApproved, welcomeDue } from '../api/trusted.ts'
import { SUGGESTED_LINK } from '../frontend/trusted/startup.ts'
import { screen, TrustedPage, type Screen } from '../frontend/trusted/view.ts'

const calm = (over: Partial<SecurityList> = {}): SecurityList => ({
  plugins: [],
  switches: { devMode: [], execAnyCommand: [], skipVerification: false, allowUnsigned: [], confirmOff: false },
  limits: { all: {}, plugins: {} },
  luoshu: null,
  requests: [],
  identities: [],
  stopped: null,
  ...over,
})

const plugin = (over: Partial<ListedPlugin>): ListedPlugin => ({
  id: 'search', from: 'folder', place: 'sandboxed', state: 'ready', reason: null, security: false, on: true, items: [], class: 1,
  ...over,
})
const layout = (over: Partial<ListedPlugin> = {}) => plugin({ id: 'layout', items: [{ capability: { type: 'ui.layout' }, off: false, firstUse: false }], ...over })
const found = (id: string) => plugin({ id, state: 'found', reason: 'new', on: false, class: null })

describe('the startup screen', () => {
  it('opens on four steps at first start, none done, with the release link as a suggestion', () => {
    const startup = screen(calm()).startup
    expect(startup?.steps.map(step => [step.title, step.done])).toEqual([
      ['Pick the notes folder', null], ['Install the plugins you want', null], ['Approve them', null], ['What a grant is', null],
    ])
    expect(startup?.steps.map(step => step.offers)).toEqual(['folder', 'install', 'approve', null])
    // hetu's own reach, not a plugin's, which its grants say
    expect(startup?.steps[0].lines).toEqual(['hetu works on the notes in one folder you pick, and hetu itself reaches nothing outside it'])
    expect(startup?.suggested).toBe('https://github.com/QianChenTT/hetu-plugins')
    expect(SUGGESTED_LINK).toBe(startup?.suggested)
  })

  it('says what each step has done so far', () => {
    const startup = screen(calm({ luoshu: '/Users/someone/notes', plugins: [found('tags'), plugin({ id: 'search' }), plugin({ id: 'gate', from: 'core', place: 'core', class: null })] })).startup
    expect(startup?.steps.map(step => step.done)).toEqual(['Notes folder: /Users/someone/notes', '2 plugins in the plugin folder', '1 approved', null])
    const refused = screen(calm({ plugins: [plugin({ id: 'a', state: 'refused', reason: 'api' }), plugin({ id: 'b', state: 'failed', reason: 'start-failed' }), plugin({ id: 'c' })] })).startup
    expect(refused?.steps[2].done).toBe('1 approved')
    const one = screen(calm({ plugins: [found('tags')] })).startup
    expect(one?.steps.map(step => step.done)).toEqual([null, '1 plugin in the plugin folder', null, null])
  })

  it('stays until an approved plugin holds ui.layout, a layout only found or one from the core not counting', () => {
    expect(layoutApproved(calm({ plugins: [layout()] }))).toBe(true)
    expect(welcomeDue(calm({ plugins: [layout()] }))).toBe(false)
    expect(welcomeDue(calm())).toBe(true)
    expect(layoutApproved(calm({ plugins: [layout({ state: 'found', reason: 'new', on: false })] }))).toBe(false)
    expect(layoutApproved(calm({ plugins: [layout({ from: 'core', place: 'core' })] }))).toBe(false)
    expect(layoutApproved(calm({ plugins: [plugin({})] }))).toBe(false)
    // Refused or failed, it draws nothing, so the screen stays
    expect(layoutApproved(calm({ plugins: [layout({ state: 'refused', reason: 'api' })] }))).toBe(false)
    expect(layoutApproved(calm({ plugins: [layout({ state: 'failed', reason: 'start-failed' })] }))).toBe(false)
    // An approved layout that broke still means the human set hetu up, so the welcome isn't due again
    expect(welcomeDue(calm({ plugins: [layout({ state: 'failed', reason: 'start-failed' })] }))).toBe(false)
    expect(welcomeDue(calm({ plugins: [layout({ state: 'found', reason: 'new', on: false })] }))).toBe(true)
    // Approved and switched off or its item off still counts as approved
    expect(layoutApproved(calm({ plugins: [layout({ on: false, state: 'off', items: [{ capability: { type: 'ui.layout' }, off: true, firstUse: false }] })] }))).toBe(true)
  })

  it('is due while no layout is approved and hetu is not stopped', () => {
    expect(welcomeDue(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: false } }))).toBe(false)
    expect(screen(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: false } })).startup).toBeNull()
  })

  it('opens at the first step not done, and stays at the step the human went to', () => {
    expect(screen(calm()).startup?.at).toBe(0)
    expect(screen(calm({ luoshu: '/Users/someone/notes' })).startup?.at).toBe(1)
    expect(screen(calm({ luoshu: '/notes', plugins: [plugin({ id: 'tags' })] })).startup?.at).toBe(3)
    expect(screen(calm({ luoshu: '/notes' }), null, null, 0).startup?.at).toBe(0)
  })

  it('opens on the Get started tab while it is due, else on Plugins', () => {
    expect(screen(calm()).tab).toBe('start')
    expect(screen(calm({ plugins: [layout()] })).tab).toBe('plugins')
    expect(screen(calm(), null, 'limits').tab).toBe('limits')
    expect(screen(calm()).tabs[0]).toMatchObject({ id: 'start', label: 'Get started' })
  })
})

describe('the startup screen on the page', () => {
  function started(list: SecurityList) {
    const sent: Record<string, unknown>[] = []
    let listener: ((message: unknown) => void) | null = null
    const drawn: Screen[] = []
    const page = new TrustedPage({ send: message => sent.push(message as Record<string, unknown>), listen: next => { listener = next } }, shown => drawn.push(shown))
    page.start()
    listener!({ v: 1, kind: 'reply', id: sent[1].id, ok: true, result: list })
    return { page, drawn, sent, hears: (message: unknown) => listener!(message) }
  }

  it('goes a step at a time with Next and Back, asking the core for nothing', () => {
    const { page, drawn, sent } = started(calm())
    const before = sent.length
    expect(drawn.at(-1)?.startup?.at).toBe(0)
    page.guideTo(1)
    expect(drawn.at(-1)?.startup?.at).toBe(1)
    page.guideTo(3)
    page.guideTo(4)
    expect(drawn.at(-1)?.startup?.at).toBe(3)
    page.guideTo(-1)
    expect(drawn.at(-1)?.startup?.at).toBe(0)
    expect(sent.length).toBe(before)
  })

  it('leaves for the Plugins tab, and the Get started tab shows it again', () => {
    const { page, drawn } = started(calm())
    expect(drawn.at(-1)?.tab).toBe('start')
    page.leaveGuide()
    expect(drawn.at(-1)?.tab).toBe('plugins')
    page.pickTab('start')
    expect(drawn.at(-1)?.tab).toBe('start')
  })

  it('stays on the guide when a layout is approved while it shows', () => {
    const { drawn, sent, hears } = started(calm())
    expect(drawn.at(-1)?.tab).toBe('start')
    hears({ v: 1, kind: 'event', topic: 'core.security', seq: 2 })
    hears({ v: 1, kind: 'reply', id: sent.at(-1)!.id, ok: true, result: calm({ plugins: [layout()] }) })
    expect(drawn.at(-1)?.tab).toBe('start')
  })

  it('shows again from its tab once a layout is approved', () => {
    const { page, drawn } = started(calm({ plugins: [layout()] }))
    expect(drawn.at(-1)?.tab).toBe('plugins')
    page.pickTab('start')
    expect(drawn.at(-1)?.startup).not.toBeNull()
  })
})
