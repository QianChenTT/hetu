// What kind of build this is, set by the build and never read from Electron, the environment or the command line.
// app.isPackaged answers from the executable's name, so a copy of an installed hetu named electron.exe would read as
// a run from the source. These are fixed in main.js inside app.asar instead
declare const __HETU_PACKAGED__: boolean | undefined
declare const __HETU_LOCKED__: boolean | undefined

// The install list sits inside app.asar and the install plugins beside it
export const PACKAGED: boolean = typeof __HETU_PACKAGED__ === 'boolean' ? __HETU_PACKAGED__ : false

// No debugging, no environment switches, no DevTools and no argument at all. The shipped build has both. A build the
// end-to-end tests drive from inside app.asar is packaged and not locked, and never made into an installer
export const LOCKED: boolean = typeof __HETU_LOCKED__ === 'boolean' ? __HETU_LOCKED__ : false
