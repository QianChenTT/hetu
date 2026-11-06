The carrier: the one path every call and event takes and the enforcement point on it. It binds the caller from the way in, applies the floor, asks the gate slot and routes. It decides no grant itself. Plain Node, no Electron

- `carrier.ts`: the ways in (ports, host handles, the window seam with its sender check first), the eleven steps of section 4, pending calls per port, `parent`, deadlines, `cancel`, `filterReadable`, the core actions it serves itself, the floor for `events.*` and `changed()`, which the loader calls after it changes a slot state, a plugin state or the StateView
- `bus.ts`: subscriptions, credits and delivery. An event is a topic and maybe a path, never content. A path reaches a subscriber only when the gate's `canRead` says so on that delivery
- `limits.ts`: the floor constants as they apply to one plugin with the human's values and the watchdog's lowering, plus the per-port rate and the flood cap
- `records.ts`: the floor lane straight through the one `EventLog` with its bounded backlog, the coalesced floor records and the bounded audit queue with `next` and `ack`
- `seams.ts`: what the later parts give it, each a small interface the tests fake: the loader, the gate, the guards, the providers, the watchdog, the prompt behind an ask and the parts that serve `ui.*` and the core actions it doesn't

The bus, in the carrier since step 5:
- `events.subscribe`, `events.unsubscribe` and `events.publish` are calls and take the eleven steps. The `event` and `ack` messages and the signals are shaped in `core/api/envelope.ts`
- a plugin publishes only the `<id>.<name>` topics its manifest declared, from any of its halves. It hears its own for free. `core.status` and `core.security` come only from the carrier and go only to windows, with no path. The trusted window hears nothing else. These floor rules hold with the gate off
- one subscription per half and topic, so a repeat replaces it, at most `topicsPerHalf` per half. A subscribe to another plugin's topics is judged at both stages under `events.subscribe` scoped by topics. One made while the gate starts, failed, is absent or tampered stands until the gate allows it
- a path goes out only under the gate's `canRead`, every path with the gate off by the human, none while the gate is down. Path-less events go out whatever the gate
- when the gate's state or the StateView moves the bus asks the gate again about every subscription it holds. A refused one ends with `events.ended`. A path subscriber that the gate went down under, or a standing one that starts, gets one `events.dropped` once the gate is up, so it reads again
- at most `eventCredits` events in flight per half until its `ack`. Past them events are dropped and counted, nothing more goes out until the half has acknowledged all it was sent and then one `events.dropped` names what it missed. Signals take no credit
- a way that ends takes its subscriptions and credits with it, so a new incarnation starts with none
- records: each subscribe, unsubscribe and publish is a call with its audit record, publishes and free calls coalesced per caller per second. Drops are counted in coalesced `events.dropped` floor records and refused subscriptions in one `events.ended` record per subscriber per change. Deliveries and acks record nothing and recording off stops all of it

It imports nothing from `boot`
