Runs in the Electron main process with Node. The core's four parts live here, boot, loader, carrier and runtime, beside the folders that become host-level plugins in `plugins/`. The core only checks, places and routes. Disk, process and network access sits with host-level plugins

`wire.ts` joins the core in its order: a link that forwards to the carrier, the loader holding it, the carrier asking the loader for every slot, guard and provider with boot's event log as its floor log, then the link pointed at the carrier. The Electron entry calls it once boot is done

The file helpers the folders share are in `core/lib/disk.ts`
