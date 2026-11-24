// When the page's Confirm buttons may be pressed: not for the input delay after the window shows or gains focus, nor
// for the delay after a new request or a new staging is drawn under one, so a click aimed at the one before can't land.
// Main drops the input in its own delay anyway, this only shows it
export class Arming {
  private readonly clock: () => number
  private readonly delay: number
  // When the Confirm buttons arm, which something new drawn under them puts off
  private armedAt: number
  // When the delay since the window showed or gained focus ends, the one main holds every input of the page to
  private focusAt: number
  private readonly drawn = new Map<string, string | null>()

  constructor(clock: () => number, delay: number) {
    this.clock = clock
    this.delay = delay
    this.armedAt = clock() + delay
    this.focusAt = this.armedAt
  }

  // The window showed or gained focus
  focused(): void {
    this.armedAt = this.clock() + this.delay
    this.focusAt = this.armedAt
  }

  // Whether the delay since the window showed or gained focus still runs, inside which main counts a request the page
  // sends for nothing
  focusDelayRuns(): boolean {
    return this.clock() < this.focusAt
  }

  // What a Confirm of one kind is drawn for now, null for none. Something new waits the delay again
  show(kind: string, key: string | null): void {
    if (key !== null && key !== (this.drawn.get(kind) ?? null)) this.armedAt = this.clock() + this.delay
    this.drawn.set(kind, key)
  }

  // How long until the buttons arm, 0 once they have
  wait(): number {
    return Math.max(0, this.armedAt - this.clock())
  }
}
