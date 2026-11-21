# hidden-marks

Hidden marks: markdown's markers hidden and its text styled while you type, `**bold**` drawn bold with the asterisks hidden. The text itself never changes and Ctrl+/ always shows the real text

A first-party plugin built on `@hetu/sdk` that runs in a worker behind the editor bridge, holding `ui.read` and `ui.edit` on every note, `ui.decoration`, `ui.command`, `ui.view` and `storage`. It keeps a copy of each note the human opened, read with `editor.read` and kept in step with each change list `editor.changed` brings, read again when a version is missed. It parses the copy with Lezer's markdown parser and sends the marks for the range the editor draws and a margin around it, at most the bridge's 5000 a note, dropping the elements farthest from that range whole. Each element's hidden markers, line styles and bullet share one group, whose name holds while the human types inside the element or above it and after a read again goes to the element that reads the same and each marker says whether it opens or closes the element. A note closed before its marks land is forgotten. A failed read keeps the range the editor draws and the next event reads again. The drawer decides how hidden text behaves

The format keys are its own bindings until a shortcuts plugin holds the table: Mod-b bold, Mod-i italic, Mod-Shift-s strikethrough, Mod-e inline code and Mod-Shift-h highlight. A key on a selection within one line wraps it in the format's markers, joining the runs it crosses into one, or takes off the run or the part of a run it holds. A key at the cursor takes off the run the cursor is in, its ends included, or wraps the word it is inside. A change that leaves a run with nothing between its markers takes the markers away. Each goes as an edit made for the version the key or the change came at, which the drawer refuses as stale once the human typed there

Its settings are an item in the status row, not a view taking a place in the layout, whose button opens a popover with a box for each element that hides: bold, italic, strikethrough, inline code, highlight, headings, bullets, quotes, horizontal rules, links' targets and code fences, each ticked at first. An unticked element keeps its style and shows its markdown. The choice is kept in the plugin's storage and every open note is marked again

The build carries it as a first-party copy, as it does search. The editor page keeps only the markdown language. A switches file from when hidden marks ran in the page and naming it in `off` is read with the id dropped

- `hetu-plugin.json`: the manifest the plugins manager checks and the fake core grants
- `src/marks.ts`: the parser's marks, grouped by element, the elements the human chose to show and the cap
- `src/format.ts`: the format keys and an emptied run's markers as changes to the markdown
- `src/worker.ts`: the plugin
- `test/marks.test.ts`: the marks for each element
- `test/format.test.ts`: each format key on a selection and at the cursor
- `test/worker.test.ts`: the plugin on `@hetu/sdk/testing` and its fake drawer

`npm test -w core-plugins/hidden-marks` runs the tests
