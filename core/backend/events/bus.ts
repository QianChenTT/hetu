// What a subscriber hears is where something happened and never what the event held, so content can't travel on the bus
export type BusEvent = { topic: string, path?: string }
export type Scope = { topics: readonly string[], canRead: (path: string) => boolean }
export type Listener = (event: BusEvent) => void

type Subscriber = { topics: Set<string>, canRead: Scope['canRead'], listener: Listener }

// Read scope is injected because the path matcher is not part of the bus
function mayRead(subscriber: Subscriber, path: string): boolean {
  try {
    // Only a real true counts, an async matcher answers with a promise that is truthy whatever the promise later says
    return subscriber.canRead(path) === true
  } catch {
    return false
  }
}

export class EventBus {
  private readonly subscribers = new Set<Subscriber>()

  subscribe(scope: Scope, listener: Listener): () => void {
    // Copied, so changing the array later can't widen what this subscriber hears
    const subscriber: Subscriber = { topics: new Set(scope.topics), canRead: scope.canRead, listener }
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  // A failing subscriber never breaks the write that triggered the event or the other subscribers. Delivery is at once,
  // so an event a listener publishes reaches later subscribers before the one being delivered. No order is promised
  // across nested publishes
  publish(event: BusEvent): void {
    // Each field is read once, so the path canRead approved is the path the subscriber gets
    const { topic, path } = event
    if (typeof topic !== 'string' || topic === '') throw new Error('topic is not a string')
    if (path !== undefined && typeof path !== 'string') throw new Error('path is not a string')
    for (const subscriber of [...this.subscribers]) {
      // Removed by a listener earlier in the round
      if (!this.subscribers.has(subscriber)) continue
      if (!subscriber.topics.has(topic)) continue
      if (path !== undefined && !mayRead(subscriber, path)) continue
      try {
        // An async listener fails later and an unhandled rejection would take the process down
        Promise.resolve(subscriber.listener(path === undefined ? { topic } : { topic, path })).catch(() => {})
      } catch {}
    }
  }
}
