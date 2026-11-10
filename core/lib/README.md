Shared mechanism the core and the host halves import. Holds no state or policy. The core makes one `EventLog` and one `StateStore` per run, since a second log would fork the chain

- `event-log.ts`: the hash-chained event log, one line per event
- `disk.ts`: the file helpers the folders share. A short retry when Windows refuses a rename, delete or read because another program has the file open. Syncing a folder after a rename on macOS and Linux
- `hashed-file.ts`: the strict JSON parser and the hash line that ends each state file
- `hash-files.ts`: reads each file of a plugin folder once and hashes the bytes read, by path, size and content. Links and special files are refused. The loader runs exactly the bytes hashed
- `clean-env.ts`: what history and exec share to run a program: an environment built from empty with only the variables named and never one that loads code, a program found by its real absolute path outside the folders a command may run nothing from, and one spawn with no shell, a hidden window, capped output and a deadline. On Windows the base holds the eleven variables a process start carries anyway, with a `PATH` of System32 alone
- `canonical.ts`: resolves a luoshu path the way the OS does through links, junctions and 8.3 short names. Refuses one that leaves the luoshu or reaches `.git` or hetu's own folders
