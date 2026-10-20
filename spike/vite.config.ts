import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The daemon owns the vault. The spike reaches it through this dev server, which adds the bearer token on the way.
// The token stays on the server side, so the page never holds it, and the page and the API share one origin (no CORS)
const DAEMON = process.env.HETU_DAEMON ?? 'http://127.0.0.1:4747'
const TOKEN_FILE = process.env.HETU_TOKEN_FILE ?? path.join(os.homedir(), '.hetu', 'token')

function token(): string {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {
    throw new Error(`No daemon token at ${TOKEN_FILE}. Start the daemon once (npm start in daemon/) to create it`)
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: DAEMON, changeOrigin: true, headers: { Authorization: `Bearer ${token()}` } },
    },
  },
})
