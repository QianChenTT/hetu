// A half's end of its way to the carrier: the HostLink the loader gives a host half. From step 11 a worker's port sits
// behind the same two calls. Messages the carrier sends before listen wait for it
export type Transport = {
  post(message: unknown): void
  listen(listener: (message: unknown) => void): void
}

// What the pacing keeps back from the rate
const SHARE = 0.9

// Every message a half sends, in order, at most 90% of perSecond in any second, the rest held until there is room. The
// carrier counts a way's messages in one-second windows from when they arrive and drops one over the rate unread, so
// staying under the rate in every sliding second keeps each of those windows under it
export class Sender {
  private readonly post: (message: unknown) => void
  private readonly budget: number
  private readonly clock: () => number
  // When each of the last budget messages went out, oldest first
  private readonly times: number[] = []
  private readonly held: unknown[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(post: (message: unknown) => void, perSecond: number, clock: () => number = () => performance.now()) {
    this.post = post
    this.budget = Math.max(1, Math.floor(perSecond * SHARE))
    this.clock = clock
  }

  send(message: unknown): void {
    this.held.push(message)
    if (this.timer === null) this.flush()
  }

  private flush(): void {
    this.timer = null
    while (this.held.length > 0) {
      const now = this.clock()
      while (this.times.length > 0 && now - this.times[0] >= 1000) this.times.shift()
      if (this.times.length >= this.budget) {
        this.timer = setTimeout(() => this.flush(), Math.max(1, this.times[0] + 1000 - now))
        return
      }
      this.times.push(now)
      this.post(this.held.shift())
    }
  }
}
