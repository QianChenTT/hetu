import type { BusSignal } from '../api/envelope.ts'
import { VERSION } from '../api/version.ts'
import type { Request } from './client.ts'
import { Refused } from './refused.ts'

// A signal and maybe a path, never content. The path is one the gate says the plugin may read
export type BusEvent = { readonly topic: string, readonly path?: string }
export type EventHandler = (event: BusEvent) => void | Promise<void>

// onResync hears the topics the plugin may have missed events on, so it reads again. onEnded hears the topics whose
// subscription the gate ended and the refusal the SDK got subscribing again, needs-confirm when it asked the human
export type EventOptions = {
  onResync?(topics: string[]): void
  onEnded?(refused: Refused, topics: string[]): void
}

// standing names the topics the bus keeps waiting for the gate. They start on their own once it allows them
export type Subscription = { readonly topics: readonly string[], readonly standing: readonly string[], off(): Promise<void> }

const dropped: BusSignal = 'events.dropped'
const ended: BusSignal = 'events.ended'
// Handled events between acks while a burst lasts, a quarter of the floor's eventCredits
const ACK_EVERY = 64

type Entry = { readonly handler: EventHandler, readonly options: EventOptions, readonly topics: ReadonlySet<string> }

// The bus holds one subscription per half and topic, so the handlers of a topic share one. core.* goes in a call of
// its own, since a mixed call with the gate off and the log down is refused whole
function groups(topics: readonly string[]): string[][] {
  const core = topics.filter(topic => topic.startsWith('core.'))
  const rest = topics.filter(topic => !topic.startsWith('core.'))
  return [core, rest].filter(group => group.length > 0)
}

// One queue per half: events and signals in the order they came, each handler awaited before the next. Acks go out
// after each 64 handled and once the queue is idle, so credits count what the plugin has really handled
export class Events {
  private readonly id: string
  private readonly send: (message: unknown) => void
  private readonly request: Request
  private readonly entries = new Set<Entry>()
  // Each subscribed topic and whether the bus keeps it standing
  private readonly subscribed = new Map<string, { standing: boolean }>()
  private readonly queue: Record<string, unknown>[] = []
  private running = false
  private handled = 0
  private lastSeq = 0
  private ackedSeq = 0
  private ackTimer: ReturnType<typeof setTimeout> | null = null

  constructor(id: string, send: (message: unknown) => void, request: Request) {
    this.id = id
    this.send = send
    this.request = request
  }

  async on(topics: string | readonly string[], handler: EventHandler, options: EventOptions = {}): Promise<Subscription> {
    const list = [...new Set(typeof topics === 'string' ? [topics] : topics)]
    if (list.length === 0 || list.some(topic => typeof topic !== 'string' || topic === '')) throw new TypeError('on needs topics')
    if (typeof handler !== 'function') throw new TypeError('on needs a handler')
    // In place before the subscribe answers, so no event that follows the answer misses it
    const entry: Entry = { handler, options, topics: new Set(list) }
    this.entries.add(entry)
    const outcomes = await Promise.allSettled(groups(list.filter(topic => !this.subscribed.has(topic))).map(async group => {
      await this.subscribe(group)
      return group
    }))
    const failed = outcomes.find(outcome => outcome.status === 'rejected')
    if (failed !== undefined) {
      // All or nothing: what this call subscribed goes again
      const made = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? outcome.value : [])
      this.entries.delete(entry)
      for (const topic of made) this.subscribed.delete(topic)
      if (made.length > 0) await this.request('events.unsubscribe', { topics: made }).catch(() => {})
      throw failed.reason
    }
    return {
      topics: list,
      standing: list.filter(topic => this.subscribed.get(topic)?.standing === true),
      off: () => this.off(entry),
    }
  }

  async publish(name: string, path?: string): Promise<void> {
    const topic = `${this.id}.${name}`
    await this.request('events.publish', path === undefined ? { topic } : { topic, path })
  }

  // An event or a signal the bus pushed
  receive(message: Record<string, unknown>): void {
    this.queue.push(message)
    if (!this.running) void this.drain()
  }

  private async subscribe(group: readonly string[]): Promise<void> {
    const result = await this.request('events.subscribe', { topics: [...group] }) as { standing?: unknown } | null
    const standing = new Set(Array.isArray(result?.standing) ? result.standing : [])
    for (const topic of group) this.subscribed.set(topic, { standing: standing.has(topic) })
  }

  private async off(entry: Entry): Promise<void> {
    if (!this.entries.delete(entry)) return
    const unused = [...entry.topics].filter(topic => this.subscribed.has(topic) && ![...this.entries].some(other => other.topics.has(topic)))
    for (const topic of unused) this.subscribed.delete(topic)
    if (unused.length > 0) await this.request('events.unsubscribe', { topics: unused })
  }

  private async drain(): Promise<void> {
    this.running = true
    if (this.ackTimer !== null) clearTimeout(this.ackTimer)
    this.ackTimer = null
    while (this.queue.length > 0) {
      await this.handle(this.queue.shift()!)
      if (this.handled >= ACK_EVERY) this.ack()
    }
    this.running = false
    // Idle: the ack waits a turn, so a burst that arrived together goes back as one
    if (this.lastSeq > this.ackedSeq) {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = null
        if (!this.running) this.ack()
      }, 0)
    }
  }

  private async handle(message: Record<string, unknown>): Promise<void> {
    const { topic, seq, path, topics } = message
    if (topic === dropped || topic === ended) {
      const named = Array.isArray(topics) ? topics.filter((item): item is string => typeof item === 'string') : []
      if (topic === dropped) this.resync(named)
      else await this.ended(named)
      return
    }
    if (typeof topic !== 'string' || typeof seq !== 'number') return
    const event: BusEvent = typeof path === 'string' ? { topic, path } : { topic }
    for (const entry of [...this.entries]) {
      if (!entry.topics.has(topic)) continue
      try {
        await entry.handler(event)
      } catch (err) {
        console.error(`hetu: a handler for ${topic} threw`, err)
      }
    }
    this.lastSeq = Math.max(this.lastSeq, seq)
    this.handled++
  }

  private ack(): void {
    this.handled = 0
    if (this.lastSeq <= this.ackedSeq) return
    this.ackedSeq = this.lastSeq
    this.send({ v: VERSION, kind: 'ack', seq: this.lastSeq })
  }

  private resync(topics: readonly string[]): void {
    for (const entry of [...this.entries]) {
      const mine = topics.filter(topic => entry.topics.has(topic))
      if (mine.length === 0 || entry.options.onResync === undefined) continue
      try {
        entry.options.onResync(mine)
      } catch (err) {
        console.error('hetu: onResync threw', err)
      }
    }
  }

  // The gate ended these subscriptions. Subscribing again once raises its ask, if it has one. Its refusal goes to
  // onEnded
  private async ended(topics: readonly string[]): Promise<void> {
    const gone = topics.filter(topic => this.subscribed.delete(topic))
    for (const group of groups(gone)) {
      try {
        await this.subscribe(group)
      } catch (err) {
        if (!(err instanceof Refused)) {
          console.error('hetu: subscribing again failed', err)
          continue
        }
        for (const entry of [...this.entries]) {
          const mine = group.filter(topic => entry.topics.has(topic))
          if (mine.length === 0 || entry.options.onEnded === undefined) continue
          try {
            entry.options.onEnded(err, mine)
          } catch (thrown) {
            console.error('hetu: onEnded threw', thrown)
          }
        }
      }
    }
  }
}
