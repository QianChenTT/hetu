The worker host page: a hidden renderer page that starts each sandboxed plugin's worker from the bytes the loader verified, under its CSP and with the prelude, and relays its messages to the carrier

- `index.html` and `page.ts`: the page. Starts, relays, ends and counts, through `host.ts`, which holds the logic apart from the DOM so it runs in tests
- `prelude.js`: runs first in every worker, in the same `data:` script as the plugin's bytes, copied in as written, and removes `Worker` and `SharedWorker` through top-level `this`, which the plugin's own declarations can't rebind
- `preload.ts`: the only way between the page and main. Starts and ends come in, ready, error and drop counts and cutoffs go out

A worker gets one message from the page, `{ v: 1, kind: 'port' }` carrying its end of a channel the page made. The page keeps the other end and holds main's end of the plugin's channel, so every message a worker sends passes the relay before main has to read it. Main reads a message whole before any check of its own, and a message of a million small objects stalled it 390 ms, so the relay checks first:

- anything but text within the cap (the plugin's largest result and room for the envelope), or a message carrying a port, cuts the worker off at once. The SDK never sends one
- a message over the carrier's message rate, or over the text budget (`textPerSecond`), is dropped and counted
- a flood, by the carrier's own rule, cuts the worker off

A cutoff ends the worker, then tells main why, and main has the loader record it as crashed with that reason. Main's port stays open for the carrier to close, so the reason can't be lost to a close that arrives first. A worker that closes itself closes the page's end, and the page then closes main's port. A worker's script is one `data:` URL, which Chromium caps at 2 MiB, so a plugin's code fits up to about 1.5 MB. `core/build` bundles the page and the preload into `core/dist`
