import { CHECK_EVERY_MS } from './header.ts'

// Runs a function after ms and gives back what cancels it
export type Later = (run: () => void, ms: number) => () => void

// Node's timer, which never holds the process open
const nodeLater: Later = (run, ms) => {
  const timer = setTimeout(run, ms)
  timer.unref()
  return () => clearTimeout(timer)
}

export type CheckTimerOptions = {
  // One check, which settles once it ended and never rejects
  check: () => Promise<unknown>
  // Only a locked build checks
  locked: boolean
  // The switch as it stands at the start
  on: boolean
  later?: Later
  everyMs?: number
}

// When the checks run: once the core is ready, then every 7 days from the end of the last one, never in a build that
// isn't locked and never while the switch is off. Switched on again once ready, it checks at once
export class CheckTimer {
  private readonly options: CheckTimerOptions
  private readonly later: Later
  private on: boolean
  private isReady = false
  private closed = false
  private cancel: (() => void) | null = null
  // Bumped by every stop, so a check that ends after one schedules nothing
  private round = 0

  constructor(options: CheckTimerOptions) {
    this.options = options
    this.later = options.later ?? nodeLater
    this.on = options.on
  }

  private get due(): boolean {
    return this.options.locked && this.on && this.isReady && !this.closed
  }

  private stop(): void {
    this.round++
    this.cancel?.()
    this.cancel = null
  }

  private run(): void {
    this.cancel = null
    const round = this.round
    void this.options.check().then(() => {
      if (round === this.round && this.due) this.cancel = this.later(() => this.run(), this.options.everyMs ?? CHECK_EVERY_MS)
    })
  }

  ready(): void {
    if (this.isReady) return
    this.isReady = true
    if (this.due) this.run()
  }

  switched(on: boolean): void {
    if (on === this.on) return
    this.on = on
    this.stop()
    if (this.due) this.run()
  }

  close(): void {
    this.closed = true
    this.stop()
  }
}
