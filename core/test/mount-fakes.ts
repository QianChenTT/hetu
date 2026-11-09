// The window's bridge with a core behind it that answers each call from a table, for the drawer's tests
export type Answer = { ok: true, result?: unknown } | { ok: false, refusal: { code: string, reason?: string } }
export type Sent = { v: number, kind: string, id?: number, action?: string, args?: unknown, onBehalf?: string, seq?: number }

export function fakeCore(answers: Record<string, (args: unknown, sent: Sent) => Answer | Promise<Answer>> = {}) {
  const sent: Sent[] = []
  let listener: ((message: unknown) => void) | null = null
  const hears = (message: unknown) => listener?.(message)
  const bridge = {
    send(message: unknown) {
      const call = message as Sent
      sent.push(call)
      if (call.kind !== 'call') return
      const answer = answers[call.action ?? '']
      if (answer === undefined) return
      void Promise.resolve(answer(call.args, call)).then(reply => hears({ v: 1, kind: 'reply', id: call.id, ...reply }))
    },
    listen(next: (message: unknown) => void) {
      listener = next
    },
  }
  let seq = 0
  return {
    bridge,
    sent,
    answers,
    hears,
    calls: (action: string) => sent.filter(message => message.kind === 'call' && message.action === action),
    // An event from the core, numbered as the carrier numbers them
    event: (topic: string, path?: string) => hears({ v: 1, kind: 'event', topic, seq: ++seq, ...(path === undefined ? {} : { path }) }),
  }
}

// Lets every promise already settled run its callbacks
export const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
