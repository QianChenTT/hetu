# hetu

> **Ongoing security assessment and review: do not download for personal use**
>
> Security findings are published in [findings/](findings/) as they are found

Notes apps are starting to have two kinds of untrusted writers. AI agents read untrusted pages, emails and files and can be prompt injected. Plugins run third-party code that can be malicious, or turn malicious through a hijacked update. In most apps both act with the user's full access once they're let in: they can rewrite notes, run code or switch protections off

hetu is a local notes app designed around that problem

- **Agents get scoped access:** a call made for an agent is judged on the plugin's grants and on the agent's own items, which cover only reading, listing, writing and locking notes and their history and last one run. An agent writes only the notes it holds a lease on. Every write becomes its own git commit with an event log entry
- **Plugins hold no power of their own:** every plugin runs isolated and asks the core for narrow capabilities, such as committing these paths, instead of raw disk, process or network access. Before a plugin's code runs, the core checks its files against the build the user approved
- **Security changes need the human:** turning a guard off, granting a plugin more power or changing which plugins load needs a Confirm click in a separate trusted window that shows the exact change. hetu keeps its security state in files only it writes and checks each against a recorded hash at start, which catches careless edits by tools that don't know hetu. Never an agent over MCP, never another plugin
- **The user can switch anything off:** every check, security included, can be switched off with a Confirm click in the trusted window. A banner shows while it is off and the event log records the switch. A check that judges yes or no follows one rule: switched off by the user its step doesn't exist and answers yes, crashed while hetu runs it refuses and failed at start it stops hetu in a fail-safe offering Quit, Try again and Start with it switched off
- **Detection where prevention stops:** an agent with a shell can write notes without going through MCP. hetu can't prevent that, so changes hetu didn't make reach plugins as outside changes. A program on your machine that targets hetu itself is out of scope, hetu assumes the machine is free of such programs

Many security decisions in hetu are still handed to the user: approving a plugin, giving it more power, switching a guard off. Most people are here for the features and can't be expected to know what each approval risks. So an approval made for convenience points to a gap in hetu's design, not a mistake by the user. Each confirmation says plainly what is being changed. The goal is fewer of these decisions left to the user and a safe choice that is also the easy one

The Electron app runs the core today: boot, plugins-manager, router and runtime with eleven core modules bundled into `main.js` (the gate, the grant risk classifier, flood control, the heartbeat, recording, the security view, storage, the luoshu, history, exec and the lock), the door MCP clients come in through, core code built into `door.js` beside `main.js`, with its HTTP door and local pipe in a utility process of its own and the `hetu.exe --mcp-stdio` shim, no plugin shipped, the layout and hidden marks installed by the human as community plugins, the editor window, the trusted window and a Windows installer. The core has no agents of its own: a call made for one carries a pair of the root plugin and a label the gate judges beside the plugin's grants. MCP for agents, leases and the commit per write come from the `mcp` plugin in [hetu-plugins](https://github.com/QianChenTT/hetu-plugins), which holds the role the door calls. OAuth isn't built, so an agent connects through the local pipe and the `hetu.exe --mcp-stdio` shim. The core map shows the whole design, built or not: [core map](https://qianchentt.github.io/hetu/). An attack phase follows. Findings are published in [findings/](findings/)

## Names

Hetu and Luoshu are the two diagrams of an old Chinese story, the Yellow River Chart and the Luo River Writing. hetu is the app. **luoshu** is the folder of notes it keeps and the core module that serves it, what other notes apps call a vault. Plugins read and write notes through `luoshu.read` and `luoshu.write` and hear about changes on `luoshu.changed`.

## Layout

- [core/](core/): the core, the four parts that can't be switched off (boot, plugins-manager, router and runtime), the core modules and the door beside them in `core/backend`, the Electron entry, the three fixed pages, the SDK and the build. Each folder's README says what it holds and where it moves
- [docs/](docs/): the interactive core map, published with GitHub Pages
- [docs/flows.md](docs/flows.md): five flows to know before reading the code
- [fixtures/](fixtures/): test notes and artifacts. `fixtures/artifact-starter/` keeps the retired editor's artifact code (the line parser, the sandboxed frame and its grants) as starter code for the artifact embed. It ran against the retired daemon's REST API and runs nowhere now
- [scripts/e2e-packaged.ts](scripts/e2e-packaged.ts): drives a packed build that isn't locked
- `playground_vault/`: a local notes folder to try hetu on, not tracked here

## Run

```
npm install
npm run build:main
npx electron .
```

A run from the source keeps its data in its own `hetu-dev` folder, or in `HETU_DATA_DIR` when that is set. `npm test` runs the core's tests, `npm run typecheck` checks every workspace and `npm run test:e2e` builds the app and drives it with Playwright

## Install

`npm run package` builds `dist-package/installer/hetu-0.5.0-x64.msi` on Windows with a `SHA256SUMS` file beside it. `npm run package:dir` builds the unpacked folder alone on any system. `npm run test:packaged` starts the packed folder as it ships, `npm run test:e2e:packaged` drives a packed build that isn't locked

- **Install:** run the MSI. It installs for every user of the machine into `C:\Program Files\hetu` after one UAC prompt, with a Start menu shortcut and nothing to pick. The installer isn't signed, so Windows names an unknown publisher and SmartScreen may warn first. Smart App Control set to On blocks an unsigned app outright: Windows Security, App & browser control, Smart App Control shows its state
- **Run:** from the Start menu, with no arguments. The installed hetu refuses every argument but `--mcp-stdio` alone (which starts the stdio shim) and exits on any other argument or debugging switch
- **Update:** run a newer MSI. An older one over a newer install is refused
- **Repair:** run the same MSI again. This is the way back when hetu stops on a changed file
- **Remove:** Settings, Apps, hetu. Your data stays in `%LOCALAPPDATA%\hetu`: the security state, the event log, folder plugins and their storage, the history repos. Delete that folder to remove it too. Your notes folder is never touched
- **Releases:** the Release workflow builds the MSI from `main` when started by hand from the Actions tab and publishes it as a pre-release named after the version in `package.json`, once that commit's CI passed and the MSI installed and passed the installed checks on the runner. Its `ref` input names a commit `main` holds, by hash or tag, to build in place of the tip: `gh workflow run release.yml --ref main -f ref=<commit>`. A commit `main` doesn't hold is refused. The checks that `main` holds it, that its CI passed and that its version isn't released yet are the workflow's on `main`, while the packaging, its integrity hook and the installed checks are the named commit's own, so an older commit runs its older checks. A version already released is never built again, so bump the version first. Check a download against its build: `gh attestation verify hetu-0.5.0-x64.msi --repo QianChenTT/hetu`, which shows the workflow and the commit of `main` it ran from. The release notes name the commit built, which differs from that one when `ref` was given
- **What protects the install:** the folder is read-only for standard users. Electron's fuses turn off every way to run code in hetu besides its own `app.asar` and check that file's integrity on Windows and macOS. The door's code sits inside `app.asar` with `main.js`, so that check covers it too. On macOS a program running as the user can change the install, which the trusted window says
