// Creates playground_vault from the spike's fixture notes. Refuses to touch a vault that already exists
import { existsSync } from 'node:fs'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const vault = path.join(repoRoot, 'playground_vault')
if (existsSync(vault)) {
  console.error(`${vault} already exists, delete it first to reseed`)
  process.exit(1)
}
await mkdir(vault)
await cp(path.join(repoRoot, 'spike', 'notes'), path.join(vault, 'fixtures'), { recursive: true })
await writeFile(
  path.join(vault, 'welcome.md'),
  '# Playground vault\n\nA throwaway vault for the hetu daemon. Every change here becomes a git commit in this folder\n\n- Agents edit through the hetu MCP tools\n- Saving a file in any editor commits it as a human edit\n',
)
console.log(`seeded ${vault}. Start the daemon to create its git repo`)
