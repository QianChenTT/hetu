Runs in the Electron main process with Node. The core's four parts live here: boot, loader, carrier and runtime. The core only checks, places and routes. Policy and disk, process and network access sit with host-level plugins in `plugins/`, which the loader starts from verified bytes

`wire.ts` joins the core in its order: a link that forwards to the carrier, the loader holding it, the carrier asking the loader for every slot, guard and provider with boot's event log as its floor log, then the link pointed at the carrier. The Electron entry calls it once boot is done. `carrierOptions` builds what the carrier asks the loader for, so the loader's tests run the same wiring

The file helpers the folders share are in `core/lib/disk.ts`
