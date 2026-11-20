import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import { createHeartbeat } from '../backend/heartbeat/heartbeat.ts'
import type { Beating, HeartbeatCore } from '../backend/heartbeat/header.ts'

// The heartbeat on its own, on fake timers: what it asks the core to do, and when
function made(limits: { heartbeatMs?: number, heartbeatMisses?: number } = {}) {
  const asked: string[] = []
  const faults: string[] = []
  const core: HeartbeatCore = {
    ping: plugin => void asked.push(`ping ${plugin.plugin}`),
    unresponsive: plugin => void asked.push(`unresponsive ${plugin.plugin}`),
    kill: plugin => void asked.push(`kill ${plugin.plugin}`),
    limit: (_plugin, name) => (name === 'heartbeatMs' ? limits.heartbeatMs ?? 100 : limits.heartbeatMisses ?? 2),
  }
  const heartbeat = createHeartbeat()
  heartbeat.open(core, step => void faults.push(step))
  return { heartbeat, core, asked, faults }
}

const beating = (plugin: string, utility = false): Beating =>
  Object.freeze({ plugin, caller: { kind: 'plugin', id: plugin, half: utility ? 'host' : 'worker', incarnation: 1 } as Caller, utility })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the heartbeat', () => {
  it('pings a started plugin every heartbeatMs and asks the core to mark it unresponsive once heartbeatMisses went unanswered', () => {
    const { heartbeat, asked } = made()
    const mapper = beating('mapper')
    heartbeat.started(mapper)
    vi.advanceTimersByTime(100)
    expect(asked).toEqual(['ping mapper'])
    vi.advanceTimersByTime(200)
    expect(asked).toEqual(['ping mapper', 'ping mapper', 'unresponsive mapper', 'ping mapper'])
  })

  it('asks the core to kill a utility half that missed its beats, never to mark it', () => {
    const { heartbeat, asked } = made()
    heartbeat.started(beating('http', true))
    vi.advanceTimersByTime(300)
    expect(asked).toEqual(['ping http', 'ping http', 'kill http', 'ping http'])
  })

  it('counts the misses again from nothing once the plugin was heard', () => {
    const { heartbeat, asked } = made()
    const mapper = beating('mapper')
    heartbeat.started(mapper)
    vi.advanceTimersByTime(200)
    heartbeat.heard(mapper)
    vi.advanceTimersByTime(200)
    expect(asked).not.toContain('unresponsive mapper')
  })

  it('pings nothing more for a plugin that stopped, nor after it is closed', () => {
    const { heartbeat, asked } = made()
    const mapper = beating('mapper')
    heartbeat.started(mapper)
    heartbeat.started(beating('tagger'))
    heartbeat.stopped(mapper)
    vi.advanceTimersByTime(100)
    expect(asked).toEqual(['ping tagger'])
    heartbeat.close()
    vi.advanceTimersByTime(500)
    expect(asked).toEqual(['ping tagger'])
  })

  it('starts nothing before it is opened', () => {
    const heartbeat = createHeartbeat()
    heartbeat.started(beating('mapper'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('skips the check that threw with a fault recorded, the next ping counting', () => {
    const { heartbeat, core, asked, faults } = made()
    const ping = core.ping
    let broken = true
    core.ping = plugin => {
      if (broken) throw new Error('broken')
      ping(plugin)
    }
    heartbeat.started(beating('mapper'))
    vi.advanceTimersByTime(100)
    expect(faults).toEqual(['check'])
    broken = false
    vi.advanceTimersByTime(100)
    expect(asked).toEqual(['ping mapper'])
  })

  it('starts a plugin once, so a second start keeps its count', () => {
    const { heartbeat, asked } = made()
    const mapper = beating('mapper')
    heartbeat.started(mapper)
    vi.advanceTimersByTime(200)
    heartbeat.started(mapper)
    vi.advanceTimersByTime(100)
    expect(asked).toContain('unresponsive mapper')
  })
})
