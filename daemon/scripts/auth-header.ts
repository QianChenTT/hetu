// Claude Code's headersHelper runs this on every connection. The token stays in ~/.hetu/token, out of every config file
import { loadToken } from '../src/token.ts'

process.stdout.write(JSON.stringify({ Authorization: `Bearer ${await loadToken(false)}` }))
