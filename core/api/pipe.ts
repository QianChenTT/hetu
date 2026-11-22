// The local pipe a program on this computer reaches MCP through, one a user: mcp-http-handler serves it
// and the shim connects to it. A named pipe on Windows. Elsewhere a socket in a folder of the user's own under /tmp,
// which the handler makes for its owner alone. A dev hetu and an installed one share the name, as they share the port
export function pipeName(platform: string, user: string): string {
  return platform === 'win32' ? `\\\\.\\pipe\\hetu-mcp-${user}` : `/tmp/hetu-mcp-${user}/mcp.sock`
}
