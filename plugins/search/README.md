# search

First-party search, a sandboxed plugin built on `@hetu/sdk`. It requires the luoshu and reads every note it hears about through `luoshu.changed` and `luoshu.outside`. It answers `search.query` with the notes holding every word of `{ text }` that the caller may read too, through `core.filterReadable`. A note whose read fails for a passing reason keeps its words and is read again later. A resync reads every note it knows again, 16 at a time. The index lives in memory and goes to its cache at stop

- `hetu-plugin.json`: the manifest the loader checks and the fake core grants
- `src/index.ts`: the word index, saved as `{ v: 1, notes }`
- `src/worker.ts`: the plugin
- `test/search.test.ts`: search on `@hetu/sdk/testing` in each of its modes

`npm test -w plugins/search` runs the tests
