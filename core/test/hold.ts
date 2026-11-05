import { spawn, type ChildProcess } from 'node:child_process'

export const onWindows = process.platform === 'win32'

// Every helper still holding a file, so a test that fails or times out can't leave one behind for the next test
const live = new Set<ChildProcess>()

// Holds a file open from another process the way antivirus or a sync tool does, with the .NET FileShare flags given.
// Windows only. Node can't open a file without sharing, so the helper is PowerShell
export function holdOpen(file: string, share: 'None' | 'Read'): Promise<ChildProcess> {
  const script = `$f=[IO.File]::Open('${file.replace(/'/g, "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::${share}); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep 30; $f.Close()`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  live.add(child)
  return new Promise((resolve, reject) => {
    let err = ''
    child.stderr!.on('data', d => { err += d })
    child.stdout!.on('data', d => { if (String(d).includes('held')) resolve(child) })
    child.on('exit', code => {
      live.delete(child)
      reject(new Error(`hold helper exited ${code}: ${err}`))
    })
  })
}

export function release(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    child.removeAllListeners('exit')
    if (child.exitCode !== null || child.signalCode !== null) {
      live.delete(child)
      return resolve()
    }
    child.on('exit', () => {
      live.delete(child)
      resolve()
    })
    child.kill()
  })
}

// Lets go of the file after ms, while the code under test is waiting on it
export function releaseAfter(child: ChildProcess, ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(() => resolve(release(child)), ms))
}

// For afterEach, before the temp folder is removed
export async function releaseAll(): Promise<void> {
  await Promise.all([...live].map(release))
}

// PowerShell takes a second or more to start, so a test that holds a file gets more than vitest's 5 seconds
export const HOLD_TIMEOUT = 15_000
