// The editor window's calls and events over the preload's bridge, shared by the shell, the notes and the drawer. The
// core answers each call once on the window's way in and numbers each event, which the link acks once, before any
// handler runs, so a handler that throws or calls again never holds the window's credits

export type Bridge = {
  send(message: unknown): void
  listen(listener: (message: unknown) => void): void
}

export type Reply = { ok: boolean, result?: unknown, refusal?: { code: string, reason?: string } }

export type CoreEvent = { topic: string, path?: string }

type Heard = { v?: unknown, kind?: unknown, id?: unknown, ok?: unknown, result?: unknown, refusal?: unknown, topic?: unknown, seq?: unknown, path?: unknown }

export class CoreLink {
  private readonly bridge: Bridge
  private id = 0
  private readonly pending = new Map<number, (reply: Reply) => void>()
  private readonly handlers = new Map<string, ((event: CoreEvent) => void)[]>()
  private started = false

  constructor(bridge: Bridge) {
    this.bridge = bridge
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.bridge.listen(message => this.heard(message))
  }

  // onBehalf names whom the window acts for, which the call's audit record keeps
  call(action: string, args?: unknown, options: { onBehalf?: string } = {}): Promise<Reply> {
    const id = ++this.id
    const answered = new Promise<Reply>(resolve => this.pending.set(id, resolve))
    const message: Record<string, unknown> = { v: 1, kind: 'call', id, action, args }
    if (options.onBehalf !== undefined) message.onBehalf = options.onBehalf
    this.bridge.send(message)
    return answered
  }

  subscribe(topics: string[]): Promise<Reply> {
    return this.call('events.subscribe', { topics })
  }

  on(topic: string, handler: (event: CoreEvent) => void): void {
    const list = this.handlers.get(topic) ?? []
    list.push(handler)
    this.handlers.set(topic, list)
  }

  private heard(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const got = message as Heard
    if (got.kind === 'reply' && typeof got.id === 'number') {
      const settle = this.pending.get(got.id)
      if (settle === undefined) return
      this.pending.delete(got.id)
      const refusal = got.refusal as Reply['refusal']
      settle(got.ok === true ? { ok: true, result: got.result } : { ok: false, refusal })
      return
    }
    if (got.kind !== 'event' || typeof got.topic !== 'string') return
    if (typeof got.seq === 'number') this.bridge.send({ v: 1, kind: 'ack', seq: got.seq })
    const event: CoreEvent = typeof got.path === 'string' ? { topic: got.topic, path: got.path } : { topic: got.topic }
    for (const handler of this.handlers.get(got.topic) ?? []) {
      try {
        handler(event)
      } catch (err) {
        console.error(`a handler for ${got.topic} failed`, err)
      }
    }
  }
}
