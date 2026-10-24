# hetu

> **Ongoing security assessment and review: do not download for personal use**
>
> Security findings are published in [findings/](findings/) as they are found

A local notes app for a markdown vault where AI agents are the main writers. Agents edit through an MCP server with per-note leases and a git commit per edit. The human edits in a Notion-like editor that hides markdown markers without ever rewriting text

Named after the Hetu (河图), the legendary chart a dragon-horse carried out of the Yellow River, said to be the first record with marks on it

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
