# hetu

A local notes app for a markdown vault where AI agents are the main writers. Agents edit through an MCP server with per-note leases and a git commit per edit. The human edits in a Notion-like editor that hides markdown markers without ever rewriting text

Named after the Hetu (河图), the legendary chart a dragon-horse carried out of the Yellow River, said to be the first record with marks on it

- [spike/](spike/): throwaway prototype comparing MDXEditor and a text-first CodeMirror 6 editor. Reads and saves `playground_vault` through the daemon (start the daemon first), shows agent edits live and goes view only while an agent holds a note. Run with `npm install` then `npm run dev` (port 5174). `spike/notes` stays as the fixture set the playground is seeded from
- [daemon/](daemon/): vault daemon proof of concept (MCP over local HTTP, scoped leases, a git commit per lease and per save). In `daemon/`: `npm install`, `npm run seed` once, then `npm start`. Tests with `npm test`. Claude Code sessions opened in this repo connect through `.mcp.json` after the folder is trusted and the server approved
