import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { counted, logged } from './log.ts'

const made: string[] = []
afterEach(async () => {
  for (const folder of made.splice(0)) await rm(folder, { recursive: true, force: true })
})
async function data(files: Record<string, string>) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'hetu-tier0-log-'))
  made.push(folder)
  await mkdir(path.join(folder, 'events'))
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(folder, 'events', name), text)
  return folder
}
const line = (event: string, kind: string, target?: string) => `${JSON.stringify({ event, kind, target })}\n`

describe('tier 0\'s reading of the security log', () => {
  it('reads every segment in number order and leaves out a last line not finished', async () => {
    const folder = await data({
      'events-10.jsonl': line('security.applied', 'c'),
      'events-2.jsonl': line('security.confirm', 'b') + '{"event":"security.co',
      'events-1.jsonl': line('security.request', 'a'),
      'other.jsonl': line('security.request', 'x'),
    })
    expect((await logged(folder)).map(record => record.kind)).toEqual(['a', 'b', 'c'])
  })

  it('counts records by event and kind, by target only when one is named', async () => {
    const folder = await data({ 'events-1.jsonl': line('security.confirm', 'plugin.install', 'a') + line('security.confirm', 'plugin.install', 'b') })
    expect(await counted(folder, { event: 'security.confirm', kind: 'plugin.install' })).toBe(2)
    expect(await counted(folder, { event: 'security.confirm', kind: 'plugin.install', target: 'b' })).toBe(1)
  })

  it('reads nothing from a data folder with no log yet', async () => {
    expect(await logged(path.join(os.tmpdir(), 'hetu-tier0-no-such-folder'))).toEqual([])
  })
})
