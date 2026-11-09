The luoshu, an install plugin whose host half serves `luoshu.read`, `luoshu.write` and `luoshu.list` on the notes folder the human picked, and publishes `luoshu.changed` for each of its writes and `luoshu.outside` for a save made elsewhere

- **prepare** turns the path the caller wrote into the canonical one with `core/lib/canonical.ts`, which refuses a bad spelling `invalid` and a link or junction out, `.git` by any name and hetu's own folders `not-granted`. It holds the lock on the path's key until perform or release, so no other hetu write to that name runs in between
- **a write** checks the version it was made against under the lock: none for a new note, else the hash of the bytes read. The bytes go to a dot temp file beside the note, then a rename over it, so a crash leaves the old note or the new one
- **a listing** answers up to a page of file paths in name order under a folder, past `.git`, temp files, links and hetu's own folders, with the last name as `next` when more remain. The carrier keeps the names the caller may list or read, and no listing carries a version
- **the watcher** is `fs.watch` with `recursive`. A path quiet for 150 ms is hetu's own write when its bytes hash as the last write hetu made there, and `luoshu.outside` otherwise
- with no folder picked every call answers `unavailable`

`src/luoshu.ts` holds the logic and `src/host.ts` is what the loader imports: the plugin, the `provider` role and the `luoshu` role, whose `open` the loader calls with the folder when the plugin is ready and each time `luoshu.set` applies
