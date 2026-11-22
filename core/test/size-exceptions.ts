// the shipped files allowed over 800 lines, each with the most lines it may have and the reason. An entry is
// added or its cap raised only by a decision about that file, never to make CI pass. size.test.ts holds each file to exactly its cap: one that shrinks
// lowers its cap in the same change, so it never grows back. It fails on an entry whose file is gone or back under 800,
// so a file split takes its entry out in the same change
export const sizeExceptions: Readonly<Record<string, { cap: number, why: string }>> = {
  'core/backend/providers/luoshu/luoshu.ts': { cap: 817, why: 'split in the redesign\'s build, after the router, raised from 808 by the owner for keeping nothing for a refused prepare, to 817 by the owner for four whys on their own lines (D-641)' },
}
