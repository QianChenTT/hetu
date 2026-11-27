// How much memory a new instance can have, and the wait for it
import { execFileSync } from 'node:child_process'
import os from 'node:os'

// Free memory as the OS can hand it to a new process. macOS counts inactive and speculative pages as reclaimable,
// which os.freemem leaves out
export function freeGb(): number {
  if (process.platform !== 'darwin') return os.freemem() / 2 ** 30
  const stats = execFileSync('vm_stat', { encoding: 'utf8' })
  const pageSize = Number(/page size of (\d+) bytes/.exec(stats)?.[1] ?? 16384)
  const pages = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(stats)?.[1] ?? 0)
  return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize / 2 ** 30
}

// Polls until free reaches the floor or waitMs runs out, answering whether it did and the last reading
export async function waitForMemory(options: { free?: () => number, floor: number, waitMs: number, poll?: number }): Promise<{ ok: boolean, free: number }> {
  const { free = freeGb, floor, waitMs, poll = 1000 } = options
  for (const begun = Date.now(); ;) {
    const now = free()
    if (now >= floor) return { ok: true, free: now }
    if (Date.now() - begun >= waitMs) return { ok: false, free: now }
    await new Promise(resolve => setTimeout(resolve, poll))
  }
}
