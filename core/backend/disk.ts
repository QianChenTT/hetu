import { lstat, open } from 'node:fs/promises'

// What Windows answers when antivirus, an indexer or a sync tool holds a file open for a moment
const busy = new Set(['EPERM', 'EBUSY', 'EACCES'])

// Retries a rename, delete or read for about 2.5 seconds on Windows. A folder in the way is not a lock and fails at once
export async function retried<T>(work: () => Promise<T>, target?: string): Promise<T> {
  for (let wait = 10; ; wait *= 2) {
    try {
      return await work()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || !busy.has(code) || wait > 1280) throw err
      if (target && (await lstat(target).catch(() => null))?.isDirectory()) throw err
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
}

// A rename or a new file is only on disk once its folder is. Node can't open a folder for this on Windows, where NTFS
// journals renames in order
export async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(dir, 'r').catch(err => {
    // A folder that isn't there holds nothing to sync, a delete in it changed nothing
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  })
  if (handle === null) return
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
