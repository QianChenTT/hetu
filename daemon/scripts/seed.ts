// Creates playground_vault from the repo's fixtures. --fresh replaces an existing playground, its history included
import { existsSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const vault = path.join(repoRoot, 'playground_vault')
const fresh = process.argv.includes('--fresh')
const port = Number(process.env.HETU_PORT ?? 4747)

const daemonRunning = await new Promise<boolean>(resolve => {
  const socket = connect(port, '127.0.0.1')
  socket.once('connect', () => (socket.destroy(), resolve(true)))
  socket.once('error', () => resolve(false))
})

if (existsSync(vault)) {
  if (!fresh) {
    console.error(`${vault} already exists. Run with --fresh to replace it`)
    process.exit(1)
  }
  // A running daemon holds the vault's git repo and watcher, replacing the folder under it would break both
  if (daemonRunning) {
    console.error(`A daemon is listening on port ${port}. Stop it before replacing the playground`)
    process.exit(1)
  }
  await rm(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
await mkdir(vault)
await cp(path.join(repoRoot, 'fixtures'), path.join(vault, 'fixtures'), { recursive: true })
await writeFile(
  path.join(vault, 'welcome.md'),
  '# Playground vault\n\nA throwaway vault for the hetu daemon. Every change here becomes a git commit in this folder\n\n- Agents edit through the hetu MCP tools\n- Saving a file in any editor commits it as a human edit\n',
)
console.log(`seeded ${vault}. Start the daemon to create its git repo`)
