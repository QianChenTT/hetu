# hetu

> **Ongoing security assessment and review: do not download for personal use**
>
> Security findings are published in [findings/](findings/) as they are found

Notes apps are starting to have two kinds of untrusted writers. AI agents read untrusted pages, emails and files and can be prompt injected. Plugins run third-party code that can be malicious, or turn malicious through a hijacked update. In most apps both act with the user's full access once they're let in: they can rewrite notes, run code or switch protections off

hetu is a local notes app designed around that problem

- **Agents get scoped access:** an agent writes only the notes it holds a lease on, under grants set for that agent. Every write becomes its own git commit with an event log entry
- **Plugins hold no power of their own:** every plugin runs isolated and asks the core for narrow capabilities, such as committing these paths, instead of raw disk, process or network access. Before a plugin's code runs, the core checks its files against the build the user approved. Its signer is pinned at that first approval
- **Security changes need the human:** turning a guard off, granting a plugin more power or changing which plugins load needs a Confirm click in a separate trusted window that shows the exact change. hetu keeps its security state in files only it writes and checks each against a recorded hash at start, which catches careless edits by tools that don't know hetu. Never an agent over MCP, never another plugin
- **The user can switch anything off:** every check, security included, can be switched off with a Confirm click in the trusted window. A banner shows while it is off and the event log records the switch. A check that crashes or fails without the user switching it off blocks instead of passing
- **Detection where prevention stops:** an agent with a shell can write notes without going through MCP. hetu can't prevent that, so changes hetu didn't make are flagged and committed as an unknown writer. A program on your machine that targets hetu itself is out of scope, hetu assumes the machine is free of such programs

Many security decisions in hetu are still handed to the user: approving a plugin, giving it more power, switching a guard off. Most people are here for the features and can't be expected to know what each approval risks. So an approval made for convenience points to a gap in hetu's design, not a mistake by the user. Each confirmation says plainly what is being changed. The goal is fewer of these decisions left to the user and a safe choice that is also the easy one

The daemon, its MCP tools, leases, the commit per write and outside-write detection run today. The plugin core is designed and being built, see the [core map](https://qianchentt.github.io/hetu/). An attack phase follows. Findings are published in [findings/](findings/)

## Names

Hetu and Luoshu are the two diagrams of an old Chinese story, the Yellow River Chart and the Luo River Writing. hetu is the app. **luoshu** is the folder of notes it keeps and the plugin that serves it, what other notes apps call a vault. Plugins read and write notes through `luoshu.read` and `luoshu.write` and hear about changes on `luoshu.changed`. The old daemon still says vault until the core replaces it

## Layout

- [core/](core/): the core, the four parts that can't be switched off (boot, loader, carrier and runtime), being built here. Each folder's README says what it holds and where it moves
- [plugins/](plugins/): everything that decides or adds a feature, the gate among them
- [daemon/](daemon/): today's vault daemon, removed file by file as the core replaces it. MCP for agents and a REST and Server-Sent Events API for the editor over one core: scoped leases, version checks, a git commit per lease and per save, a watcher for outside writes and an event log in `~/.hetu/logs`
- [editor/](editor/): today's text-first CodeMirror 6 editor, removed the same way. Reads and saves through the daemon, shows agent edits live and goes view only while an agent holds a note
- [docs/](docs/): the interactive core map, published with GitHub Pages
- [fixtures/](fixtures/): test notes and artifacts. The playground vault is seeded from here
- [scripts/dev.ts](scripts/dev.ts): starts the daemon, waits for it, then starts the editor
- `playground_vault/`: a throwaway vault with its own git repo, not tracked here

## Run

```
npm install
npm run seed
npm run dev
```

The editor runs at http://localhost:5174 and the daemon at http://127.0.0.1:4747. `npm run seed:fresh` replaces the playground and its history. `npm test` runs every workspace's tests and `npm run typecheck` checks them

The new core starts as an Electron app:

```
npm run build:main
npx electron .
```

A run from the source keeps its data in its own `hetu-dev` folder, or in `HETU_DATA_DIR` when that is set. `npm run test:e2e` builds the app and drives it with Playwright

## Install

`npm run package` builds `dist-package/installer/hetu-0.4.0.msi` on Windows with a `SHA256SUMS` file beside it. `npm run package:dir` builds the unpacked folder alone on any system. `npm run test:packaged` starts the packed folder as it ships, `npm run test:e2e:packaged` drives a packed build that isn't locked

- **Install:** run the MSI. It installs for every user of the machine into `C:\Program Files\hetu` after one UAC prompt, with a Start menu shortcut and nothing to pick. The installer isn't signed, so Windows names an unknown publisher and SmartScreen may warn first. Smart App Control set to On blocks an unsigned app outright: Windows Security, App & browser control, Smart App Control shows its state
- **Run:** from the Start menu, with no arguments. The installed hetu refuses every argument and every debugging switch and exits
- **Update:** run a newer MSI. An older one over a newer install is refused
- **Repair:** run the same MSI again. This is the way back when hetu stops on a changed file
- **Remove:** Settings, Apps, hetu. Your data stays in `%LOCALAPPDATA%\hetu`: the security state, the event log, folder plugins and their storage, the history repos. Delete that folder to remove it too. Your notes folder is never touched
- **What protects the install:** the folder is read-only for standard users. Electron's fuses turn off every way to run code in hetu besides its own `app.asar` and check that file's integrity on Windows and macOS. Each install plugin is checked against the list inside `app.asar` on every start

Claude Code sessions opened in this folder connect to the daemon through `.mcp.json` once the folder is trusted and the server approved
