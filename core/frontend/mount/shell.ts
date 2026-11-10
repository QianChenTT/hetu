// The window shell's logic, kept apart from the DOM so it runs in tests. The page hands it the window's link to the core
// and a function that draws the banner's lines as text
import type { CoreStatus, PendingRequest } from '../../api/actions.ts'
import { INPUT_DELAY_MS } from '../../api/trusted.ts'
import type { CoreLink } from './link.ts'

// What the banner says: each slot not on, the plugins down, each switch that weakens a check and a luoshu not picked.
// Nothing while all is well
export function bannerLines(status: CoreStatus): string[] {
  const lines: string[] = []
  for (const [slot, state] of Object.entries(status.slots)) if (state !== 'on') lines.push(`${slot}: ${state}`)
  if (status.crashed.length > 0) lines.push(`down: ${status.crashed.join(', ')}`)
  if (status.devMode.length > 0) lines.push(`dev mode: ${status.devMode.join(', ')}`)
  if (status.allowUnsigned > 0) lines.push(`unsigned builds allowed: ${status.allowUnsigned}`)
  if (status.skipVerification) lines.push('verification skipped')
  if (status.recordNothing) lines.push('recording off')
  if (!status.logWrites) lines.push("the log can't write")
  if (!status.luoshuPicked) lines.push('pick a luoshu folder')
  return lines
}

// A request waiting for the human, as the banner area shows it: a notice the human clicks to open the trusted window
export type Notice = { id: string, text: string }

// What a notice says: the plugin whose call raised it, or the change. Never text a plugin wrote. The id goes in quotes,
// since a plugin can pick one that reads as a sentence
export function noticeText(request: PendingRequest): string {
  const id = request.plugin === null ? null : JSON.stringify(request.plugin)
  if (request.kind === 'item.on' && id !== null) return `The plugin ${id} asks to use something for the first time`
  if (request.kind === 'plugin.approve' && id !== null) return `New plugin found: ${id}`
  if (request.kind === 'plugin.update' && id !== null) return `An update for ${id} is waiting`
  return `A security change is waiting: ${request.kind}${id !== null ? ` ${id}` : ''}`
}

// Subscribes to core.status and core.quitting, reads the status and draws the banner with a notice per request waiting,
// then reads it again each time the core says so. The link acks each event, so the window's credits never run out. A
// notice opens the trusted window only once it has been on screen for the input delay, so a click a plugin timed to
// land as it appears opens nothing. The notes keep their drafts on core.quitting
export class Shell {
  private readonly link: CoreLink
  private readonly draw: (lines: string[], notices: Notice[]) => void
  private readonly clock: () => number
  // When each notice drawn first appeared
  private readonly shownAt = new Map<string, number>()

  constructor(link: CoreLink, draw: (lines: string[], notices: Notice[]) => void, clock: () => number = () => performance.now()) {
    this.link = link
    this.draw = draw
    this.clock = clock
  }

  start(): void {
    this.link.on('core.status', () => this.refresh())
    void this.link.subscribe(['core.status', 'core.quitting'])
    this.refresh()
  }

  // Opens the trusted window at a notice's request, or at the plugin list from the shell's own button
  open(requestId?: string): void {
    if (requestId === undefined) return void this.link.call('security.open')
    const shown = this.shownAt.get(requestId)
    if (shown === undefined || this.clock() - shown < INPUT_DELAY_MS) return
    void this.link.call('security.open', { requestId })
  }

  // The status as last read, for the parts of the page that follow it
  onStatus: (status: CoreStatus) => void = () => {}

  private refresh(): void {
    void this.link.call('core.status').then(reply => {
      if (!reply.ok) return
      const status = reply.result as CoreStatus
      const now = this.clock()
      const ids = new Set(status.pending.map(request => request.id))
      for (const id of this.shownAt.keys()) if (!ids.has(id)) this.shownAt.delete(id)
      for (const id of ids) if (!this.shownAt.has(id)) this.shownAt.set(id, now)
      this.draw(bannerLines(status), status.pending.map(request => ({ id: request.id, text: noticeText(request) })))
      this.onStatus(status)
    })
  }
}
