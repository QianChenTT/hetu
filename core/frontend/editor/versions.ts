import { ChangeSet, MapMode } from '@codemirror/state'
import { MAX_KEPT_VERSIONS, type Mark } from '../../api/editor.ts'

// One open note's changes, counted from 0 when it opened, so data a plugin made for an older version can land on the
// text it was made for. Only the last MAX_KEPT_VERSIONS are kept: data for anything older is dropped or refused
export class Versions {
  private base = 0
  private readonly kept: ChangeSet[] = []
  private length: number

  constructor(length: number) {
    this.length = length
  }

  get version(): number {
    return this.base + this.kept.length
  }

  // Each change the instance applied, in order. One made against another length would map everything after it wrong
  push(changes: ChangeSet): void {
    if (changes.length !== this.length) throw new Error('a change made against another length')
    this.kept.push(changes)
    this.length = changes.newLength
    if (this.kept.length > MAX_KEPT_VERSIONS) {
      this.kept.shift()
      this.base++
    }
  }

  // The changes from version n to now, whose length is the text's length at n. Null for a version not kept or not made
  since(n: number): ChangeSet | null {
    if (!Number.isSafeInteger(n) || n < this.base || n > this.version) return null
    let composed = ChangeSet.empty(n === this.version ? this.length : this.kept[n - this.base].length)
    for (const changes of this.kept.slice(n - this.base)) composed = composed.compose(changes)
    return composed
  }

  // Marks made for version n, moved through the changes since. Null for a version not kept or not made
  mapMarks(marks: readonly Mark[], n: number): Mark[] | null {
    const since = this.since(n)
    return since === null ? null : mapThrough(marks, since)
  }

  // An edit made for version n, mapped through the changes since, as CodeMirror's collaboration guide rebases. stale
  // when n isn't kept, when it was made against another length or when a range it changes touches a range changed since
  rebase(changes: ChangeSet, n: number): ChangeSet | 'stale' {
    const since = this.since(n)
    if (since === null || changes.length !== since.length) return 'stale'
    let touched = false
    changes.iterChangedRanges((fromA, toA) => {
      if (since.touchesRange(fromA, toA) !== false) touched = true
    })
    return touched ? 'stale' : changes.map(since)
  }
}

// Marks moved through changes. A range whose text was deleted goes, as does one reaching past the text the changes start
// from. A point widget stays before text typed at its place
export function mapThrough(marks: readonly Mark[], changes: ChangeSet): Mark[] {
  const out: Mark[] = []
  for (const mark of marks) {
    if (mark.kind === 'line') {
      if (mark.from > changes.length) continue
      const from = changes.mapPos(mark.from, 1, MapMode.TrackDel)
      if (from !== null) out.push({ ...mark, from })
      continue
    }
    if (mark.to > changes.length) continue
    if (mark.kind === 'widget' && mark.from === mark.to) {
      const at = changes.mapPos(mark.from, -1)
      out.push({ ...mark, from: at, to: at })
      continue
    }
    const from = changes.mapPos(mark.from, 1)
    const to = changes.mapPos(mark.to, -1)
    if (to > from) out.push({ ...mark, from, to })
  }
  return out
}
