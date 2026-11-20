# search

First-party search, a sandboxed plugin built on `@hetu/sdk`. It requires the luoshu. At each start it lists every note through every page of `luoshu.list` and reads each listed `.md` note again, 16 at a time, so a note never heard of or changed while hetu was closed is indexed too. A page that comes back throttled is asked for again a second later, for a minute in all. Any other refusal ends the listing, its pages are still read and the index keeps the rest of what it has. A path the index holds that a whole listing no longer names is read again and leaves once its read answers not-found. The index from the cache answers meanwhile. After that it reads every note it hears about through `luoshu.changed` and `luoshu.outside`. It answers `search.query` with the notes holding every word of `{ text }` that the caller may read too, through `gate.filterReadable`, so a caller with no read gets nothing. A note whose read fails for a passing reason keeps its words and is read again later. A resync reads every note it knows again, 16 at a time. The index lives in memory and goes to its cache at stop. A path with a dot segment in a saved index, which a build from before dot names were refused could have left, is dropped when it loads

Its view `search` is the human's own: an input, a status line and a button for each note holding every word typed, up to 200. It lists the index as it is with no `gate.filterReadable`, since the human may read every note. A click opens the note with `editor.open`, which checks search's read again and a refusal shows in the status line. A path's control and bidi characters are drawn as U+FFFD. Each row keeps one node id while it is drawn, so a click opens the note of the row it was made on

- `hetu-plugin.json`: the manifest the plugins manager checks and the fake core grants, api 3 for `editor.open`
- `src/index.ts`: the word index, saved as `{ v: 1, notes }`
- `src/listing.ts`: every page of a listing
- `src/view.ts`: the view's tree, its row ids and how a path is drawn
- `src/viewer.ts`: the view's instances, what was typed and the clicks
- `src/worker.ts`: the plugin
- `test/`: search on `@hetu/sdk/testing` in each of its modes, the listing, the view on the fake drawer and a vault of 469 notes it never saw

`npm test -w core-plugins/search` runs the tests
