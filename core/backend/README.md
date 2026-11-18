Runs in the Electron main process with Node. The core's four parts live here: boot, plugins-manager, carrier and runtime. The core only checks, places and routes. Policy and disk, process and network access sit with core plugins in `core-plugins/`, which the plugins manager starts from verified bytes

`wire.ts` joins the core in its order: a link that forwards to the carrier, the plugins manager holding it, the carrier asking the plugins manager for every policy job, guard and provider with boot's event log as its core record log, then the link pointed at the carrier. The Electron entry calls it once boot is done. `carrierOptions` builds what the carrier asks the plugins manager for, so the plugins manager's tests run the same wiring

`main.ts` is the Electron entry that joins the parts, see `runtime/README.md`

The file helpers the folders share are in `core/lib/disk.ts`
