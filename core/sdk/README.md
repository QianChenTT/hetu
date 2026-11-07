`@hetu/sdk`, what a plugin imports. A plugin writes `definePlugin({ start, stop })` and gets one call per action, a typed `Refused` and its own actions and events, with the transport and the messages hidden. It holds no security: every check stays in the carrier and a plugin that posts raw messages gets the same refusals. What a plugin bundles from it reaches neither zod nor Node, which a test checks by bundling `index.ts`

- `plugin.ts`: `definePlugin` and `run`, which the runtime calls on a half's transport. `init`, `ready`, `deps`, the heartbeat and `stop` within its grace
- `calls.ts`: the half's own calls. Past `callsInFlight` a call waits its turn, `starting` and `throttled` are tried again within the deadline, a call with no reply settles `timeout` a second past its deadline and an aborted signal sends `cancel`
- `client.ts`: the typed client, one method per provider action in `core/api` (`ctx.vault.read`, `ctx.storage.set` and the rest) and `call` for another plugin's `<target>.<name>`
- `serving.ts`: the plugin's own actions, `provide`, `filterReadable` and the incoming call with its signal and a client whose calls name it as their parent
- `events.ts`: subscriptions, one per topic whatever the number of handlers, acks after each 64 handled and once idle, `onResync` for `events.dropped` and one subscribe again for `events.ended`
- `transport.ts`: the transport a half runs on, in the loader's `HostLink` shape. The pacing keeps every message under 90% of `messagesPerSecond`
- `refused.ts`: `Refused` and `attempt`, which `ctx.try` is
- `testing/`: `@hetu/sdk/testing`, a fake core for a plugin's tests: the real carrier with a gate per mode (the manifest's grants, allow all, deny all, gate failed, a requirement missing), the vault, storage and cache in memory and test callers with the grants a test names
- `build/esbuild.ts`: `@hetu/sdk/esbuild`, one classic script per worker and view, refusing a Node built-in anywhere in the import graph and a bundle holding `eval`, `Function` or a timer given a string. `checkHostImports` holds a host half to its manifest's `node` list
- `build/check-manifest.ts`: `@hetu/sdk/check-manifest`, the problems the loader would refuse a manifest for, also a command: `node core/sdk/build/check-manifest.ts <dir> [--install] [--built]`

An ESLint config for plugin sources waits for typescript-eslint to support TypeScript 7.1's API. Until then the build runs these checks
