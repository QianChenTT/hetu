// The window shell's logic, kept apart from the DOM so it runs in tests. The page hands it the preload's bridge and a
// function that draws the banner's lines as text
import type { CoreStatus } from '../../api/actions.ts'

export type Bridge = {
  send(message: unknown): void
  listen(listener: (message: unknown) => void): void
}

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
  if (!status.luoshuPicked) lines.push('pick a luoshu folder')
  return lines
}

type Reply = { v?: unknown, kind?: unknown, id?: unknown, ok?: unknown, result?: unknown, topic?: unknown, seq?: unknown }

// Subscribes to core.status, reads it and draws the banner, then reads it again each time the core says so. Each event
// is acked, so the window's credits never run out
export class Shell {
  private readonly bridge: Bridge
  private readonly draw: (lines: string[]) => void
  private id = 0
  private readonly pending = new Map<number, (reply: Reply) => void>()

  constructor(bridge: Bridge, draw: (lines: string[]) => void) {
    this.bridge = bridge
    this.draw = draw
  }

  start(): void {
    this.bridge.listen(message => this.heard(message))
    this.call('events.subscribe', { topics: ['core.status'] })
    this.refresh()
  }

  private call(action: string, args?: unknown, then?: (reply: Reply) => void): void {
    const id = ++this.id
    if (then !== undefined) this.pending.set(id, then)
    this.bridge.send({ v: 1, kind: 'call', id, action, args })
  }

  private refresh(): void {
    this.call('core.status', undefined, reply => {
      if (reply.ok === true) this.draw(bannerLines(reply.result as CoreStatus))
    })
  }

  private heard(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const got = message as Reply
    if (got.kind === 'reply' && typeof got.id === 'number') {
      const then = this.pending.get(got.id)
      this.pending.delete(got.id)
      then?.(got)
    } else if (got.kind === 'event' && got.topic === 'core.status') {
      if (typeof got.seq === 'number') this.bridge.send({ v: 1, kind: 'ack', seq: got.seq })
      this.refresh()
    }
  }
}
