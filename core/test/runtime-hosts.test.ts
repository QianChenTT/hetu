import { describe, expect, it } from 'vitest'
import { isPlugin } from '../backend/runtime/hosts.ts'

const plugin = { kind: 'hetu-plugin', spec: { start() {} } }

describe('a host module\'s default export', () => {
  it('is a plugin the SDK runs only with its kind and a start', () => {
    expect(isPlugin(plugin)).toBe(true)
    for (const other of [null, undefined, 1, 'hetu-plugin', { kind: 'other', spec: { start() {} } }, { kind: 'hetu-plugin' }, { kind: 'hetu-plugin', spec: { start: 1 } }]) {
      expect(isPlugin(other)).toBe(false)
    }
  })
})
