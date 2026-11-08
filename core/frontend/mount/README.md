The window shell: the window preload, the port handoff, the frame mount, the banner and the generic bridge. A view frame gets its port only on its first load

The bridge is how plugins reach the editor, shaped like CodeMirror. It carries only the verbs a plugin was granted and holds no power of its own. The CodeMirror adapter belongs to the editor core plugin. Editor core and hidden marks are in-page plugins in `plugins/`, compiled into the editor page from the install

`index.html` holds a placeholder the editor window loads until the shell is built
