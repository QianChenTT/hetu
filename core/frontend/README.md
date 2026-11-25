Runs in Chromium with no Node access. The core keeps three fixed pages here: the worker host page that starts plugin workers from verified bytes, the drawer, the editor window's page (see `editor/README.md`) and the trusted page. Everything else in a window is a plugin

- `lib/`: what the pages share. `own-messages.ts`: `onOwnMessage`, the listener the pages and their preloads use for the messages a window posts to itself, such as main's words a preload passes on, never one a frame or another window posted
