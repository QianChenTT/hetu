# hidden-marks

Hidden marks: markdown's markers hidden and its text styled while you type, `**bold**` drawn bold with the asterisks hidden. The text itself never changes and Ctrl+/ always shows the real text

A first-party plugin built on `@hetu/sdk` that runs in a worker behind the editor bridge, holding `ui.read` on every note and `ui.decoration`. It keeps a copy of each note the human opened, read with `editor.read` and kept in step with each change list `editor.changed` brings, read again when a version is missed. It parses the copy with Lezer's markdown parser and sends the marks for the range the editor draws and a margin around it, at most the bridge's 5000 a note, dropping the elements farthest from that range whole. Each element's hidden markers share one group, whose name holds while the human types inside the element or above it and after a read again goes to the element that reads the same and each says whether it opens or closes the element. A note closed before its marks land is forgotten. A failed read keeps the range the editor draws and the next event reads again. The drawer decides how hidden text behaves

The build carries it as a first-party copy, as it does search. The editor page keeps only the markdown language. A switches file from when hidden marks ran in the page and naming it in `off` is read with the id dropped

- `hetu-plugin.json`: the manifest the plugins manager checks and the fake core grants
- `src/marks.ts`: the parser's marks, grouped by element and the cap
- `src/worker.ts`: the plugin
- `test/marks.test.ts`: the marks for each element
- `test/worker.test.ts`: the plugin on `@hetu/sdk/testing` and its fake drawer

`npm test -w core-plugins/hidden-marks` runs the tests
