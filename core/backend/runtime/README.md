The runtime, one of the four parts of the core and the only one that touches Electron. `main.ts` beside this folder is the Electron entry and joins the parts

- `before-ready.ts`: what must run before Electron's `ready`, all of it synchronous. A packaged build started with `--remote-debugging-port` or `--remote-debugging-pipe` exits first. Then the data folder, `userData` inside it so the single-instance lock follows the folder, the lock, the sandbox for every renderer and the `hetu` scheme registered once
- `sessions.ts`: one in-memory session per role: the editor, the trusted window and the workers. Each denies every permission, device and download, refuses every request but its own `hetu` hosts and serves those hosts' pages from the app with a CSP. The default session refuses everything
- `windows.ts`: the guards on every web contents (no navigation a page starts, no new window, no webview, no Bluetooth pick), the web preferences every page gets and the editor window
- `electron.ts`: the loader's runtime on Electron. Channels are `MessageChannelMain` ports read the way the carrier reads a port. Workers start and end in the hidden renderer. Host halves can't load yet, so they refuse
- `workers.ts`: the hidden renderer that holds the workers. Starts wait for its page to say ready, a renderer that dies is recorded with the plugins it held and the next start opens a new one. Its window skips background throttling, since its workers answer heartbeats
- `quit.ts`: Quit in its order, each step with a deadline, and relaunch. `main.ts` closes the windows a human sees first and ends the hidden renderer last, so workers stop while they still run

`core/build/main.ts` bundles the entry into `core/dist/main.js` with the install list beside it, which names no plugin until the runtime can start one
