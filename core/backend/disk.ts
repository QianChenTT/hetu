import { chmod, lstat, open } from 'node:fs/promises'

// What Windows answers when antivirus, an indexer or a sync tool holds a file open for a moment. A write, rename or
// delete over a held file can come back as any of these. A read only meets a sharing lock, EBUSY, since access denied
// on a read is an ACL that never passes and would cost the whole wait at every boot
const busy = { write: new Set(['EPERM', 'EBUSY', 'EACCES']), read: new Set(['EBUSY']) }

// Retries for about 2.5 seconds on Windows. A folder in the way is not a lock and fails at once, and neither is a
// read-only file for a write, which no wait gets past
export async function retried<T>(work: () => Promise<T>, target?: string, kind: 'write' | 'read' = 'write'): Promise<T> {
  for (let wait = 10; ; wait *= 2) {
    try {
      return await work()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || !busy[kind].has(code) || wait > 1280) throw err
      const found = target ? await lstat(target).catch(() => null) : null
      if (found?.isDirectory() || (kind === 'write' && found?.isFile() && (found.mode & 0o200) === 0)) throw err
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
}

// Windows won't replace or append to a read-only file, which a restore or a copy can leave. Only for hetu's own files,
// which hetu may clear
export async function writable(file: string): Promise<void> {
  if (process.platform !== 'win32') return
  const found = await lstat(file).catch(() => null)
  if (found?.isFile() && (found.mode & 0o200) === 0) await chmod(file, 0o666)
}

// What a file system answers when it can't sync a folder at all. PostgreSQL ignores the same ones
const cantSync = new Set(['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EACCES', 'EPERM'])

// A rename or a new file is only on disk once its folder is. Best effort: a file system that can't sync a folder must
// not fail a write whose change has landed. Node can't open a folder for this on Windows, where NTFS journals renames
// in order
export async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  let handle
  try {
    handle = await open(dir, 'r')
  } catch (err) {
    // A folder that isn't there holds nothing to sync, a delete in it changed nothing
    const code = (err as NodeJS.ErrnoException).code ?? ''
    if (code === 'ENOENT' || cantSync.has(code)) return
    throw err
  }
  try {
    await handle.sync()
  } catch (err) {
    if (!cantSync.has((err as NodeJS.ErrnoException).code ?? '')) throw err
  } finally {
    await handle.close()
  }
}
