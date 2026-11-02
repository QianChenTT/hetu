import { spawn, type ChildProcess } from 'node:child_process'

export const onWindows = process.platform === 'win32'

// Holds a file open from another process the way antivirus or a sync tool does, with the .NET FileShare flags given.
// Windows only. Node can't open a file without sharing, so the helper is PowerShell
export function holdOpen(file: string, share: 'None' | 'Read'): Promise<ChildProcess> {
  const script = `$f=[IO.File]::Open('${file.replace(/'/g, "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::${share}); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep 30; $f.Close()`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let err = ''
    child.stderr!.on('data', d => { err += d })
    child.stdout!.on('data', d => { if (String(d).includes('held')) resolve(child) })
    child.on('exit', code => reject(new Error(`hold helper exited ${code}: ${err}`)))
  })
}

export function release(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    child.removeAllListeners('exit')
    child.on('exit', () => resolve())
    child.kill()
  })
}

// Lets go of the file after ms, while the code under test is waiting on it
export function releaseAfter(child: ChildProcess, ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(() => resolve(release(child)), ms))
}
