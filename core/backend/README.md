Runs in the Electron main process with Node. The core's four parts live here: boot, plugins-manager, carrier and runtime. The core only checks, places and routes. Policy, disk and process access sit with the six core modules bundled into `main.js`: the gate and the grant risk classifier in `policy/`, storage, the luoshu, history and exec in `providers/`. The core plugins in `core-plugins/` hold the rest, which the plugins manager starts from verified bytes

`modules.ts` holds the six: `CoreModules` makes them, starts them once as the plugins manager starts, hands them each change and answers the carrier's gate and providers and the plugins manager's grant risk classifier and storage's clear while each is on. A module switched off is closed where it has a close and one switched on again is started and handed what it needs. A start or a push that throws marks the module failed until one goes through, so its calls are refused and nothing stops

`wire.ts` joins the core in its order: a link that forwards to the carrier, the core modules publishing through it, the plugins manager holding both, the carrier asking the modules for the gate and the providers with boot's event log as its core record log, then the link pointed at the carrier. The Electron entry calls it once boot is done. `carrierOptions` builds what the carrier asks for, so the plugins manager's tests run the same wiring

`main.ts` is the Electron entry that joins the parts, see `runtime/README.md`

The file helpers the folders share are in `core/lib/disk.ts`
