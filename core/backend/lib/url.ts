// Reading a URL before letting a request through, for the runtime's sessions and main's fetch from GitHub

// A URL as the WHATWG parser reads it, or null for text it refuses
export function parsedUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

// Whether a parsed URL names its host alone, with no user, password or port. The parser drops a scheme's default port,
// so one written out passes
export const hostOnly = (at: URL): boolean => at.username === '' && at.password === '' && at.port === ''
