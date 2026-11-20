Boot, one of the four parts of the core: sets up trust for one run before any plugin exists. Takes the folder lock, opens the one event log, loads the state files and checks each one's hash line, tells a wipe from a first run and writes the default switches and the `boot.*` records. Never reads or hashes plugin code, the plugins manager checks that

The state files are in format 3. A file in format 2, which also held agents' items and revoked labels, is read with those dropped and written back once in format 3 (`boot.upgraded`), a write that fails leaving it to be read the same way at the next start (`boot.upgrade-failed`). A file in a later format belongs to a newer build and is never written over

`header.ts` is its door: the types of its options, its result for the run and the state it loaded, the store among them. Other parts import only these. Where the data folder is lives in `core/backend/lib`, since the runtime needs it too
