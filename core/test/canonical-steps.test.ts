import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonical } from '../lib/canonical.ts'

// Each look canonical takes at the disk, in order, with the name it looked at made relative to the folder it was in
const steps: string[] = []
let watched = ''

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  const noted = <T extends (...args: never[]) => Promise<unknown>>(name: string, step: T) => (async (...args: Parameters<T>) => {
    const at = String(args[0])
    if (watched !== '' && at.startsWith(watched)) steps.push(`${name} ${path.relative(watched, at).split(path.sep).slice(1).join('/')}`)
    return step(...args)
  }) as T
  return { ...real, realpath: noted('realpath', real.realpath), lstat: noted('lstat', real.lstat) }
})

let base: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-canonical-steps-')))
  for (const folder of ['dotted', 'bare']) await mkdir(path.join(base, folder, 'notes'), { recursive: true })
  await mkdir(path.join(base, 'dotted', '.obsidian', 'plugins', 'x'), { recursive: true })
  await writeFile(path.join(base, 'dotted', '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
  await symlink(path.join(base, 'dotted', '.obsidian'), path.join(base, 'dotted', 'cfg'), 'junction')
  await symlink(path.join(base, 'dotted', '.obsidian', 'plugins'), path.join(base, 'dotted', 'notes', 'deep'), 'junction')
  watched = base
})

afterEach(async () => {
  watched = ''
  steps.length = 0
  await rm(base, { recursive: true, force: true })
})

async function stepsOf(folder: string, input: string): Promise<string[]> {
  steps.length = 0
  await canonical(path.join(base, folder), input)
  return [...steps]
}

// The same looks in the same order. Their time still differs: a resolve that succeeds through a short name or a
// junction costs more than one that fails, so a caller timing many calls can tell the two apart
describe('the looks at the disk for a name spelled with no dot that leads to a dot name', () => {
  it.each(['cfg', 'cfg/plugins/x/main.js', 'cfg/plugins/y/new.js', 'notes/deep/x/main.js', 'notes/deep'])('are those a missing name gets: %s', async input => {
    const dotted = await stepsOf('dotted', input)
    expect(dotted).toEqual(await stepsOf('bare', input))
    expect(dotted.length).toBeGreaterThan(1)
  })
})
