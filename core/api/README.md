The contract every part of hetu shares: data, schemas and pure functions with no Node, no DOM and no I/O. `tsconfig.json` loads no types and only the es2024 library, so a Node import or a DOM global fails the typecheck. A test checks the imports too

- `envelope.ts`: the messages on a port, requests and replies, the refusal and reason codes and the callers
- `version.ts`: the envelope's version, apart from zod so the SDK loads it without the schemas
- `changes.ts`: the change kinds a security request carries
- `capabilities.ts`: the fixed capability list with the install-only types marked
- `scope.ts`: the scope grammar, the path matcher and the check for characters that could hide on a screen
- `manifest.ts`: `hetu-plugin.json` from the install and from the plugin folder
- `ids.ts`: plugin ids and names, reserved ids and the slot, provider and guard ids
- `windows.ts`: what each window holds
- `floor.ts`: the floor constants and the longest delay a timer takes, past which no time constant may be raised
- `actions.ts`: the core actions with who may call each and the provider actions with the capability each is checked against, each with its argument schema. `ActionArgs` and `ActionResults` type what the SDK's calls take and answer
- `slots.ts`: what the carrier asks and hands on: the gate, guard, provider and watchdog interfaces, `Call`, `Access`, `Decision`, `GuardCall`, the slot and plugin states and the audit record
- `plain.ts`: the plain data check for values the core passes on unread
- `frozen.ts`: the frozen tables with no prototype that the core looks keys up in, apart from zod so the floor constants load without it
- `install.ts`: the install list the build writes, each install plugin with its path, version and hash and the bundled first-party copies marked, the version order and the signer first-party copies carry
- `lifecycle.ts`: the lifecycle messages on a port, `init`, `deps`, `ready`, `stop` and `stopped`, with the fixed reasons a plugin hears as `lastStop`
