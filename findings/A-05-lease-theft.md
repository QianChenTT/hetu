
# A-05: lease theft through a refused acquire_lease

Found by review while writing the threat model (2026-10-21), proven with a live exploit (2026-10-22)

## Summary

A lease id is the only thing the daemon checks before letting a client write a leased file. A refused `acquire_lease` returned the holder's lease id to the caller, so any agent that asked for a file already leased got back the capability to write that file. 

## Exploit 

Run against the baseline commit `431c22d` (last `main` before the fix) with the daemon on `127.0.0.1:4747` and the playground vault. Two MCP clients, both holding the one shared token, over the Python SDK. 

1. Agent A (`holder`) acquires a lease on `fixtures/pipeline.md` 
2. Agent B (`attacker`) acquires the same path. The daemon refuses with `LeaseHeld`. The refusal's `details` carried the holder's lease id: 

```
"details": [ { "path": "fixtures/pipeline.md", "holder": "holder",
               "lease": "95513af3-01fc-4261-bfa8-afb0adc54e2c", ... } ]
```

3. B reads the id straight from the error, then calls `edit_note` with it and a file it never leased 
4. The write succeeds. 

```
note.written lease=95513af3 path=fixtures/pipeline.md op=edit
```

## Root cause 

`daemon/src/core.ts`, `acquireLease`. The conflict list was built with the lease id in it and passed whole as the error's details: 

```ts
.map(h => ({ path: h.path, holder: h.lease!.label, lease: h.lease!.id, expires_at: ... }))
...
throw new VaultError('LeaseHeld', `Already leased: ...`, held)   // held carries lease ids 
```

`mcp.ts` returns `err.details` verbatim to the caller. A lease id is a bearer capability: `leaseFor` checks only that the id exists and covers the path, never who is calling. So any client holding the id can write, and the refusal gave it away. This is one shared token with no per-agent identity, so nothing else distinguished A from B 

## Fix 

Strip the id from the details before they leave the daemon, keep it in the log. Merged in PR 2 (`QianChenTT/hetu`): 

```ts
const conflicts = held.map(({ lease, ...conflict }) => conflict)
throw new VaultError('LeaseHeld', `Already leased: ...`, conflicts)
```

The caller still gets path, holder and expiry, enough to wait or narrow its request. The `lease.denied` log event above the throw still records the id for investigation 

## Regression test

`daemon/test/daemon.test.ts`: "never shows a refused caller the holder lease id, so the refusal cannot be used to take over the lease". It stringifies the whole refusal and asserts the holder's id appears nowhere, and pins the details to path, holder and expiry only. 

## Detection

Not yet built. The signal exists in the log: a `lease.denied` for a path, then a `note.written` on that same path under the denied lease's id by a different client, is a theft in progress. 

## Found by

Missed by all tools (none were running yet). Found by manual review while writing the threat model, before the build sprint's CI existed. This is a pre-guardrail baseline finding, not a sprint finding 
