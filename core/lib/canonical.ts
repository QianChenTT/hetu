import { randomBytes } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { RefusalCode } from '../api/envelope.ts'
import { isDotName, isGitName, MAX_SCOPE_LENGTH, withoutIgnorable } from '../api/scope.ts'

// A string that breaks a rule answers invalid and a refusal from the disk answers not-granted, so a caller can't tell
// a link out of the luoshu from a missing grant. rule names the check for ctx.debug and the tests, never for a reply.
// Not named Refused, the name the SDK gives its error, which carries no rule
export type StringRule =
  | 'type' | 'empty' | 'too-long' | 'ill-formed' | 'absolute' | 'backslash' | 'colon' | 'control'
  | 'empty-segment' | 'dot-segment' | 'trailing' | 'device'
export type DiskRule = 'unresolved' | 'outside' | 'root' | 'git' | 'dot' | 'data' | 'install'
// absent is there when the caller spelled no dot segment and a name on the way leads to a dot name through a link, a
// junction or an 8.3 short name: the same input as if nothing were there from that name on. Its relative and key are
// what a missing name gets and its absolute a path no file has. A provider that only reads may act on it, so the
// answer tells the caller no more than a missing name's. The time it takes still can, since a resolve that succeeds
// through a short name or a junction costs more than one that fails. One that writes refuses it as it would the dot name
export type NotCanonical =
  | { ok: false, code: Extract<RefusalCode, 'invalid'>, rule: StringRule }
  | { ok: false, code: Extract<RefusalCode, 'not-granted'>, rule: DiskRule, absent?: Canonical }

// absolute is for the disk. relative joins the names with / on every platform and is what the gate, the guards and
// the records see. key is only for the luoshu's per-path lock and the lease table's conflict check
export type Canonical = { ok: true, absolute: string, relative: string, key: string }

// hetu's own folders, which a luoshu picked at the home folder holds
export type CanonicalOptions = { dataDir?: string, installDir?: string }

// ASCII letters only. JS case folding joins names NTFS keeps apart, such as the Kelvin sign and k
const fold = (text: string) => text.replace(/[A-Z]/g, letter => letter.toLowerCase())

// Win32 opens a device for these names in any folder, with any extension and with spaces before the dot. The
// superscript digits count as digits there. CONIN$ and CONOUT$ come from CPython's isreserved, COM0 and LPT0 from the
// plugin id rule in core/api/ids.ts. Refused on every platform, since a luoshu moves between machines
const devices = new Set([
  'con', 'prn', 'aux', 'nul', 'conin$', 'conout$',
  ...[...'0123456789\u00b9\u00b2\u00b3'].flatMap(digit => [`com${digit}`, `lpt${digit}`]),
])

// For locks and leases only. A name that doesn't exist yet keeps the caller's spelling, so two spellings of one new
// note meet only here. Drops what HFS+ skips, takes NFC since APFS reads both forms as one name and folds case
// further than lowercase does, since lowercase keeps the sharp s, the long s and the micro sign apart from the ss, s
// and mu APFS reads them as. Folding more than a volume does only makes two notes share a lock or block each other's
// lease. The same fold in matching would widen a grant
const keyOf = (relative: string) =>
  withoutIgnorable(relative).normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')

// Before the disk is touched. Each rule closes a spelling the OS or the path joiner reads as another name
function stringRule(input: string): StringRule | null {
  if (typeof input !== 'string') return 'type'
  if (input === '') return 'empty'
  if (input.length > MAX_SCOPE_LENGTH) return 'too-long'
  // A lone surrogate becomes U+FFFD on the way to the disk, so two spellings would name one file
  if (!input.isWellFormed()) return 'ill-formed'
  if (input.startsWith('/') || /^[a-z]:/i.test(input)) return 'absolute'
  // Refused, not converted as the daemon's normalize does: on macOS and Linux a backslash is part of a name, so one
  // request would name different files on different platforms
  if (input.includes('\\')) return 'backslash'
  // Stream names too: a.md::$DATA opens a.md and .git::$INDEX_ALLOCATION opens .git
  if (input.includes(':')) return 'colon'
  if (/\p{Cc}/u.test(input)) return 'control'
  for (const name of input.split('/')) {
    if (name === '') return 'empty-segment'
    if (name === '.' || name === '..') return 'dot-segment'
    // Win32 drops trailing dots and spaces, so a.md. opens a.md and .git. opens .git
    if (name.endsWith('.') || name.endsWith(' ')) return 'trailing'
    if (devices.has(fold(name.split('.')[0].replace(/ +$/, '')))) return 'device'
  }
  return null
}

// ENOTDIR is a name below a file, which can't exist either
const absent = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')

const withSep = (folder: string) => folder.endsWith(path.sep) ? folder : folder + path.sep

// Exact on purpose: both sides come from the OS, so another spelling is another folder or a refusal, never a match
const within = (folder: string, target: string) => target === folder || target.startsWith(withSep(folder))

// The real path of the deepest part that exists and the names under that part, which don't exist yet, each part
// resolved from the luoshu down. null when something on the way exists and can't be resolved: a link to nowhere, a
// loop, a folder that can't be read. A part that resolves to a dot name inside base ends the walk as a missing part
// would, so nothing past it is looked at. hidden names the rule that name breaks
async function deepest(base: string, names: string[]): Promise<{ real: string, rest: string[], hidden: 'git' | 'dot' | null } | null> {
  let real = base
  for (let i = 0; i < names.length; i++) {
    const candidate = path.join(base, ...names.slice(0, i + 1))
    let next: string
    try {
      next = await realpath(candidate)
    } catch (err) {
      if (!absent(err)) return null
      // realpath answers alike for a missing name and for a link to a missing target. A write through that link would
      // create the target wherever the link points, so only a name lstat can't find either counts as not there yet
      try {
        await lstat(candidate)
        return null
      } catch (err) {
        if (!absent(err)) return null
      }
      return { real, rest: names.slice(i), hidden: null }
    }
    const reached = within(base, next) && next !== base ? next.slice(withSep(base).length).split(path.sep) : []
    if (reached.some(isDotName)) {
      // The lstat a missing part gets too, so both take the same steps on the disk
      await lstat(candidate).catch(() => {})
      return { real, rest: names.slice(i), hidden: reached.some(isGitName) ? 'git' : 'dot' }
    }
    real = next
  }
  return { real, rest: [], hidden: null }
}

// The folder of a path canonical gave, looked at again just before a provider acts on the path: held when it still
// resolves to itself, missing when it is gone and the deepest folder on the way that is there still resolves to
// itself, moved otherwise. prepare judged the path. A folder on the way swapped for a link or a junction since would
// carry the act out of what was judged, so a provider refuses moved as canonical refuses a link out. What is left is
// the time between this look and the act
export const folderState = (absolute: string) => stateOf(path.dirname(absolute))

// The folder a listing walks, looked at itself as folderState looks at the folder a note sits in
export const listedState = (folder: string) => stateOf(folder)

export type FolderState = 'held' | 'moved' | 'missing'

// A look that finds the folder moved gets one more: canonical once more on the spelling the caller wrote. When that
// gives the key prepare took, the disk reads the spelling as the same name now, as when a write sent beside this one
// made a new folder under another case or another program changed a name's case. The key folds further than the gate
// matches, so a relative path that differs in any character from the one judged goes on only when judged says the gate
// allows it and is moved otherwise. The call then acts on the path it gives and the folder of that path is looked at
// as before
export async function looked(
  target: Canonical, look: (absolute: string) => Promise<FolderState>, again: () => Promise<Canonical | NotCanonical>,
  judged: (now: Canonical) => boolean = () => false,
): Promise<{ state: FolderState, target: Canonical }> {
  const state = await look(target.absolute)
  if (state !== 'moved') return { state, target }
  const now = await again()
  if (!now.ok || now.key !== target.key) return { state, target }
  if (now.relative !== target.relative && !judged(now)) return { state, target }
  return { state: await look(now.absolute), target: now }
}

// A file a provider opened or is about to act on, as fstat or lstat gives it, so a look by name can tell whether the
// name still holds that file
export type Opened = { readonly ino: bigint, readonly dev: bigint }

// A file a provider holds open, looked at again by name: canonical once more on the spelling the caller wrote. The
// open follows whatever name the disk gives that spelling, another case of the last name made since prepare included,
// which no look at the folder sees. held when the spelling gives the key prepare took and its path holds the file
// opened, at the path judged or at one judged says the gate allows, which is the path to act on and record. replaced
// when the path holds another file or none, a note written, moved or removed since the open, which can be opened
// again. moved otherwise, which a provider refuses as it refuses a folder that moved. The file is compared before the
// judge is asked, so the judge only hears of the path of the file opened. The lstat looks the name up without case, and
// a resolve that meets no file keeps the caller's spelling of the last name, so a file that left the name and came back
// to it between the resolve and the lstat would answer to a path resolved while another file or none was there. So the
// path is resolved once more by itself after the lstat and has to come back as it is, a file stored under that very
// name, then the lstat once more has to find the file opened. What is left is a name that holds the file opened at both
// lstats and another file, stored under the path resolved, at the second resolve between them
export async function named(
  target: Canonical, opened: Opened, again: () => Promise<Canonical | NotCanonical>, judged: (now: Canonical) => boolean,
): Promise<{ state: 'held', target: Canonical } | { state: 'replaced' | 'moved' }> {
  const now = await again()
  if (!now.ok || now.key !== target.key) return { state: 'moved' }
  if (!(await holdsFile(now.absolute, opened))) return { state: 'replaced' }
  if ((await realpath(now.absolute).catch(() => null)) !== now.absolute) return { state: 'replaced' }
  if (!(await holdsFile(now.absolute, opened))) return { state: 'replaced' }
  if (now.relative !== target.relative && !judged(now)) return { state: 'moved' }
  return { state: 'held', target: now }
}

// Whether the name holds the file given, by file id, never through a link at the name
async function holdsFile(absolute: string, file: Opened): Promise<boolean> {
  const there = await lstat(absolute, { bigint: true }).catch(() => null)
  return there !== null && there.ino === file.ino && there.dev === file.dev
}

async function stateOf(folder: string): Promise<FolderState> {
  let dir = folder
  for (let gone = false; ; gone = true) {
    try {
      return (await realpath(dir)) !== dir ? 'moved' : gone ? 'missing' : 'held'
    } catch (err) {
      const up = path.dirname(dir)
      if (!absent(err) || up === dir) return 'moved'
      dir = up
    }
  }
}

// For a provider's prepare step. The string rules run first. Then the OS resolves each part that exists, with links,
// junctions and 8.3 short names. The names that don't exist yet are kept for a write. The promise form of
// realpath is realpath.native. Resolves once and keeps nothing open: the caller acts on exactly the path returned and
// the provider holds the per-path lock on key from prepare to perform. The spellings of one name give one key, so no
// other hetu write to that name runs in between. On Windows a name not there yet that reads like an 8.3 short name,
// such as NEWFOL~1, is the exception: a write under another key that creates New folder name can give that folder
// the same short name, as another program can a note. The luoshu lands a new note by a link, which fails on such a name
export async function canonical(root: string, input: string, options: CanonicalOptions = {}): Promise<Canonical | NotCanonical> {
  const broken = stringRule(input)
  if (broken !== null) return { ok: false, code: 'invalid', rule: broken }
  const refuse = (rule: DiskRule): Extract<NotCanonical, { code: 'not-granted' }> => ({ ok: false, code: 'not-granted', rule })

  const rootReal = await realpath(root).catch(() => null)
  if (rootReal === null) return refuse('unresolved')
  const spelled = input.split('/')
  const found = await deepest(rootReal, spelled)
  if (found === null) return refuse('unresolved')
  // A link or a junction out of the luoshu
  if (!within(rootReal, found.real)) return refuse('outside')
  const names = [
    ...(found.real === rootReal ? [] : found.real.slice(withSep(rootReal).length).split(path.sep)),
    ...found.rest,
  ]
  // A link to the luoshu itself, where no note lives
  if (names.length === 0) return refuse('root')
  if (names.some(isGitName)) return refuse('git')
  // A dot name as the caller spelled it, so a link named .x refuses as .x would, by the rule of the name it leads to
  // when that is a dot name too
  if (names.some(isDotName) || spelled.some(isDotName)) return refuse(found.hidden ?? 'dot')

  const absolute = path.join(found.real, ...found.rest)
  for (const [rule, folder] of [['data', options.dataDir], ['install', options.installDir]] as const) {
    if (folder === undefined) continue
    // A folder that can't be resolved refuses every path, since nothing then shows a path is outside that folder
    const real = await realpath(folder).catch(() => null)
    if (real === null || within(real, absolute)) return refuse(rule)
  }
  const relative = names.join('/')
  const answer: Canonical = { ok: true, absolute, relative, key: keyOf(relative) }
  if (found.hidden === null) return answer
  // The OS would read the caller's spelling of the first name that leads to a dot name as that name again, so a name
  // made up here and no file has takes its place on the disk
  const nowhere = path.join(found.real, `.${randomBytes(16).toString('hex')}`, ...found.rest.slice(1))
  return { ...refuse(found.hidden), absent: { ...answer, absolute: nowhere } }
}
