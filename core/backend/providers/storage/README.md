Storage, a core module in main that serves `storage.*` and `cache.*` for every plugin and for the editor window. Each caller has a space of its own, named by `spaceOf` in `core/api/storage.ts` from the caller the carrier names: a plugin's id or `window.` and the role. A call has no way to name another space

- `storage/<space>/key-<name>`: one JSON line naming the key and its value, then the hash of that line. A file that fails the hash, isn't one object of the key and a value or names another key answers `tampered`, and the carrier writes `storage.tampered`. The plugin may still set or delete the key
- `cache/<space>/key-<name>`: the same line with no hash. A file that doesn't read answers null, since the plugin rebuilds it. The plugins manager clears it when the plugin's version changes
- `<name>` is the key with each capital written as `_` and the letter, since Windows and macOS compare names without case. No Windows device name starts with `key-` and the names never hold the `~` of an 8.3 alias
- each space is held to the quotas in `core/api/storage.ts`, counted from disk on each set, so a space the plugins manager cleared counts as empty. A set past one answers `failed` with the reason `quota`
- calls on one space run in order, and temp files a crash left are removed the first time a space is touched in a run

`store.ts` holds the logic. `core/backend/modules.ts` makes it and opens it on the data folder at start. The plugins manager clears a space through it while it is on. Its tests are in `core/test/modules/storage`
