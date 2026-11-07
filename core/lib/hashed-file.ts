import { createHash, randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { evaluate, parse } from '@humanwhocodes/momoa'
import type { z } from 'zod'
import { retried, syncDir } from './disk.ts'

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

type Node = ReturnType<typeof parse>['body']

// JSON.parse keeps the last duplicate silently, so the approval screen and the loader could read different values
function rejectBadKeys(node: Node): void {
  if (node.type === 'Array') {
    for (const element of node.elements) rejectBadKeys(element.value)
  } else if (node.type === 'Object') {
    const seen = new Set<string>()
    for (const member of node.members) {
      const name = member.name.type === 'String' ? member.name.value : member.name.name
      if (seen.has(name)) throw new Error('duplicate key')
      if (name === '__proto__') throw new Error('__proto__ key')
      seen.add(name)
      rejectBadKeys(member.value)
    }
  }
}

// One parser for the key check and the values, so the two can't disagree about the bytes
export function parseStrict<T extends z.ZodType>(bytes: Buffer, schema: T): z.output<T> {
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const document = parse(source)
  rejectBadKeys(document.body)
  return schema.parse(evaluate(document))
}

// A crash leaves the old file or the new one, never half of either
export async function replaceFile(file: string, bytes: Buffer | string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temp, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await retried(() => rename(temp, file), file)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
  await syncDir(path.dirname(file))
}

// The hash sits on a file's last line, over every byte before it, so one rename writes the state and its hash together
// and nothing can leave a new file beside an old hash
export function withHash(body: Buffer): Buffer {
  return Buffer.concat([body, Buffer.from(`${sha256(body)}\n`)])
}

// The body above the hash line, or why the file doesn't check out. A last line that isn't a hash means there is none,
// one that is must be exactly the lowercase hash of the bytes before it with one newline after
export function checkHash(bytes: Buffer): { body: Buffer } | { result: 'hash-missing' | 'hash-mismatch' } {
  const end = bytes.at(-1) === 0x0a ? bytes.length - 1 : bytes.length
  const start = end > 0 ? bytes.lastIndexOf(0x0a, end - 1) + 1 : 0
  const line = bytes.subarray(start, end).toString('latin1')
  if (start === 0 || !/^[0-9a-f]{64}$/i.test(line)) return { result: 'hash-missing' }
  const body = bytes.subarray(0, start)
  if (end === bytes.length || line !== sha256(body)) return { result: 'hash-mismatch' }
  return { body }
}
