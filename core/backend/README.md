Runs in the Electron main process with Node, the only part of hetu that holds real power

The file helpers the folders share moved to `core/lib/disk.ts`

`wire.ts` joins the core in its order: a link that forwards to the carrier, the loader holding it, the carrier asking the loader for every slot, guard and provider with boot's event log as its floor log, then the link pointed at the carrier. The Electron entry calls it once boot is done
