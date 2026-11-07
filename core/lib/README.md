Shared mechanism the core and the host halves import. Holds no state or policy. The core makes one `EventLog` and one `StateStore` per run, since a second log would fork the chain

- `event-log.ts`: the hash-chained event log, one line per event
- `disk.ts`: the file helpers the folders share. A short retry when Windows refuses a rename, delete or read because another program has the file open. Syncing a folder after a rename on macOS and Linux
- `hashed-file.ts`: the strict JSON parser and the hash line that ends each state file
- `hash-files.ts`: reads each file of a plugin folder once and hashes the bytes read, by path, size and content. Links and special files are refused. The loader runs exactly the bytes hashed
- `canonical.ts`: resolves a vault path the way the OS does through links, junctions and 8.3 short names. Refuses one that leaves the vault or reaches `.git` or hetu's own folders
