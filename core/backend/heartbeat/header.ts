import type { Caller } from '../../api/envelope.ts'

// What the heartbeat provides: it sets how often a running plugin is pinged and how many misses it takes, then asks the
// core to mark a plugin unresponsive or to kill a hung utility process. Definitions only, heartbeat.ts implements them

// One running incarnation as the heartbeat watches it: the plugin, the half it pings and whether that half is a utility
// process. The plugins manager makes one per incarnation and hands the heartbeat the same object each time
export type Beating = { readonly plugin: string, readonly caller: Caller, readonly utility: boolean }

// What the core does at the heartbeat's ask: a ping down the half's own way, the mark that answers calls to it timeout
// at once, the kill of a utility process and the limits that apply to one plugin
export type HeartbeatCore = {
  ping(plugin: Beating): void
  unresponsive(plugin: Beating): void
  kill(plugin: Beating): void
  limit(plugin: string, name: 'heartbeatMs' | 'heartbeatMisses'): number
}

// What the plugins manager tells it: a plugin ready, anything heard from it and its stop
export type Heartbeat = {
  started(plugin: Beating): void
  heard(plugin: Beating): void
  stopped(plugin: Beating): void
}

// The heartbeat as the core modules hold it: opened with the core when it starts, closed with every timer ended when the
// human switches it off or hetu stops. fault takes the step that threw
export type HeartbeatModule = Heartbeat & {
  open(core: HeartbeatCore, fault: (step: string) => void): void
  close(): void
}
