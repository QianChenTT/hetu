Runs in the Electron main process with Node. The core's four parts live here, boot, loader, carrier and runtime, beside the folders that become host-level plugins in `plugins/`. The core only checks, places and routes. Disk, process and network access sits with host-level plugins

`disk.ts` holds the file helpers the folders share: a short retry when Windows refuses a rename, delete or read because another program has the file open, and syncing a folder after a rename on macOS and Linux
