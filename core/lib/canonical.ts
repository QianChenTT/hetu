import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

// A string that breaks a rule answers invalid and a refusal from the disk answers not-granted, so a caller can't tell
// a link out of the vault from a missing grant. rule names the check for ctx.debug and the tests, never for a reply.
// Not named Refused, the name the SDK gives its error, which carries no rule
export type StringRule =
  | 'type' | 'empty' | 'too-long' | 'ill-formed' | 'absolute' | 'backslash' | 'colon' | 'control'
  | 'empty-segment' | 'dot-segment' | 'trailing' | 'device'
export type DiskRule = 'unresolved' | 'outside' | 'root' | 'git' | 'data' | 'install'
export type NotCanonical =
  | { ok: false, code: 'invalid', rule: StringRule }
  | { ok: false, code: 'not-granted', rule: DiskRule }

// absolute is for the disk. relative joins the names with / on every platform and is what the gate, the guards and
// the records see. key is only for the vault's per-path lock and the lease table's conflict check
export type Canonical = { ok: true, absolute: string, relative: string, key: string }

// hetu's own folders, which a vault picked at the home folder holds
export type CanonicalOptions = { dataDir?: string, installDir?: string }

const MAX_LENGTH = 512

// ASCII letters only. JS case folding joins names NTFS keeps apart, such as the Kelvin sign and k
const fold = (text: string) => text.replace(/[A-Z]/g, letter => letter.toLowerCase())

// Win32 opens a device for these names in any folder, with any extension and with spaces before the dot. The
// superscript digits count as digits there. CONIN$ and CONOUT$ come from CPython's isreserved, COM0 and LPT0 from the
// plugin id rule in state.ts. Refused on every platform, since a vault moves between machines
const devices = new Set([
  'con', 'prn', 'aux', 'nul', 'conin$', 'conout$',
  ...[...'0123456789\u00b9\u00b2\u00b3'].flatMap(digit => [`com${digit}`, `lpt${digit}`]),
])

// HFS+ skips these code points when comparing names, so .g\u200cit opens .git there or becomes .git in a folder that
// has none. git's protectHFS skips the same set
const ignorable = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g
const isGit = (name: string) => fold(name.replace(ignorable, '')) === '.git'

// For locks and leases only. A name that doesn't exist yet keeps the caller's spelling, so two spellings of one new
// note meet only here. Drops what HFS+ skips, takes NFC since APFS reads both forms as one name and folds case
// further than lowercase, which keeps the sharp s, the long s and the micro sign apart from the ss, s and mu APFS
// reads them as. Folding more than a volume does only makes two notes share a lock or block each other's lease. The
// same fold in matching would widen a grant
const keyOf = (relative: string) =>
  relative.replace(ignorable, '').normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')

// Before the disk is touched. Each rule closes a spelling the OS or the path joiner reads as another name
function stringRule(input: string): StringRule | null {
  if (typeof input !== 'string') return 'type'
  if (input === '') return 'empty'
  if (input.length > MAX_LENGTH) return 'too-long'
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

// The real path of the deepest part that exists and the names under that part, which don't exist yet. null when
// something on the way exists and can't be resolved: a link to nowhere, a loop, a folder that can't be read
async function deepest(base: string, names: string[]): Promise<{ real: string, rest: string[] } | null> {
  for (let i = names.length; i >= 0; i--) {
    const candidate = path.join(base, ...names.slice(0, i))
    try {
      return { real: await realpath(candidate), rest: names.slice(i) }
    } catch (err) {
      if (!absent(err)) return null
    }
    // realpath answers alike for a missing name and for a link to a missing target. A write through that link would
    // create the target wherever the link points, so only a name lstat can't find either counts as not there yet
    try {
      await lstat(candidate)
      return null
    } catch (err) {
      if (!absent(err)) return null
    }
  }
  return null
}

const withSep = (folder: string) => folder.endsWith(path.sep) ? folder : folder + path.sep

// Exact on purpose: both sides come from the OS, so another spelling is another folder or a refusal, never a match
const within = (folder: string, target: string) => target === folder || target.startsWith(withSep(folder))

// For a provider's prepare step. The string rules run first. Then the OS resolves the deepest part that exists, with
// links, junctions and 8.3 short names. The names that don't exist yet are kept for a write. The promise form of
// realpath is realpath.native. Resolves once and keeps nothing open: the caller acts on exactly the path returned and
// the provider holds the per-path lock on key from prepare to perform. The spellings of one name give one key, so no
// other hetu write to that name runs in between. On Windows a name not there yet that reads like an 8.3 short name,
// such as NEWFOL~1, is the exception: a write under another key that creates New folder name can give that folder
// the same short name
export async function canonical(root: string, input: string, options: CanonicalOptions = {}): Promise<Canonical | NotCanonical> {
  const broken = stringRule(input)
  if (broken !== null) return { ok: false, code: 'invalid', rule: broken }
  const refuse = (rule: DiskRule): NotCanonical => ({ ok: false, code: 'not-granted', rule })

  const rootReal = await realpath(root).catch(() => null)
  if (rootReal === null) return refuse('unresolved')
  const found = await deepest(rootReal, input.split('/'))
  if (found === null) return refuse('unresolved')
  // A link or a junction out of the vault
  if (!within(rootReal, found.real)) return refuse('outside')
  const names = [
    ...(found.real === rootReal ? [] : found.real.slice(withSep(rootReal).length).split(path.sep)),
    ...found.rest,
  ]
  // A link to the vault itself, where no note lives
  if (names.length === 0) return refuse('root')
  if (names.some(isGit)) return refuse('git')

  const absolute = path.join(found.real, ...found.rest)
  for (const [rule, folder] of [['data', options.dataDir], ['install', options.installDir]] as const) {
    if (folder === undefined) continue
    // A folder that can't be resolved refuses every path, since nothing then shows a path is outside that folder
    const real = await realpath(folder).catch(() => null)
    if (real === null || within(real, absolute)) return refuse(rule)
  }
  const relative = names.join('/')
  return { ok: true, absolute, relative, key: keyOf(relative) }
}
