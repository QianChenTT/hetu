// Words are lowercase runs of letters and digits in any script
const word = /[\p{L}\p{N}]+/gu

export function wordsOf(text: string): string[] {
  return [...new Set(text.toLowerCase().match(word) ?? [])]
}

export type SavedIndex = { v: 1, notes: Record<string, string[]> }

// The words of each note search has read. byWord holds the notes each word is in
export class Index {
  private readonly notes = new Map<string, string[]>()
  private readonly byWord = new Map<string, Set<string>>()

  add(path: string, text: string): void {
    this.put(path, wordsOf(text))
  }

  remove(path: string): void {
    const words = this.notes.get(path)
    if (words === undefined) return
    this.notes.delete(path)
    for (const item of words) {
      const paths = this.byWord.get(item)
      paths?.delete(path)
      if (paths?.size === 0) this.byWord.delete(item)
    }
  }

  paths(): string[] {
    return [...this.notes.keys()].sort()
  }

  // The notes holding every word of text, sorted by path. No word finds nothing
  search(text: string): string[] {
    const words = wordsOf(text)
    if (words.length === 0) return []
    let hits = [...(this.byWord.get(words[0]) ?? [])]
    for (const item of words.slice(1)) {
      const paths = this.byWord.get(item)
      hits = hits.filter(path => paths?.has(path) === true)
    }
    return hits.sort()
  }

  toJSON(): SavedIndex {
    return { v: 1, notes: Object.fromEntries(this.notes) }
  }

  // A saved index in this shape, or an empty one for anything else: an older version, a wiped cache or bad data
  static from(saved: unknown): Index {
    const index = new Index()
    if (typeof saved !== 'object' || saved === null) return index
    const { v, notes } = saved as { v?: unknown, notes?: unknown }
    if (v !== 1 || typeof notes !== 'object' || notes === null) return index
    const entries = Object.entries(notes)
    if (!entries.every(([, words]) => Array.isArray(words) && words.every(item => typeof item === 'string'))) return index
    for (const [path, words] of entries) index.put(path, words as string[])
    return index
  }

  private put(path: string, words: string[]): void {
    this.remove(path)
    this.notes.set(path, words)
    for (const item of words) {
      let paths = this.byWord.get(item)
      if (paths === undefined) {
        paths = new Set()
        this.byWord.set(item, paths)
      }
      paths.add(path)
    }
  }
}
