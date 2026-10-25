# hetu

> **Ongoing security assessment and review: do not download for personal use**
>
> Security findings are published in [findings/](findings/) as they are found

Notes apps are starting to have two kinds of untrusted writers. AI agents read untrusted pages, emails and files and can be prompt injected. Plugins run third-party code that can be malicious, or turn malicious through a hijacked update. In most apps both act with the user's full access once they're let in: they can rewrite notes, run code or switch protections off

hetu is a local notes app designed around that problem

- **Agents get scoped access:** an agent writes only the notes it holds a lease on, under grants set for that agent, and every write becomes its own git commit with an event log entry
- **Plugins hold no power of their own:** every plugin runs isolated and asks the core for narrow capabilities, such as committing these paths, instead of raw disk, process or network access. Plugins must be signed, and the signer is pinned when the user first approves one
- **Security changes need the human:** turning a guard off, granting a plugin more power or changing which plugins load needs a signature from a hardware key that only signs after Windows Hello or Touch ID. Never an agent over MCP, never another plugin
- **Detection where prevention stops:** an agent with a shell can write files without going through MCP, and hetu can't prevent that. So changes the daemon didn't make are flagged and committed as an unknown writer, and signatures are checked at every start. A bypass can break hetu but can't quietly turn its security off

Many security decisions in hetu are still handed to the user: approving a plugin, giving it more power, switching a guard off. Most people are here for the features and can't be expected to know what each approval risks. So an approval made for convenience points to a gap in hetu's design, not a mistake by the user. Each prompt says plainly what is being signed. The goal is fewer of these decisions left to the user and a safe choice that is also the easy one

The daemon, its MCP tools, leases, the commit per write and outside-write detection run today. The plugin core is designed and being built next, and an attack phase follows. Findings are published in [findings/](findings/)

## Layout

- [daemon/](daemon/): the vault daemon. MCP for agents and a REST and Server-Sent Events API for the editor over one core: scoped leases, version checks, a git commit per lease and per save, a watcher for outside writes and an event log in `~/.hetu/logs`
- [editor/](editor/): the text-first CodeMirror 6 editor. Reads and saves through the daemon, shows agent edits live and goes view only while an agent holds a note
- [fixtures/](fixtures/): test notes and artifacts. The playground vault is seeded from here
- [scripts/dev.ts](scripts/dev.ts): starts the daemon, waits for it, then starts the editor
- `playground_vault/`: a throwaway vault with its own git repo, not tracked here

## Run

```
npm install
npm run seed
npm run dev
```

The editor runs at http://localhost:5174 and the daemon at http://127.0.0.1:4747. `npm run seed:fresh` replaces the playground and its history. `npm test` runs the daemon tests, `npm run typecheck` checks both workspaces

Claude Code sessions opened in this folder connect to the daemon through `.mcp.json` once the folder is trusted and the server approved
