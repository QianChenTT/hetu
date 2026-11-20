// What boot provides: the options it runs on, its result for the run and the shapes of the state it loaded and keeps
// writing, the store among them. Types only, so the plugins manager and the joins reach boot's shapes and never its logic
export type { BootCheck, BootOptions, Booted } from './boot.ts'
export type { Check, FileResult, Loaded, Luoshu, Plugin, SecurityState, StateStore, Switches } from './state.ts'
