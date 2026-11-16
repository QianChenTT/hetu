import { describe, expect, it } from 'vitest'
import {
  authorizationOf, checkDoor, doorLimits, fetchSiteOk, HOST, hostOk, originOk, PORT, refusalReasons, refuseEveryToken, routeOf,
  type Seen,
} from '../src/checks.ts'
import { agentRefusals } from 'hetu-core/api/actions.ts'

// A request as Node's parser hands it over: the method, the target as sent, the version and the raw header list,
// names as sent and each followed by its value
const seen = (headers: string[] = ['Host', '127.0.0.1:4747'], extra: Partial<Seen> = {}): Seen =>
  ({ method: 'POST', target: '/mcp', version: '1.1', headers, ...extra })

describe('the fixed values', () => {
  it('listens on the IPv4 loopback literal and port 4747 alone', () => {
    expect(HOST).toBe('127.0.0.1')
    expect(PORT).toBe(4747)
  })

  it('names every limit the door holds', () => {
    expect(doorLimits).toEqual({
      headerBytes: 8 * 1024,
      headersMs: 5000,
      requestMs: 35_000,
      keepAliveMs: 5000,
      requestsPerSocket: 100,
      connections: 64,
      mcpBodyBytes: 512 * 1024,
      tokenBodyBytes: 8 * 1024,
      perSecond: 50,
      openPerSecond: 10,
      callsPerClient: 8,
      callsInAll: 32,
      answerBytes: 4 * 1024 * 1024,
      mcpHeaders: 32,
      mcpHeaderNameBytes: 64,
      mcpHeaderValueBytes: 256,
    })
    expect(Object.isFrozen(doorLimits)).toBe(true)
  })

  it('records a refusal under the eight fixed reasons core.agentRefused takes and no others', () => {
    expect(refusalReasons).toEqual(['host', 'origin', 'method', 'size', 'rate', 'token', 'malformed', 'timeout'])
    expect(refusalReasons).toEqual(agentRefusals)
  })
})

describe('the Host check', () => {
  it('takes exactly one Host header reading 127.0.0.1 and the port, whatever the case of its name', () => {
    expect(hostOk(seen(), 4747)).toBe(true)
    expect(hostOk(seen(['HOST', '127.0.0.1:4747']), 4747)).toBe(true)
    expect(hostOk(seen(['host', '127.0.0.1:4747', 'Accept', '*/*']), 4747)).toBe(true)
    expect(hostOk(seen(['Host', '127.0.0.1:5000']), 5000)).toBe(true)
  })

  // Each spelling a page on another name, a resolver or a parser could turn into loopback, and each that isn't the
  // one authority the door serves under
  it.each([
    '', 'evil.example', 'evil.example:4747', '127.0.0.1', '127.0.0.1:', '127.0.0.1:80', '127.0.0.1:04747', '127.0.0.1:4747 ',
    ' 127.0.0.1:4747', '127.0.0.1:47470', '127.0.0.1:474', '127.0.0.1:+4747', '127.0.0.1:4747:4747', 'localhost:4747',
    'localhost', 'LOCALHOST:4747', 'localhost.:4747', 'foo.localhost:4747', '[::1]:4747', '[::ffff:127.0.0.1]:4747',
    '[::ffff:7f00:1]:4747', '::1:4747', '0.0.0.0:4747', '0:4747', '127.0.0.2:4747', '127.1:4747', '127.0.1:4747',
    '2130706433:4747', '0x7f000001:4747', '0x7f.0.0.1:4747', '0177.0.0.1:4747', '127.000.000.001:4747', '127.0.0.01:4747',
    '127.0.0.1.:4747', 'user@127.0.0.1:4747', 'user:pass@127.0.0.1:4747', '127.0.0.1:4747@evil.example',
    '127.0.0.1:4747.evil.example', '127.0.0.1.evil.example:4747', 'evil.example#127.0.0.1:4747', '127.0.0.1:4747/',
    '127.0.0.1:4747/mcp', '127.0.0.1:4747?', '127.0.0.1:4747#', '127.0.0.1%3a4747', '127.0.0.1%3A4747', '127%2e0.0.1:4747',
    '127.0.0.1:4747,127.0.0.1:4747', '127.0.0.1:4747, evil.example', 'http://127.0.0.1:4747', '//127.0.0.1:4747',
    '127.0.0.1\uFF1A4747', '\uFF11\uFF12\uFF17.0.0.1:4747', '127\u30020.0.1:4747', '127.0.0.1:4747\u0000', '127.0.0.1:4747\t',
    '127.0.0.1:\u0664\u0667\u0664\u0667', '127.0.0.1:4747\u200B', '\u200B127.0.0.1:4747', '127.0.0.1:4747.',
  ])('refuses the Host %j', host => {
    expect(hostOk(seen(['Host', host]), 4747)).toBe(false)
  })

  it('refuses no Host, two Host headers even when both read right, and a Host for another port than the one bound', () => {
    expect(hostOk(seen([]), 4747)).toBe(false)
    expect(hostOk(seen(['Accept', '127.0.0.1:4747']), 4747)).toBe(false)
    expect(hostOk(seen(['Host', '127.0.0.1:4747', 'Host', '127.0.0.1:4747']), 4747)).toBe(false)
    expect(hostOk(seen(['Host', '127.0.0.1:4747', 'HOST', 'evil.example']), 4747)).toBe(false)
    expect(hostOk(seen(['Host', 'evil.example', 'Host', '127.0.0.1:4747']), 4747)).toBe(false)
    expect(hostOk(seen(['Host', '127.0.0.1:4747']), 4748)).toBe(false)
  })

  it.each(['http://127.0.0.1:4747/mcp', 'http://evil.example/mcp', 'https://127.0.0.1:4747/mcp', '*', '127.0.0.1:4747', '', 'mcp'])(
    'refuses the request target %j, anything but a path, whatever the Host says',
    target => {
      expect(hostOk(seen(['Host', '127.0.0.1:4747'], { target }), 4747)).toBe(false)
    },
  )
})

describe('the Origin check', () => {
  it('takes a request with no Origin header', () => {
    expect(originOk(seen())).toBe(true)
  })

  it.each(['null', '', 'http://127.0.0.1:4747', 'http://127.0.0.1:5173', 'http://localhost:4747', 'https://evil.example', 'file://'])(
    'refuses any Origin, %j among them',
    origin => {
      expect(originOk(seen(['Host', '127.0.0.1:4747', 'Origin', origin]))).toBe(false)
      expect(originOk(seen(['Host', '127.0.0.1:4747', 'ORIGIN', origin]))).toBe(false)
    },
  )

  it('refuses two Origin headers', () => {
    expect(originOk(seen(['Origin', 'null', 'origin', 'null']))).toBe(false)
  })
})

describe('the Sec-Fetch-Site check', () => {
  it('takes no header, none and same-origin', () => {
    expect(fetchSiteOk(seen())).toBe(true)
    expect(fetchSiteOk(seen(['Sec-Fetch-Site', 'none']))).toBe(true)
    expect(fetchSiteOk(seen(['sec-fetch-site', 'same-origin']))).toBe(true)
  })

  it.each(['same-site', 'cross-site', 'None', 'NONE', 'Same-Origin', '', ' none', 'none, cross-site', 'cross-site, none', 'nonesense'])(
    'refuses %j',
    value => {
      expect(fetchSiteOk(seen(['Sec-Fetch-Site', value]))).toBe(false)
    },
  )

  it('refuses two headers even when both read none', () => {
    expect(fetchSiteOk(seen(['Sec-Fetch-Site', 'none', 'Sec-Fetch-Site', 'none']))).toBe(false)
  })
})

describe('the route table', () => {
  it('holds POST /mcp over HTTP/1.1 and nothing else', () => {
    expect(routeOf(seen())).toEqual({ route: 'mcp' })
  })

  it('answers 405 naming POST for GET and DELETE on /mcp', () => {
    for (const method of ['GET', 'DELETE']) {
      expect(routeOf(seen(undefined, { method }))).toEqual({ status: 405, reason: 'method', allow: 'POST' })
    }
  })

  it.each(['PUT', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'PROPFIND', 'SEARCH', 'QUERY'])('answers 404 for %s on /mcp', method => {
    expect(routeOf(seen(undefined, { method }))).toEqual({ status: 404, reason: 'method' })
  })

  it.each([
    '/', '/mcp/', '/MCP', '/Mcp', '//mcp', '/mcp?', '/mcp?x=1', '/mcp?access_token=abc', '/mcp#', '/mcp/../mcp', '/./mcp',
    '/%6dcp', '/mcp%00', '/mcp%2f', '/mcp;x', '/mcp ', '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server', '/authorize', '/token', '/revoke',
  ])('answers 404 for POST %j', target => {
    expect(routeOf(seen(undefined, { target }))).toEqual({ status: 404, reason: 'method' })
    expect(routeOf(seen(undefined, { target, method: 'GET' }))).toEqual({ status: 404, reason: 'method' })
  })

  it.each(['1.0', '2.0', '0.9', '1.2'])('answers 505 for HTTP/%s', version => {
    expect(routeOf(seen(undefined, { version }))).toEqual({ status: 505, reason: 'method' })
  })

  it('answers 400 for any request asking to upgrade, websocket and h2c alike', () => {
    expect(routeOf(seen(['Host', '127.0.0.1:4747', 'Connection', 'Upgrade', 'Upgrade', 'websocket']))).toEqual({ status: 400, reason: 'method' })
    expect(routeOf(seen(['Host', '127.0.0.1:4747', 'UPGRADE', 'h2c']))).toEqual({ status: 400, reason: 'method' })
    expect(routeOf(seen(['Host', '127.0.0.1:4747', 'Upgrade', '']))).toEqual({ status: 400, reason: 'method' })
  })
})

describe('the checks in their order', () => {
  const bad = ['Host', 'evil.example', 'Origin', 'null', 'Sec-Fetch-Site', 'cross-site']

  it('passes a well-formed POST /mcp to the route', () => {
    expect(checkDoor(seen(['Host', '127.0.0.1:4747', 'Sec-Fetch-Site', 'none', 'Content-Type', 'application/json']), 4747)).toEqual({ route: 'mcp' })
  })

  it('reads the Host first, then the Origin, then Sec-Fetch-Site, then the route', () => {
    const wrong = { method: 'PUT', target: '/nowhere' }
    expect(checkDoor(seen(bad, wrong), 4747)).toEqual({ status: 403, reason: 'host' })
    expect(checkDoor(seen(['Host', '127.0.0.1:4747', ...bad.slice(2)], wrong), 4747)).toEqual({ status: 403, reason: 'origin' })
    expect(checkDoor(seen(['Host', '127.0.0.1:4747', ...bad.slice(4)], wrong), 4747)).toEqual({ status: 403, reason: 'origin' })
    expect(checkDoor(seen(['Host', '127.0.0.1:4747'], wrong), 4747)).toEqual({ status: 404, reason: 'method' })
  })

  it('refuses an absolute target at the Host check, before the route', () => {
    expect(checkDoor(seen(undefined, { target: 'http://127.0.0.1:4747/mcp' }), 4747)).toEqual({ status: 403, reason: 'host' })
  })
})

describe('the token seam', () => {
  it('reads the Authorization header only when exactly one was sent', () => {
    expect(authorizationOf(seen())).toBe(null)
    expect(authorizationOf(seen(['Authorization', 'Bearer abc']))).toBe('Bearer abc')
    expect(authorizationOf(seen(['authorization', 'Bearer abc']))).toBe('Bearer abc')
    expect(authorizationOf(seen(['Authorization', 'Bearer abc', 'Authorization', 'Bearer abc']))).toBe(null)
  })

  it('refuses every token in the build that ships, since none is issued yet', () => {
    for (const value of [null, '', 'Bearer abc', 'Bearer ' + 'a'.repeat(64), 'Basic YTpi']) expect(refuseEveryToken(value)).toBe(null)
  })
})
