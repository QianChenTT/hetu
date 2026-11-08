The window shell: the window preload, the port handoff, the frame mount, the banner and the generic bridge. A view frame gets its port only on its first load

The bridge is how plugins reach the editor, shaped like CodeMirror. It carries only the verbs a plugin was granted and holds no power of its own. The CodeMirror adapter belongs to the editor core plugin. Editor core and hidden marks are in-page plugins in `plugins/`, compiled into the editor page from the install

Built so far:
- `preload.ts`: the window's only way to the core, `send` and `listen` on the window's IPC channel through the context bridge. Only the top frame gets it, so a frame in the window has no bridge
- `index.html`, `page.ts` and `shell.css`: the shell page, which draws the banner from `core.status` as text and reads it again each time the core says so, through `shell.ts`, which holds the logic apart from the DOM so it runs in tests. Each request waiting is a notice naming the plugin it waits for, which opens the trusted window only once it has been on screen for the input delay. A button opens the plugin list
