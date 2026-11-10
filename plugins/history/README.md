History, an install plugin whose host half serves `history.commit`, `history.log` and `history.read`: hetu's own record of notes, in a repo hetu owns. It needs `git` on the machine. With none its start throws, it reads as failed and calls answer `unavailable`

**Why a repo of its own.** git reads config, hooks, filters and nested repos from the folder it works in, and each can name a program to run. A notes folder can come from anywhere, so git is never pointed at it:

- the repo lives under the data folder, at `host/history/<key>/shadow.git`, one per notes folder, the key from the folder's real path. It is made with no template, so it has no hooks folder
- git runs with `--git-dir` alone and never a work tree, from an empty folder of history's own. Only plumbing: `hash-object`, `update-index`, `write-tree`, `commit-tree`, `update-ref`, `rev-list` and `cat-file`
- a note's bytes are read by history and reach git on stdin, so git is given no path in the notes folder and applies no filter, line ending or encoding change to them. What comes back from `history.read` is what the file held
- the environment is built in `core/lib/clean-env.ts` and holds nothing of hetu's own: no system or global config, a home with nothing in it, no prompt and a PATH of git's own folder
- every call carries `--literal-pathspecs`, so a note named like a pattern matches only itself, and overrides `core.fsmonitor` and `core.hooksPath`, so a config or hook edited into the repo itself doesn't run
- git comes from the PATH by its real absolute path, never from the notes folder or the data folder

**The calls**

- **prepare** turns each path into the canonical one with `core/lib/canonical.ts`, as the luoshu does, so the gate decides on the name the note really has. `.git` by any name, a link out and hetu's own folders are refused there
- **`history.commit`** records the notes at up to 64 paths as one commit. A path with no note is recorded as removed. Nothing changed answers `{ commit: null }`. The committer is the caller and the author the client the call was made for, when it names one. A file over 16 MiB refuses the whole call with `too-large`
- **`history.log`** lists the commits that changed one note, newest first, 50 unless the caller names up to 200
- **`history.read`** gives one note's text at a commit with the hash of its bytes, the shape `luoshu.read` answers. A file that isn't UTF-8 is stored exactly and refused here with `not-text`. A restore is the caller writing the text back through `luoshu.write`
- calls run one at a time, since the repo has one index
- the manifest requires the luoshu, so with the luoshu off history waits and reads no note

`src/history.ts` holds the logic and `src/host.ts` is what the loader imports: the plugin, the `provider` role and the `history` role, whose `open` the loader calls with the notes folder when the plugin is ready and each time `luoshu.set` applies. `test/a11.test.ts` shows each planted program firing under plain git in the notes folder and not through history
