Runs in the Electron main process with Node. The core's four parts live here, boot, loader, carrier and runtime, beside the folders that become host-level plugins in `plugins/`. The core only checks, places and routes. Disk, process and network access sits with host-level plugins

The file helpers the folders share moved to `core/lib/disk.ts`
