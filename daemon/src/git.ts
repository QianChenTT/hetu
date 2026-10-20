import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const exec = promisify(execFile)

export type Commit = { commit: string; author: string; date: string; message: string }

// All git calls go through one queue, since git holds a single index lock per repo
export class Git {
  readonly root: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(root: string) {
    this.root = root
  }

  private async run(args: string[]): Promise<string> {
    // execFile passes args straight to git with no shell, so paths can't inject commands
    const { stdout } = await exec('git', args, { cwd: this.root, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  // Creates the repo on first start. Reports paths that were left uncommitted while the daemon was stopped
  init(): Promise<{ created: boolean; dirty: string[] }> {
    return this.serial(async () => {
      if (!existsSync(path.join(this.root, '.git'))) {
        await this.run(['init', '-q', '-b', 'main'])
        // The PC has core.autocrlf=true globally, which would turn line endings into fake diffs
        await this.run(['config', 'core.autocrlf', 'false'])
        const attributes = path.join(this.root, '.gitattributes')
        if (!existsSync(attributes)) await writeFile(attributes, '* text=auto eol=lf\n')
        await this.run(['add', '-A'])
        await this.run(['commit', '-q', '-m', 'init: vault'])
        return { created: true, dirty: [] }
      }
      return { created: false, dirty: await this.dirty() }
    })
  }

  private async dirty(paths: string[] = []): Promise<string[]> {
    const out = await this.run(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths])
    const files: string[] = []
    const entries = out.split('\0').filter(Boolean)
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      files.push(entry.slice(3))
      // A rename entry is followed by its old path
      if (entry[0] === 'R' || entry[0] === 'C') i++
    }
    return files
  }

  // Commits exactly these paths and nothing else that may be staged. Returns null when nothing changed
  commit(paths: string[], message: string, author?: string): Promise<string | null> {
    return this.serial(async () => {
      if (paths.length === 0) return null
      const changed = await this.dirty(paths)
      if (changed.length === 0) return null
      await this.run(['add', '-A', '--', ...changed])
      const authorArgs = author ? ['--author', author] : []
      await this.run(['commit', '-q', '--only', ...authorArgs, '-m', message, '--', ...changed])
      return (await this.run(['rev-parse', 'HEAD'])).trim()
    })
  }

  log(file: string, limit: number): Promise<Commit[]> {
    return this.serial(async () => {
      const out = await this.run(['log', `-n${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%B%x1e', '--', file])
      return out
        .split('\x1e')
        .map(s => s.trim())
        .filter(Boolean)
        .map(line => {
          const [commit, author, date, message] = line.split('\x1f')
          return { commit, author, date, message: message.trim() }
        })
    })
  }
}
