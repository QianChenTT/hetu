The worker host page: a hidden renderer page that starts each sandboxed plugin's worker from the bytes the loader verified, under its CSP and with the prelude, and hands the worker its port to the carrier

- `index.html` and `page.ts`: the page. Starts, ends and counts errors, through `host.ts`, which holds the logic apart from the DOM so it runs in tests
- `prelude.ts`: runs first in every worker, in the same `data:` script as the plugin's bytes, and removes `Worker` and `SharedWorker`
- `preload.ts`: the only way between the page and main. Starts and ends come in, ready and error counts go out

A worker gets one message from the page, `{ v: 1, kind: 'port' }` carrying its port, and the page reads nothing the worker sends it. A worker's script is one `data:` URL, which Chromium caps at 2 MiB, so a plugin's code fits up to about 1.5 MB. `core/build` bundles the page and the preload into `core/dist`
