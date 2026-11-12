import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { releaseCommit } from '../../scripts/release-commit.ts'

// A repo with two commits on main and one on a side branch from the first, tagged, as a fork's or a pull request's
// commit would sit beside main
let repo = ''
const commits: Record<'first' | 'tip' | 'side', string> = { first: '', tip: '', side: '' }
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const commit = async (name: string) => {
  await writeFile(path.join(repo, name), name)
  git('add', name)
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', name)
  return git('rev-parse', 'HEAD')
}

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'hetu-release-'))
  git('init', '-q', '--initial-branch=main')
  commits.first = await commit('first')
  commits.tip = await commit('tip')
  git('checkout', '-q', '-b', 'side', commits.first)
  commits.side = await commit('side')
  git('tag', 'side-tag')
  git('checkout', '-q', 'main')
})

afterAll(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('the commit a release builds', () => {
  it('is main\'s tip when no ref is named', () => {
    expect(releaseCommit('', { cwd: repo, main: commits.tip })).toBe(commits.tip)
  })

  it('is the full commit a ref names when main holds it', () => {
    expect(releaseCommit(commits.first, { cwd: repo, main: commits.tip })).toBe(commits.first)
    expect(releaseCommit(commits.first.slice(0, 10), { cwd: repo, main: commits.tip })).toBe(commits.first)
    expect(releaseCommit('main~1', { cwd: repo, main: commits.tip })).toBe(commits.first)
    expect(releaseCommit(commits.tip, { cwd: repo, main: commits.tip })).toBe(commits.tip)
  })

  it('refuses a commit main doesn\'t hold, by its hash, its branch or its tag', () => {
    for (const ref of [commits.side, 'side', 'side-tag']) {
      expect(() => releaseCommit(ref, { cwd: repo, main: commits.tip })).toThrow(/isn't a commit on main/)
    }
  })

  it('refuses a ref that names no commit, a tree among them or anything git would read as an option', () => {
    for (const ref of ['nope', `${commits.tip}^{tree}`, '--upload-pack=x', '-n', ' ']) {
      expect(() => releaseCommit(ref, { cwd: repo, main: commits.tip })).toThrow()
    }
  })
})

// The workflow can't run here, so its wiring is read: the input reaches the check only through the environment, the
// build checks out what the check printed and the CI query, the tag and the release name that commit
describe('the Release workflow\'s ref', () => {
  const workflow = () => readFile(path.join(import.meta.dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')

  it('passes the named ref to the check through the environment and builds what it printed', async () => {
    const text = await workflow()
    expect(text.match(/\$\{\{\s*inputs\.ref\s*\}\}/g)).toEqual(['${{ inputs.ref }}'])
    expect(text).toContain('          REF: ${{ inputs.ref }}\n          MAIN: ${{ github.sha }}\n')
    expect(text).toContain('commit=$(node scripts/release-commit.ts "$REF" "$MAIN")')
    expect(text).toContain('git checkout --quiet --detach "$commit"')
    expect(text).toContain('fetch-depth: 0')
  })

  it('checks CI and tags the release on the commit it built, never on main\'s tip unchecked', async () => {
    const text = await workflow()
    expect(text.match(/\$\{\{\s*github\.sha\s*\}\}/g)).toEqual(['${{ github.sha }}'])
    expect(text).toContain('          SHA: ${{ steps.commit.outputs.commit }}\n')
    expect(text).toContain('          SHA: ${{ needs.build.outputs.commit }}\n')
    expect(text).toContain("if: github.ref == 'refs/heads/main'")
  })
})
