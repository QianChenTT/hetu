import { spawnSync } from 'node:child_process'

// Windows' mandatory integrity levels, the last sub-authority of a token's integrity SID
export const INTEGRITY = { low: 0x1000, medium: 0x2000, high: 0x3000, system: 0x4000 } as const

// Whether this shell holds an administrator's token: net session needs one
export const elevated = (): boolean => spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0

// Every requestedExecutionLevel in an executable's embedded manifests. NSIS and Electron keep the manifest as plain
// XML among the resources, so the bytes hold it as written
export function requestedLevels(bytes: Buffer): string[] {
  return [...bytes.toString('latin1').matchAll(/requestedExecutionLevel\s+level\s*=\s*["']([A-Za-z]+)["']/g)].map(match => match[1]!)
}

// Reads each running process of one executable and its token's integrity level, -1 where the token can't be read. The
// path goes in through the environment, so nothing in it is parsed as PowerShell
const INTEGRITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TokenIntegrity {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr info, int length, out int needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  public static long Of(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return -1;
    IntPtr token;
    bool opened = OpenProcessToken(process, 0x8, out token);
    CloseHandle(process);
    if (!opened) return -1;
    try {
      int needed;
      GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed);
      IntPtr info = Marshal.AllocHGlobal(needed);
      try {
        if (!GetTokenInformation(token, 25, info, needed, out needed)) return -1;
        IntPtr sid = Marshal.ReadIntPtr(info);
        int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
        return (uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
      } finally { Marshal.FreeHGlobal(info); }
    } finally { CloseHandle(token); }
  }
}
'@
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:HETU_INTEGRITY_OF } | ForEach-Object {
  "$($_.ProcessId) $([TokenIntegrity]::Of([int]$_.ProcessId))"
}
`

export function integrityOf(executable: string): { pid: number, level: number }[] {
  // Encoded, since a script read from stdin runs line by line and drops the here-string
  const encoded = Buffer.from(INTEGRITY_SCRIPT, 'utf16le').toString('base64')
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    env: { ...process.env, HETU_INTEGRITY_OF: executable },
  })
  if (run.status !== 0) throw new Error(`reading integrity levels failed: ${run.stderr}`)
  return run.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const [pid, level] = line.trim().split(' ')
    return { pid: Number(pid), level: Number(level) }
  })
}

// Whether a registry key exists in one view of the registry. HKLM's 64 and 32 bit views are apart, HKCU's Uninstall key
// is shared by both
export function registryKeyExists(key: string, view: 32 | 64): boolean {
  return spawnSync('reg', ['query', key, `/reg:${view}`], { stdio: 'ignore' }).status === 0
}

// One string value of a registry key, undefined when the key or the value is missing
export function registryValue(key: string, name: string, view: 32 | 64): string | undefined {
  const run = spawnSync('reg', ['query', key, '/v', name, `/reg:${view}`], { encoding: 'utf8' })
  if (run.status !== 0) return undefined
  const line = run.stdout.split(/\r?\n/).find(text => text.trim().startsWith(`${name} `))
  return line?.replace(/^\s*\S+\s+REG_\w+\s+/, '').trim()
}
