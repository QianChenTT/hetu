import { describe, expect, it } from 'vitest'
import type { ListedPlugin, SecurityList } from '../api/actions.ts'
import { welcomeDue } from '../api/trusted.ts'
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

  // Every install goes through the flow and nothing cancels it, so with no end yet it is due at every start while
  // hetu runs, whatever was installed or approved
  it('is due at every start while hetu runs, with plugins installed, approved or a layout plugin of an older hetu', () => {
    expect(welcomeDue(calm())).toBe(true)
    expect(welcomeDue(calm({ luoshu: '/notes', plugins: [plugin({ id: 'search' }), found('tags')] }))).toBe(true)
    expect(welcomeDue(calm({ plugins: [plugin({ id: 'layout', state: 'refused', reason: 'api' })] }))).toBe(true)
  })

  it('is not due and draws nothing while hetu is stopped', () => {
    expect(welcomeDue(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: false } }))).toBe(false)
    expect(screen(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: false } })).startup).toBeNull()
  })

  it('opens at the first step not done, and stays at the step the human went to', () => {
    expect(screen(calm()).startup?.at).toBe(0)
    expect(screen(calm({ luoshu: '/Users/someone/notes' })).startup?.at).toBe(1)
    expect(screen(calm({ luoshu: '/notes', plugins: [plugin({ id: 'tags' })] })).startup?.at).toBe(2)
    expect(screen(calm({ luoshu: '/notes' }), null, null, 0).startup?.at).toBe(0)
  })

  it('opens on the Get started tab at every start, a tab the human picks drawn instead', () => {
    expect(screen(calm()).tab).toBe('start')
    expect(screen(calm({ luoshu: '/notes', plugins: [plugin({ id: 'search' })] })).tab).toBe('start')
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

  it('stays on the step it was drawn at when a step is done, as after an install, until the human moves', () => {
    const { page, drawn, sent, hears } = started(calm({ luoshu: '/notes' }))
    expect(drawn.at(-1)?.startup?.at).toBe(1)
    hears({ v: 1, kind: 'event', topic: 'core.security', seq: 2 })
    hears({ v: 1, kind: 'reply', id: sent.at(-1)!.id, ok: true, result: calm({ luoshu: '/notes', plugins: [plugin({ id: 'tags' })] }) })
    expect(drawn.at(-1)?.startup?.at).toBe(1)
    page.guideTo(2)
    expect(drawn.at(-1)?.startup?.at).toBe(2)
  })

  // An install refused, failed or never made leaves the steps not done, and Next still goes on to the last step
  it('reaches its last step with Next whatever the install did', () => {
    const lists = [
      calm(), calm({ plugins: [plugin({ id: 'tags', state: 'refused', reason: 'api' })] }),
      calm({ plugins: [plugin({ id: 'tags', state: 'failed', reason: 'start-failed' })] }),
    ]
    for (const list of lists) {
      const { page, drawn } = started(list)
      for (let at = 1; at <= 3; at++) {
        page.guideTo(at)
        expect(drawn.at(-1)?.startup?.at).toBe(at)
      }
      expect(drawn.at(-1)?.startup?.steps.length).toBe(4)
    }
  })

  it('leaves for the Plugins tab, and the Get started tab shows it again', () => {
    const { page, drawn } = started(calm())
    expect(drawn.at(-1)?.tab).toBe('start')
    page.leaveGuide()
    expect(drawn.at(-1)?.tab).toBe('plugins')
    page.pickTab('start')
    expect(drawn.at(-1)?.tab).toBe('start')
  })

  it('stays on the guide when a plugin is installed and approved while it shows', () => {
    const { drawn, sent, hears } = started(calm())
    expect(drawn.at(-1)?.tab).toBe('start')
    hears({ v: 1, kind: 'event', topic: 'core.security', seq: 2 })
    hears({ v: 1, kind: 'reply', id: sent.at(-1)!.id, ok: true, result: calm({ plugins: [plugin({ id: 'tags' })] }) })
    expect(drawn.at(-1)?.tab).toBe('start')
  })
})
