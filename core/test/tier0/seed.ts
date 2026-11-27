// The notes folder a tier 0 instance starts on: 257 notes 3 folders deep with every shape a vault in use has, written
// fresh for each instance. A run of its own PRNG picks the links, so the tree and its bytes are the same on every run
// and platform. The PNGs hold stored deflate blocks rather than zlib's output, which Node's bundled zlib may give
// differently by CPU. Keeping the notes read-only is the runner's part: each instance gets a fresh copy
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32 } from 'node:zlib'

export interface SeedOptions {
  // Picks the links and tags in the topic notes. The names, the tree and every other file stay the same for any seed
  seed?: number
}

export interface SeedSummary {
  // .md files outside the dot folders
  notes: number
  daily: number
  images: number
  files: number
  // Folders outside the dot folders, the root not counted
  folders: number
  emptyFolders: number
  // The path of each special case, relative with / separators
  special: {
    big: string
    empty: string
    imagesOnly: string
    // A wikilink to no file, left for the real build to judge, as written in Welcome.md
    unresolved: string
  }
}

// The file seed writes into a folder first, with wx, so two seeds on one folder can't both write. Removed at the end
const CLAIM = '.hetu-seed'
// Writes in flight at once
const BATCH = 32

// mulberry32: 32 bits of state, enough for a few hundred picks
function prng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

// k distinct items, as Python's random.sample gives them
function sample<T>(random: () => number, items: readonly T[], k: number): T[] {
  const pool = [...items]
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(random() * (pool.length - i))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, k)
}

function adler32(data: Buffer) {
  let a = 1
  let b = 0
  for (const byte of data) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function png(w: number, h: number, rgb: readonly number[]) {
  const row = Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  // One stored deflate block holds up to 65,535 bytes
  const block = Buffer.alloc(5)
  block.writeUInt8(1, 0)
  block.writeUInt16LE(raw.length, 1)
  block.writeUInt16LE(raw.length ^ 0xffff, 3)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(adler32(raw))
  const zdata = Buffer.concat([Buffer.from([0x78, 0x01]), block, raw, tail])
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zdata), chunk('IEND', Buffer.alloc(0))])
}

// A Markdown link target from one file to another, valid per CommonMark: angle brackets, or %20 and the rest of
// encodeURIComponent per segment. No name here holds a character decodeURI leaves encoded. Counted by segments, since
// path.posix.relative reads process.cwd()
function linkTo(from: string, to: string, angled: boolean) {
  const base = from.split('/').slice(0, -1)
  const parts = to.split('/')
  let same = 0
  while (same < base.length && same < parts.length - 1 && base[same] === parts[same]) same++
  const rel = [...Array<string>(base.length - same).fill('..'), ...parts.slice(same)]
  return angled ? `<${rel.join('/')}>` : rel.map(encodeURIComponent).join('/')
}

const TOPICS = ['Projects/Work/Alpha', 'Projects/Work/Beta', 'Projects/Personal/Garden', 'Reading/Books/Fiction',
  'Reading/Books/Nonfiction', 'Reading/Papers', 'Areas/Health', 'Areas/Finance/Budget', 'Resources/Recipes/中文菜谱',
  'Resources/Code/Snippets', 'Archive/2024', 'Inbox']
const TAGS = ['#project', '#idea', '#todo', '#reading', '#health', '#中文']
const EMPTY = 'Empty folder'
const IMAGES = 'Attachments'
const BIG = 'Archive/Big log 5000 lines.md'
const UNRESOLVED = 'Not written yet'
// No note links itself, so a self-link never stands in for a link between two notes
function topicNote(random: () => number, idx: number, folder: string, name: string, all: [string, string][]) {
  const rel = `${folder}/${name}.md`
  const other = sample(random, all.filter((_, i) => i !== idx), 3)
  const tags = sample(random, TAGS, 2)
  const day = String((idx % 28) + 1).padStart(2, '0')
  const target = `${other[2][0]}/${other[2][1]}.md`
  return `---
title: ${name}
created: 2026-10-${day}
tags: [${tags[0].slice(1)}, ${tags[1].slice(1)}]
aliases: ["${name} alias"]
---

# ${name}

Some text about ${name.toLowerCase()} with a [[${other[0][1]}]] wikilink and an aliased [[${other[1][1]}|alias link]].
A relative link: [see also](${linkTo(rel, target, idx % 2 === 0)}). Inline tags: ${tags.join(' ')}.

- [ ] open task for ${name}
- [x] done task
- [ ] another task

> [!note] A callout
> Callout body with **bold** text.

> [!warning]- Folded warning
> Hidden until opened.

Here is a footnote reference[^1] and another[^long].

[^1]: The first footnote.
[^long]: A longer footnote with a [[${other[0][1]}]] link.
`
}

// Takes dir for this seed alone: missing or empty, claimed by an exclusive create, then checked to hold nothing else.
// A seed that stops part way leaves the claim and a part of the tree, so a retry on that folder is refused as not
// empty. The caller starts again on a new folder
async function claim(dir: string) {
  const kind = await stat(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (kind !== null && !kind.isDirectory()) throw new Error(`seed: ${dir} is not a folder`)
  await mkdir(dir, { recursive: true })
  const marker = path.join(dir, CLAIM)
  await writeFile(marker, '', { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
    throw err.code === 'EEXIST' ? new Error(`seed: ${dir} is not empty`) : err
  })
  const found = await readdir(dir)
  if (found.length !== 1) {
    await unlink(marker)
    throw new Error(`seed: ${dir} is not empty`)
  }
  return marker
}

export async function seed(dir: string, options: SeedOptions = {}): Promise<SeedSummary> {
  const marker = await claim(dir)
  const random = prng(options.seed ?? 7)
  const out = new Map<string, string | Buffer>()

  const names: [string, string][] = TOPICS.flatMap(t =>
    Array.from({ length: 20 }, (_, i): [string, string] => [t, `${t.split('/').at(-1)} note ${String(i + 1).padStart(2, '0')}`]))
  names[3] = ['Inbox', '会议记录 2026']
  names[7] = ['Inbox', '🚀 Launch ideas']
  names[11] = ['Resources/Recipes/中文菜谱', '红烧肉 🍖']
  names[20] = ['Inbox', 'Café notes — résumé']
  names.forEach(([t, n], idx) => out.set(`${t}/${n}.md`, topicNote(random, idx, t, n, names)))

  for (let d = 1; d <= 14; d++) {
    const day = `2026-11-${String(d).padStart(2, '0')}`
    out.set(`Daily/${day}.md`, `# ${day}\n\n- [ ] Review [[Inbox note 01]]\n- Met with team about [[Alpha note 03]] #daily\n`)
  }

  // Exactly 5,000 lines, each entry linking a note that exists
  const lines = ['# Big log', '']
  for (let i = 3; i <= 5000; i++) {
    lines.push(`Line ${i}: entry with [[${names[i % 16][1]}]] and some words to make it realistic.`)
  }
  out.set(BIG, `${lines.join('\n')}\n`)

  out.set('Welcome.md', `# Welcome\n\nStart at [[Inbox note 01]] or [[会议记录 2026]].\n\n![[${IMAGES}/diagram-1.png]]\n\n` +
    `Edge cases:\n\n- [[${UNRESOLVED}]], a link left unresolved\n`)
  out.set('README notes.md', '# About this vault\n\nMigrated from Obsidian. See [Welcome](Welcome.md).\n')

  ;[[200, 40, 40], [40, 200, 40], [40, 40, 200], [200, 200, 40]].forEach((rgb, i) => {
    out.set(`${IMAGES}/diagram-${i + 1}.png`, png(64, 48, rgb))
  })

  const folderSet = new Set<string>([EMPTY])
  for (const rel of out.keys()) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) folderSet.add(parts.slice(0, i).join('/'))
  }
  const folders = [...folderSet].sort()
  for (const folder of folders) await mkdir(path.join(dir, folder), { recursive: true })
  const writes = [...out]
  for (let i = 0; i < writes.length; i += BATCH) {
    await Promise.all(writes.slice(i, i + BATCH).map(([rel, body]) => writeFile(path.join(dir, rel), body)))
  }
  await unlink(marker)

  const rels = [...out.keys()]
  const dotted = (rel: string) => rel.split('/').some(s => s.startsWith('.'))
  return {
    notes: rels.filter(rel => rel.endsWith('.md') && !dotted(rel)).length,
    daily: rels.filter(rel => rel.startsWith('Daily/')).length,
    images: rels.filter(rel => rel.endsWith('.png')).length,
    files: rels.length,
    folders: folders.filter(f => !dotted(f)).length,
    emptyFolders: folders.filter(f => !rels.some(rel => rel.startsWith(`${f}/`))).length,
    special: { big: BIG, empty: EMPTY, imagesOnly: IMAGES, unresolved: UNRESOLVED },
  }
}
