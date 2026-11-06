The carrier: the one path every call takes and the enforcement point on it. It binds the caller from the way in, applies the floor, asks the gate slot and routes. It decides no grant itself. Plain Node, no Electron

- `carrier.ts`: the ways in (ports, host handles, the window seam with its sender check first), the eleven steps of section 4, pending calls per port, `parent`, deadlines, `cancel`, `filterReadable` and the core actions it serves itself
- `limits.ts`: the floor constants as they apply to one plugin with the human's values and the watchdog's lowering, plus the per-port rate and the flood cap
- `records.ts`: the floor lane straight through the one `EventLog` with its bounded backlog, the coalesced floor records and the bounded audit queue with `next` and `ack`
- `seams.ts`: what the later parts give it, each a small interface the tests fake: the loader, the gate, the guards, the providers, the watchdog, the prompt behind an ask and the parts that serve `events.*`, `ui.*` and the core actions it doesn't

It imports nothing from `boot`. The bus moves in from `backend/events/bus.ts` at step 5
