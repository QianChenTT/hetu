// The commit a release builds: main's tip when ref is empty, else the commit ref names, which main must hold. Run by
// the Release workflow on a full clone of main as `node scripts/release-commit.ts <ref> <main's commit>`, it prints the
// full hash or exits 1 with the reason
import { execFileSync } from 'node:child_process'

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

export function releaseCommit(ref: string, options: { cwd: string, main: string }): string {
  if (ref === '') return git(options.cwd, ['rev-parse', '--verify', '--end-of-options', `${options.main}^{commit}`])
  // A ref is a name or a hash, never an option or anything git reads past its first word
  if (!/^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/.test(ref)) throw new Error(`${ref} isn't a ref`)
  let commit: string
  try {
    commit = git(options.cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
  } catch {
    throw new Error(`${ref} names no commit`)
  }
  try {
    git(options.cwd, ['merge-base', '--is-ancestor', commit, options.main])
  } catch {
    throw new Error(`${ref} (${commit}) isn't a commit on main`)
  }
  return commit
}

if (import.meta.main) {
  try {
    console.log(releaseCommit(process.argv[2] ?? '', { cwd: process.cwd(), main: process.argv[3] ?? '' }))
  } catch (err) {
    console.error(`::error::${(err as Error).message}`)
    process.exit(1)
  }
}
