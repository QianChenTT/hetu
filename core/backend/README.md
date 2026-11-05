Runs in the Electron main process with Node, the only part of hetu that holds real power

`disk.ts` holds the file helpers the folders share: a short retry when Windows refuses a rename, delete or read because another program has the file open, and syncing a folder after a rename on macOS and Linux
