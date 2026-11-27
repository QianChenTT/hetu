import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed, type SeedSummary } from './seed.ts'

// The tree's hash, pinned on macOS. A change to the seed changes it on purpose, and the new value goes here. It holds
// across platforms only once CI runs this file on Windows and Linux too. On a mismatch the message lists every file
const TREE_HASH = '6ba018150991071bc9f2453728509c6edb07007d8eb8c8778ef0bc4f9eb8d29b'

let base: string
let dir: string
let summary: SeedSummary
let files: Map<string, Buffer>
let folders: string[]

// Every file under dir by its path with / separators, and every folder, in code unit order
async function walk(root: string) {
  const found = new Map<string, Buffer>()
  const dirs: string[] = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const rel = path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    if (entry.isDirectory()) dirs.push(rel)
    else found.set(rel, await readFile(path.join(root, rel)))
  }
  return { files: new Map([...found].sort(([a], [b]) => (a < b ? -1 : 1))), folders: dirs.sort() }
}

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

function treeHash(tree: Map<string, Buffer>, dirs: string[]) {
  const hash = createHash('sha256')
  for (const folder of dirs) hash.update(`d ${folder}\n`)
  for (const [rel, bytes] of tree) hash.update(`f ${rel} ${bytes.length}\n`).update(bytes)
  return hash.digest('hex')
}

// Path, size and hash of each file, to diff against the same list from another platform
const listing = (tree: Map<string, Buffer>) => [...tree].map(([rel, b]) => `${rel} ${b.length} ${sha(b)}`).join('\n')

const text = (rel: string) => files.get(rel)!.toString('utf8')
const notes = () => [...files.keys()].filter(rel => rel.endsWith('.md') && !rel.split('/').some(s => s.startsWith('.')))
const under = (folder: string) => [...files.keys()].filter(rel => rel.startsWith(`${folder}/`))

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'hetu-seed-'))
  dir = path.join(base, 'one')
  summary = await seed(dir)
  ;({ files, folders } = await walk(dir))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('seed', () => {
  it('writes what the summary counts', () => {
    expect(summary.notes).toBe(notes().length)
    expect(summary.notes).toBe(257)
    expect(summary.daily).toBe(14)
    expect(summary.images).toBe(4)
    expect(summary.files).toBe(files.size)
    expect(summary.folders).toBe(folders.filter(f => !f.split('/').some(s => s.startsWith('.'))).length)
    expect(summary.emptyFolders).toBe(1)
  })

  it('writes the same tree and bytes on every run', async () => {
    const again = path.join(base, 'two')
    await seed(again)
    const second = await walk(again)
    expect([...second.files.keys()]).toEqual([...files.keys()])
    expect(treeHash(second.files, second.folders)).toBe(treeHash(files, folders))
    expect(treeHash(files, folders), listing(files)).toBe(TREE_HASH)
  })

  it('takes a seed of its own that changes the topic notes alone', async () => {
    const other = path.join(base, 'other')
    const its = await seed(other, { seed: 8 })
    const tree = await walk(other)
    expect(its.notes).toBe(summary.notes)
    expect([...tree.files.keys()]).toEqual([...files.keys()])
    const changed = [...files].filter(([rel, bytes]) => !bytes.equals(tree.files.get(rel)!)).map(([rel]) => rel)
    expect(changed.length).toBeGreaterThan(200)
    expect(changed.filter(rel => !text(rel).startsWith('---\ntitle: '))).toEqual([])
  })

  it('writes into a missing or empty folder and refuses anything else', async () => {
    const empty = await mkdtemp(path.join(base, 'empty-'))
    await expect(seed(empty)).resolves.toMatchObject({ notes: 257 })
    await expect(seed(empty)).rejects.toThrow(/not empty/)
    const dotted = path.join(base, 'dotted')
    await mkdir(dotted)
    await writeFile(path.join(dotted, '.DS_Store'), '')
    await expect(seed(dotted)).rejects.toThrow(/not empty/)
    expect(await readdir(dotted)).toEqual(['.DS_Store'])
    await writeFile(path.join(base, 'a file'), 'x')
    await expect(seed(path.join(base, 'a file'))).rejects.toThrow(/is not a folder/)
  })

  it('lets one of two seeds started together on a folder write it', async () => {
    const shared = path.join(base, 'shared')
    const results = await Promise.allSettled([seed(shared), seed(shared)])
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const tree = await walk(shared)
    expect(treeHash(tree.files, tree.folders)).toBe(treeHash(files, folders))
  })

  it('nests notes 3 folders deep with an empty folder and an image-only one', () => {
    expect(notes().some(rel => rel.split('/').length === 4)).toBe(true)
    expect(folders).toContain(summary.special.empty)
    expect(under(summary.special.empty)).toEqual([])
    const images = under(summary.special.imagesOnly)
    expect(images).toHaveLength(4)
    expect(images.every(rel => rel.endsWith('.png'))).toBe(true)
  })

  it('names notes in CJK, emoji, spaces and accents', () => {
    for (const name of ['Inbox/会议记录 2026.md', 'Inbox/🚀 Launch ideas.md', 'Resources/Recipes/中文菜谱/红烧肉 🍖.md',
      'Inbox/Café notes — résumé.md']) {
      expect(files.has(name)).toBe(true)
    }
  })

  it('writes a big note of exactly 5,000 lines', () => {
    const big = text(summary.special.big)
    expect(big.endsWith('\n')).toBe(true)
    expect(big.split('\n')).toHaveLength(5001)
  })

  it('writes 14 daily notes', () => {
    expect(under('Daily').filter(rel => /^Daily\/2026-11-\d\d\.md$/.test(rel))).toHaveLength(14)
  })

  it('gives each topic note frontmatter, aliased wikilinks, footnotes, callouts and tasks', () => {
    const note = text('Projects/Work/Alpha/Alpha note 01.md')
    expect(note.startsWith('---\ntitle: Alpha note 01\n')).toBe(true)
    expect(note).toMatch(/aliases: \["Alpha note 01 alias"\]/)
    expect(note).toMatch(/\[\[[^\]|]+\|alias link\]\]/)
    expect(note).toMatch(/\[\^1\][\s\S]*\n\[\^1\]: /)
    expect(note).toContain('> [!note] A callout')
    expect(note).toContain('> [!warning]- Folded warning')
    expect(note).toContain('- [ ] open task')
    expect(note).toContain('- [x] done task')
  })

  it('writes PNGs that inflate to their pixels', () => {
    const png = files.get(under(summary.special.imagesOnly)[0])!
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const length = png.readUInt32BE(33)
    expect(png.toString('latin1', 37, 41)).toBe('IDAT')
    expect(inflateSync(png.subarray(41, 41 + length))).toHaveLength(48 * (1 + 64 * 3))
  })

  it('points every Markdown link at a file that exists, ../ and encoded spaces among them', () => {
    let count = 0
    let upward = 0
    const forms = new Set<string>()
    for (const rel of notes()) {
      for (const [, dest] of text(rel).matchAll(/\]\((<[^>\n]*>|[^)\s]+)\)/g)) {
        const angled = dest.startsWith('<')
        if (angled) forms.add('angle')
        else if (dest.includes('%20')) forms.add('percent')
        // decodeURI, as the images plugin reads a path
        const target = angled ? dest.slice(1, -1) : decodeURI(dest)
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target))
        expect(files.has(resolved), `${rel} -> ${dest}`).toBe(true)
        expect(resolved, `${rel} links itself`).not.toBe(rel)
        count++
        if (target.startsWith('../')) upward++
      }
    }
    expect(count).toBeGreaterThan(240)
    expect(upward).toBeGreaterThan(100)
    expect([...forms].sort()).toEqual(['angle', 'percent'])
  })

  // A fact of the seed, not a judgment of hetu's resolver: each target names a file exactly. What the real build does
  // with the deliberate case is for tier 0's journeys, which read it from special
  it('names a file exactly with every wikilink but the deliberate one', () => {
    const known = new Set<string>()
    for (const rel of files.keys()) {
      const name = path.posix.basename(rel)
      known.add(rel).add(rel.replace(/\.md$/, '')).add(name).add(name.replace(/\.md$/, ''))
    }
    const missing = new Set<string>()
    for (const rel of notes()) {
      for (const [, inner] of text(rel).matchAll(/\[\[([^\]]+)\]\]/g)) {
        const target = inner.split('|')[0].split('#')[0]
        if (!known.has(target)) missing.add(target)
      }
    }
    expect([...missing]).toEqual([summary.special.unresolved])
  })
})
