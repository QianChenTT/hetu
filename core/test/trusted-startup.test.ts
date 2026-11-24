import { describe, expect, it } from 'vitest'
import type { ListedPlugin, SecurityList } from '../api/actions.ts'
import { startupDue } from '../api/trusted.ts'
import { APPROVE_LINE, SUGGESTED_LINK } from '../frontend/trusted/startup.ts'
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
const found = (id: string) => plugin({ id, state: 'found', reason: 'new', on: false, class: null })

describe('the startup screen', () => {
  it('opens on four steps at first start, none done, with the release link as a suggestion', () => {
    const startup = screen(calm()).startup
    expect(startup?.steps.map(step => [step.title, step.done])).toEqual([
      ['Pick the notes folder', null], ['Install your first plugin', null], ['Approve it', null], ['What a grant is', null],
    ])
    expect(startup?.steps.map(step => step.offers)).toEqual(['folder', 'install', null, null])
    // hetu's own reach, not a plugin's, which its grants say
    expect(startup?.steps[0].lines).toEqual(['hetu works on the notes in one folder you pick, and hetu itself reaches nothing outside it'])
    expect(startup?.suggested).toBe('https://github.com/QianChenTT/hetu-plugins')
    expect(SUGGESTED_LINK).toBe(startup?.suggested)
  })

  // Approving is no step of the flow: one line after the install says where the plugin installed is approved
  it('says in one line after the install where the human approves the plugin installed, offering no Approve', () => {
    const startup = screen(calm({ plugins: [found('tags')] })).startup
    expect(startup?.steps[2]).toEqual({ title: 'Approve it', lines: [APPROVE_LINE], done: null, offers: null })
    expect(APPROVE_LINE).toBe('Approve what you installed in its Confirm at the top of this window, or with Approve in the Plugins tab for a plugin copied in by hand')
    expect(startup?.steps[1].lines.join(' ')).not.toMatch(/layout/i)
  })

  it('says what each step has done so far', () => {
    const startup = screen(calm({ luoshu: '/Users/someone/notes', plugins: [found('tags'), plugin({ id: 'search' }), plugin({ id: 'gate', from: 'core', place: 'core', class: null })] })).startup
    expect(startup?.steps.map(step => step.done)).toEqual(['Notes folder: /Users/someone/notes', '2 plugins in the plugin folder', null, null])
    const one = screen(calm({ plugins: [found('tags')] })).startup
    expect(one?.steps.map(step => step.done)).toEqual([null, '1 plugin in the plugin folder', null, null])
  })

  // Every install goes through the flow and nothing cancels it. It ends once the plugin folder holds a plugin, the
  // human having learned to install one, approved or not. A core part is no plugin installed
  it('is due while the plugin folder holds no plugin and ends once it holds one, approved, waiting, refused or failed', () => {
    expect(startupDue(calm())).toBe(true)
    expect(startupDue(calm({ luoshu: '/notes', plugins: [plugin({ id: 'gate', from: 'core', place: 'core', class: null })] }))).toBe(true)
    expect(startupDue(calm({ plugins: [plugin({ id: 'search' })] }))).toBe(false)
    expect(startupDue(calm({ plugins: [found('tags')] }))).toBe(false)
    expect(startupDue(calm({ plugins: [plugin({ id: 'layout', state: 'refused', reason: 'invalid' })] }))).toBe(false)
    expect(startupDue(calm({ plugins: [plugin({ id: 'tags', state: 'failed', reason: 'start-failed' })] }))).toBe(false)
    expect(screen(calm()).startup?.due).toBe(true)
    expect(screen(calm({ plugins: [found('tags')] })).startup?.due).toBe(false)
  })

  it('is not due and draws nothing while hetu is stopped', () => {
    expect(startupDue(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: false } }))).toBe(false)
    expect(screen(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: false } })).startup).toBeNull()
  })

  it('opens at the first step not done, and stays at the step the human went to', () => {
    expect(screen(calm()).startup?.at).toBe(0)
    expect(screen(calm({ luoshu: '/Users/someone/notes' })).startup?.at).toBe(1)
    expect(screen(calm({ luoshu: '/notes', plugins: [plugin({ id: 'tags' })] })).startup?.at).toBe(2)
    expect(screen(calm({ luoshu: '/notes' }), null, null, 0).startup?.at).toBe(0)
  })

  it('opens on the Get started tab while it is due, else on Plugins, a tab the human picks drawn instead', () => {
    expect(screen(calm()).tab).toBe('start')
    expect(screen(calm({ luoshu: '/notes', plugins: [plugin({ id: 'search' })] })).tab).toBe('plugins')
    expect(screen(calm(), null, 'limits').tab).toBe('limits')
    expect(screen(calm()).tabs[0]).toMatchObject({ id: 'start', label: 'Get started' })
  })

  // After it ends the guide is still there on its tab, every step drawn as before
  it('draws the guide on its tab once it ended', () => {
    const ended = screen(calm({ luoshu: '/notes', plugins: [plugin({ id: 'search' })] }), null, 'start')
    expect(ended.tab).toBe('start')
    expect(ended.startup?.due).toBe(false)
    expect(ended.startup?.steps.map(step => step.title)).toEqual(['Pick the notes folder', 'Install your first plugin', 'Approve it', 'What a grant is'])
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

  it('stays on the step it was drawn at when a step is done, as after an install, until the human moves', () => {
    const { page, drawn, sent, hears } = started(calm({ luoshu: '/notes' }))
    expect(drawn.at(-1)?.startup?.at).toBe(1)
    hears({ v: 1, kind: 'event', topic: 'core.security', seq: 2 })
    hears({ v: 1, kind: 'reply', id: sent.at(-1)!.id, ok: true, result: calm({ luoshu: '/notes', plugins: [plugin({ id: 'tags' })] }) })
    expect(drawn.at(-1)?.startup?.at).toBe(1)
    page.guideTo(2)
    expect(drawn.at(-1)?.startup?.at).toBe(2)
  })

  // An install refused or failed puts nothing in the plugin folder, so the flow stays due and Next still goes on to the
  // last step
  it('stays due after an install refused or failed and reaches its last step with Next', () => {
    const { page, drawn, sent, hears } = started(calm())
    page.installer.pick('zip')
    hears({ v: 1, kind: 'reply', id: sent.at(-1)!.id, ok: false, refusal: { code: 'invalid' } })
    hears({ v: 1, kind: 'reply', id: sent.at(-1)!.id, ok: true, result: calm() })
    expect(drawn.at(-1)?.startup?.due).toBe(true)
    for (let at = 1; at <= 3; at++) {
      page.guideTo(at)
      expect(drawn.at(-1)?.startup?.at).toBe(at)
      expect(drawn.at(-1)?.tab).toBe('start')
    }
    expect(drawn.at(-1)?.startup?.steps.length).toBe(4)
  })

  it('has no way out of the guide while it is due', () => {
    const { page, drawn, sent } = started(calm())
    const before = sent.length
    page.leaveGuide()
    expect(drawn.at(-1)?.tab).toBe('start')
    expect(sent.length).toBe(before)
  })

  it('leaves for the Plugins tab once it ended, and the Get started tab shows it again', () => {
    const { page, drawn, sent, hears } = started(calm())
    hears({ v: 1, kind: 'event', topic: 'core.security', seq: 2 })
    hears({ v: 1, kind: 'reply', id: sent.at(-1)!.id, ok: true, result: calm({ plugins: [plugin({ id: 'tags' })] }) })
    expect(drawn.at(-1)?.tab).toBe('start')
    expect(drawn.at(-1)?.startup?.due).toBe(false)
    page.leaveGuide()
    expect(drawn.at(-1)?.tab).toBe('plugins')
    page.pickTab('start')
    expect(drawn.at(-1)?.tab).toBe('start')
    expect(drawn.at(-1)?.startup).not.toBeNull()
  })

  it('stays on the guide when a plugin is installed and approved while it shows', () => {
    const { drawn, sent, hears } = started(calm())
    expect(drawn.at(-1)?.tab).toBe('start')
    hears({ v: 1, kind: 'event', topic: 'core.security', seq: 2 })
    hears({ v: 1, kind: 'reply', id: sent.at(-1)!.id, ok: true, result: calm({ plugins: [plugin({ id: 'tags' })] }) })
    expect(drawn.at(-1)?.tab).toBe('start')
  })

  it('opens on Plugins once it ended and shows the guide again from its tab', () => {
    const { page, drawn } = started(calm({ plugins: [plugin({ id: 'tags' })] }))
    expect(drawn.at(-1)?.tab).toBe('plugins')
    page.pickTab('start')
    expect(drawn.at(-1)?.startup?.steps.length).toBe(4)
  })
})
