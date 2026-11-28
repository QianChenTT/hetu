import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed, type SeedSummary } from './seed.ts'

// The tree's hash on every platform. A change to the seed changes it on purpose, and the new value goes here
const TREE_HASH = '45bbd36f25871597433df26fcef5193bba89583a5f818534fee430d4615d8fd2'

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

function treeHash(tree: Map<string, Buffer>, dirs: string[]) {
  const hash = createHash('sha256')
  for (const folder of dirs) hash.update(`d ${folder}\n`)
  for (const [rel, bytes] of tree) hash.update(`f ${rel} ${bytes.length}\n`).update(bytes)
  return hash.digest('hex')
}

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
    expect(treeHash(files, folders)).toBe(TREE_HASH)
  })

  it('takes a seed of its own for other links in the same tree', async () => {
    const other = path.join(base, 'other')
    const its = await seed(other, { seed: 8 })
    const tree = await walk(other)
    expect(its.notes).toBe(summary.notes)
    expect([...tree.files.keys()]).toEqual([...files.keys()])
    expect(treeHash(tree.files, tree.folders)).not.toBe(treeHash(files, folders))
  })

  it('refuses a folder that holds anything', async () => {
    const full = path.join(base, 'full')
    await seed(full)
    await expect(seed(full)).rejects.toThrow(/not empty/)
    await writeFile(path.join(base, 'a file'), 'x')
    await expect(seed(path.join(base, 'a file'))).rejects.toThrow()
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
    const png = files.get(`${summary.special.imagesOnly}/diagram-1.png`)!
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
        const target = angled ? dest.slice(1, -1) : decodeURIComponent(dest)
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target))
        expect(files.has(resolved), `${rel} -> ${dest}`).toBe(true)
        count++
        if (target.startsWith('../')) upward++
      }
    }
    expect(count).toBeGreaterThan(240)
    expect(upward).toBeGreaterThan(100)
    expect([...forms].sort()).toEqual(['angle', 'percent'])
  })

  it('resolves every wikilink by name or path except the one left unresolved on purpose', () => {
    const known = new Set<string>()
    for (const rel of files.keys()) {
      const plain = rel.normalize('NFC')
      known.add(plain).add(plain.replace(/\.md$/, '')).add(path.posix.basename(plain))
      known.add(path.posix.basename(plain).replace(/\.md$/, ''))
    }
    const missing = new Set<string>()
    for (const rel of notes()) {
      for (const [, inner] of text(rel).matchAll(/\[\[([^\]]+)\]\]/g)) {
        const target = inner.split('|')[0].split('#')[0].normalize('NFC')
        if (!known.has(target)) missing.add(target)
      }
    }
    expect([...missing]).toEqual([summary.special.unresolved])
  })
})
