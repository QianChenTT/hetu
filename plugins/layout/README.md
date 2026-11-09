# layout

hetu's own layout, a first-party sandboxed plugin built on `@hetu/sdk` and shipped in the install. It holds `ui.layout` and `storage` and nothing else, so it reads no note and learns no note's path: titles are drawn by the drawer and the layout only places them. The human can pick another layout in the views menu, a normal setting with no Confirm, and the drawer draws its plain layout while none draws

Three columns, left, main and right, over a status row:
- a side shows one view at a time, the others as tabs. Main shows the current note, or a view the human picked, with every open note and main view as tabs
- items sit in the status row in rank order, the ones that don't fit behind a `+n` button
- sizes are CSS. When the columns' minimums pass the window's width, the lowest-ranked side folds to a rail of titles, greedily, and unfolds only 48 px past the width it needs. A declared minimum counts at most 40% of the window
- rank: favorites in their order, then views the human placed, then the most recently shown, then the plugin's priority hint, then name
- a new view goes to the side holding fewer and never moves a view the human placed
- the drawer runs drags and resizes and sends only the result. The arrangement is kept in storage by view as `owner/view`, since instance ids change with each editor page

- `hetu-plugin.json`: the manifest
- `src/fit.ts`: folding sides and items
- `src/arrange.ts`: ranking, placing and the skeleton
- `src/worker.ts`: the plugin, on `ctx.ui` and `ctx.storage`
- `test/`: fit and arrange on their own, the plugin on `@hetu/sdk/testing`'s fake drawer

`npm test -w plugins/layout` runs the tests
