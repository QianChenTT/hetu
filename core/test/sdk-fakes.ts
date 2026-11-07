import type { Caller } from '../api/envelope.ts'
import { floorConstants } from '../api/floor.ts'
import type { Carrier } from '../backend/carrier/carrier.ts'
import { Calls } from '../sdk/calls.ts'
import { makeClient } from '../sdk/client.ts'
import { Sender, type Transport } from '../sdk/transport.ts'

// How the way behaves. drop loses a message the half posted, as the carrier does one over the rate. clone copies each
// message the way a port does, which throws on what can't cross
export type TransportOptions = { drop?: (message: Record<string, unknown>) => boolean, clone?: boolean }

// An SDK half's way on an in-process handle, as the loader gives a host half its link. What the carrier sends before
// listen waits for it. sent keeps every message the half posted, oldest first, the lost ones too
export function sdkTransport(carrier: Carrier, caller: Caller, options: TransportOptions = {}): Transport & { sent: unknown[] } {
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
      if (options.clone === true) structuredClone(message)
      sent.push(message)
      if (options.drop?.(message as Record<string, unknown>) === true) return
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
  const sender = new Sender(message => transport.post(message), floorConstants.messagesPerSecond)
  const calls = new Calls(sender, { callsInFlight: floorConstants.callsInFlight, callDeadlineMs: floorConstants.callDeadlineMs })
  transport.listen(message => calls.reply(message))
  return { client: makeClient((action, args, options) => calls.request(action, args, options)), transport, calls }
}
