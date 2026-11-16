import { mkdir, rename, rmdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Prepared } from 'hetu-core/api/slots.ts'
import { callOf, cleanup, commitOf, logOf, place, started } from './helpers.ts'

const junctions: string[] = []

afterEach(async () => {
  // A junction first, so the removal never follows one into the folder it leads to
  for (const junction of junctions.splice(0)) await rmdir(junction).catch(() => {})
  await cleanup()
})

// Folders NTFS keeps apart whose paths give one key. Elsewhere the pairs are one name or the junction can't be made
describe.runIf(process.platform === 'win32')('a commit whose folder is swapped for a junction to a sibling of the same key after prepare', () => {
  it.each([
    ['stra\u00dfe', 'strasse'],
    ['caf\u00e9', 'cafe\u0301'],
    ['pub', 'pub\u200d'],
    ['kelvin', '\u212aelvin'],
  ])('refuses the commit of %s/n.md with %s behind it and commits nothing', async (granted, sibling) => {
    const where = await place()
    const at = (...names: string[]) => path.join(where.notes, ...names)
    for (const dir of [granted, sibling, 'plain']) await mkdir(at(dir))
    await writeFile(at(granted, 'n.md'), 'granted n')
    await writeFile(at(sibling, 'n.md'), 'SIBLING SECRET')
    await writeFile(at('plain', 'n.md'), 'plain n')
    const history = await started(where)
    await commitOf(history, ['plain/n.md'], 'first')
    const call = callOf('history.commit', { paths: [`${granted}/n.md`], message: 'swapped' })
    const prepared = await history.provider.prepare(call) as Prepared
    expect(prepared.scope.paths).toEqual([`${granted}/n.md`])
    await rename(at(granted), at(`${granted}-was`))
    await symlink(at(sibling), at(granted), 'junction')
    junctions.push(at(granted))
    let made: unknown
    try {
      made = await history.provider.perform(call, prepared)
    } catch (err) {
      made = { refused: err }
    }
    await rmdir(at(granted))
    junctions.pop()
    await rename(at(`${granted}-was`), at(granted))
    expect(made).toEqual({ refused: { code: 'not-granted' } })
    expect(await logOf(history, `${sibling}/n.md`)).toEqual([])
    expect((await logOf(history, 'plain/n.md')).map(listed => listed.message)).toEqual(['first'])
  })
})
