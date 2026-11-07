The contract every part of hetu shares: data, schemas and pure functions with no Node, no DOM and no I/O. `tsconfig.json` loads no types and only the es2024 library, so a Node import or a DOM global fails the typecheck. A test checks the imports too

- `envelope.ts`: the messages on a port, requests and replies, the refusal and reason codes and the callers
- `changes.ts`: the change kinds a security request carries
- `capabilities.ts`: the fixed capability list with the install-only types marked
- `scope.ts`: the scope grammar, the path matcher and the check for characters that could hide on a screen
- `manifest.ts`: `hetu-plugin.json` from the install and from the plugin folder
- `ids.ts`: plugin ids and names, reserved ids and the slot, provider and guard ids
- `windows.ts`: what each window holds
- `floor.ts`: the floor constants
- `plain.ts`: the plain data check for values the core passes on unread and the frozen tables with no prototype that the core looks keys up in
