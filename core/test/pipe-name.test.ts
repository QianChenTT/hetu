import { describe, expect, it } from 'vitest'
import { pipeName } from '../api/pipe.ts'

describe('the local pipe\'s name', () => {
  it('is a named pipe of the user\'s own on Windows', () => {
    expect(pipeName('win32', 'Han')).toBe('\\\\.\\pipe\\hetu-mcp-Han')
  })

  it('is a socket in a folder of the user\'s own under /tmp elsewhere', () => {
    expect(pipeName('darwin', 'han')).toBe('/tmp/hetu-mcp-han/mcp.sock')
    expect(pipeName('linux', 'han')).toBe('/tmp/hetu-mcp-han/mcp.sock')
  })

  it('gives two users two names', () => {
    expect(pipeName('win32', 'a')).not.toBe(pipeName('win32', 'b'))
    expect(pipeName('darwin', 'a')).not.toBe(pipeName('darwin', 'b'))
  })
})
