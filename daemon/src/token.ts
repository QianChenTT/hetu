import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// Kept outside the repo and the vault so it never lands in a commit
export const TOKEN_FILE = process.env.HETU_TOKEN_FILE ?? path.join(homedir(), '.hetu', 'token')

export async function loadToken(create: boolean): Promise<string> {
  if (!existsSync(TOKEN_FILE)) {
    if (!create) throw new Error(`No token at ${TOKEN_FILE}. Start the daemon once to create it`)
    await mkdir(path.dirname(TOKEN_FILE), { recursive: true })
    await writeFile(TOKEN_FILE, randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  }
  return (await readFile(TOKEN_FILE, 'utf8')).trim()
}
