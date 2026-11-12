import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreStatus } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import { StateStore } from '../backend/boot/state.ts'
import { cleanup, entryFor, filesFor, harness, workerManifest } from './loader-fakes.ts'

afterEach(cleanup)

const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const status = async (made: Awaited<ReturnType<typeof harness>>) =>
  (await made.loader.serve({ callId: 'c1', caller: editor, action: 'core.status', args: undefined, deadline: Date.now() + 30_000 })) as CoreStatus
const notes = { folder: process.platform === 'win32' ? 'C:\\Users\\han\\notes' : '/home/han/notes' }
const stateFile = (dataDir: string, ...parts: string[]) => path.join(dataDir, 'state', ...parts)

describe('the state files that failed their check, for the banner', () => {
  it('names nothing after a start whose checks all passed', async () => {
    const made = await harness({ folder: { alpha: filesFor(workerManifest('alpha')) }, entries: { alpha: root => entryFor(root) } })
    await made.loader.start()
    expect((await status(made)).suspect).toEqual([])
  })

  it('names each kind of file that failed, in a fixed order and never by path', async () => {
    const made = await harness({
      folder: { alpha: filesFor(workerManifest('alpha')) },
      entries: { alpha: root => entryFor(root) },
      before: async ({ dataDir }) => {
        await new StateStore(dataDir).writeLuoshu(notes)
        await appendFile(stateFile(dataDir, 'plugins', 'alpha.json'), ' ')
        await appendFile(stateFile(dataDir, 'luoshu.json'), ' ')
        await writeFile(stateFile(dataDir, 'switches.json'), '{}')
      },
    })
    await made.loader.start()
    expect((await status(made)).suspect).toEqual(['switches', 'luoshu', 'plugins'])
  })

  it('names the plugins when only one plugin entry failed', async () => {
    const made = await harness({
      folder: { alpha: filesFor(workerManifest('alpha')) },
      entries: { alpha: root => entryFor(root) },
      before: async ({ dataDir }) => {
        await appendFile(stateFile(dataDir, 'plugins', 'alpha.json'), ' ')
      },
    })
    await made.loader.start()
    expect((await status(made)).suspect).toEqual(['plugins'])
  })

  it('names the plugins for an entry whose name is no plugin id', async () => {
    const made = await harness({
      before: async ({ dataDir }) => {
        await mkdir(stateFile(dataDir, 'plugins'), { recursive: true })
        await writeFile(stateFile(dataDir, 'plugins', 'Not An Id.json'), '{}')
      },
    })
    await made.loader.start()
    expect((await status(made)).suspect).toEqual(['plugins'])
  })
})
