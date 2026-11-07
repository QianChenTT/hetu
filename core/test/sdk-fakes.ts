import type { Caller } from '../api/envelope.ts'
import type { Carrier } from '../backend/carrier/carrier.ts'
import { Calls } from '../sdk/calls.ts'
import { makeClient } from '../sdk/client.ts'
import type { Transport } from '../sdk/transport.ts'

// An SDK half's way on an in-process handle, as the loader gives a host half its link. What the carrier sends before
// listen waits for it. sent keeps every message the half posted, oldest first
export function sdkTransport(carrier: Carrier, caller: Caller): Transport & { sent: unknown[] } {
  const held: unknown[] = []
  const sent: unknown[] = []
  let listener: ((message: unknown) => void) | null = null
  const handle = carrier.handle(caller, message => {
    if (listener === null) held.push(message)
    else listener(message)
  })
  return {
    sent,
    post(message) {
      sent.push(message)
      handle.post(message)
    },
    listen(next) {
      listener = next
      for (const message of held.splice(0)) next(message)
    },
  }
}

// A client with no plugin around it, for the calls alone
export function clientOn(carrier: Carrier, caller: Caller) {
  const transport = sdkTransport(carrier, caller)
  const calls = new Calls(message => transport.post(message))
  transport.listen(message => calls.reply(message))
  return { client: makeClient((action, args, options) => calls.request(action, args, options)), transport, calls }
}
