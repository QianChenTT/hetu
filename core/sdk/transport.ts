// A half's end of its way to the router: the HostLink the plugins manager gives a host half. A worker's port is to sit
// behind the same two calls. Messages the router sends before listen wait for it
export type Transport = {
  post(message: unknown): void
  listen(listener: (message: unknown) => void): void
  // The transport paces what it posts itself, as a worker's does, so the half posts to it unpaced
  paces?: boolean
}

// What the pacing keeps back from the rate
const SHARE = 0.9

// The window the pacing counts a second's messages in. The router counts a way's messages in one-second windows from
// when it reads them, which is later than they left by however long main was busy. A message read late opens a window
// that a message sent a second after it can still land in, so a slot is taken again only this long after it was last
// used, room for main to read up to 100 ms late
export const PACE_WINDOW_MS = 1100

// Every message a half sends, in order, at most 90% of perSecond in any window of PACE_WINDOW_MS, the rest held until
// there is room. The router drops a message over the rate unread. Paced this way each of its windows stays under the
// rate while main reads every message within 100 ms of its send. A post that throws, as a port's does for a value it
// can't copy, goes to that message's onFail and the rest keep their order
export class Sender {
  private readonly post: (message: unknown) => void
  private readonly budget: number
  private readonly clock: () => number
  // When each of the last budget messages went out, oldest first
  private readonly times: number[] = []
  private readonly held: { message: unknown, onFail: ((error: unknown) => void) | undefined }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(post: (message: unknown) => void, perSecond: number, clock: () => number = () => performance.now()) {
    this.post = post
    this.budget = Math.max(1, Math.floor(perSecond * SHARE))
    this.clock = clock
  }

  send(message: unknown, onFail?: (error: unknown) => void): void {
    this.held.push({ message, onFail })
    if (this.timer === null) this.flush()
  }

  private flush(): void {
    this.timer = null
    while (this.held.length > 0) {
      const now = this.clock()
      while (this.times.length > 0 && now - this.times[0] >= PACE_WINDOW_MS) this.times.shift()
      if (this.times.length >= this.budget) {
        this.timer = setTimeout(() => this.flush(), Math.max(1, this.times[0] + PACE_WINDOW_MS - now))
        return
      }
      this.times.push(now)
      const { message, onFail } = this.held.shift()!
      try {
        this.post(message)
      } catch (err) {
        if (onFail === undefined) console.error('hetu: a message could not be sent', err)
        else onFail(err)
      }
    }
  }
}
