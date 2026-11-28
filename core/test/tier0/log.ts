// The security log as an audit reads it from a data folder: every segment in order, a last line still being written
// left out
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export type Logged = { event: string, kind?: string, target?: string }

const segment = /^events-(\d+)\.jsonl$/
export async function logged(data: string): Promise<Logged[]> {
  const folder = path.join(data, 'events')
  const names = (await readdir(folder).catch(() => [])).filter(name => segment.test(name))
    .sort((a, b) => Number(segment.exec(a)![1]) - Number(segment.exec(b)![1]))
  const found: Logged[] = []
  for (const name of names) {
    const lines = (await readFile(path.join(folder, name), 'utf8')).split('\n')
    // The text after the last newline is a line not finished yet, or nothing
    for (const line of lines.slice(0, -1)) if (line !== '') found.push(JSON.parse(line) as Logged)
  }
  return found
}

// How many records match wanted, any target when it names none
export const counted = async (data: string, wanted: Logged) =>
  (await logged(data)).filter(record => record.event === wanted.event && record.kind === wanted.kind && (wanted.target === undefined || record.target === wanted.target)).length
