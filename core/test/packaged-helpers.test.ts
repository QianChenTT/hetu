import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { electronCopyIn, exitText } from './packaged/helpers.ts'

// The packaged suite's helpers that need no packed build and no Electron

describe('where a copy of hetu named electron goes', () => {
  // Beside the executable: the folder root on Windows and Linux, inside the bundle on macOS, where the executable finds
  // the Electron framework
  it.each([
    ['win32', ['electron.exe']],
    ['linux', ['electron']],
    ['darwin', ['hetu.app', 'Contents', 'MacOS', 'electron']],
  ] as const)('on %s', (platform, inside) => {
    expect(electronCopyIn('app', platform)).toBe(path.join('app', ...inside))
  })
})

describe('the text of an exit', () => {
  const started = { code: null, signal: null, killed: false, stderr: '', records: [], dataDir: '', ready: false }

  it('names the signal a process ended by', () => {
    expect(exitText({ ...started, signal: 'SIGTRAP' })).toContain('signal SIGTRAP')
  })

  it('tells a process the test ended from one that ended alone', () => {
    expect(exitText({ ...started, killed: true })).toContain('ended by the test')
    expect(exitText({ ...started, code: 1 })).not.toContain('ended by the test')
  })

  it('holds the end of stderr and not its start', () => {
    const text = exitText({ ...started, stderr: `first line\n${'x'.repeat(5000)}\nlast line` })
    expect(text).toContain('last line')
    expect(text).not.toContain('first line')
  })
})
