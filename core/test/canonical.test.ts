import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, type TestContext } from 'vitest'
import { canonical, type CanonicalOptions, type DiskRule, type NotCanonical, type StringRule } from '../lib/canonical.ts'
import { onWindows } from './hold.ts'

const run = promisify(execFile)

// A luoshu and a folder beside the luoshu, where every link out points
let base: string
let luoshu: string
let outside: string

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'hetu-canonical-'))
  luoshu = path.join(base, 'luoshu')
  outside = path.join(base, 'outside')
  await mkdir(path.join(luoshu, 'notes'), { recursive: true })
  await mkdir(path.join(luoshu, '.git'))
  await mkdir(outside)
  await writeFile(path.join(luoshu, 'notes', 'a.md'), 'note a')
  await writeFile(path.join(luoshu, '.git', 'config'), '[core]\n')
  await writeFile(path.join(outside, 'secret.md'), 'secret')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

// The answer for a path that resolves to these names inside the luoshu. The key has tests of its own
async function resolved(relative: string) {
  return { ok: true, absolute: path.join(await realpath(luoshu), ...relative.split('/')), relative, key: expect.any(String) }
}
const invalid = (rule: StringRule): NotCanonical => ({ ok: false, code: 'invalid', rule })
const notGranted = (rule: DiskRule): NotCanonical => ({ ok: false, code: 'not-granted', rule })

// A junction on Windows, which needs no admin rights. Elsewhere the type is ignored for a plain link
const linkFolder = (target: string, name: string) => symlink(target, path.join(luoshu, name), 'junction')

// A file link on Windows needs admin rights or developer mode, so the test skips on a Windows without either
async function linkFile(target: string, name: string, skip: TestContext['skip']) {
  try {
    await symlink(target, path.join(luoshu, name), 'file')
  } catch (err) {
    if (onWindows && (err as NodeJS.ErrnoException).code === 'EPERM') skip('file links need admin rights or developer mode')
    throw err
  }
}

// macOS and Windows ignore case by default, Linux doesn't
const ignoresCase = () => stat(path.join(luoshu, 'NOTES', 'A.MD')).then(() => true, () => false)

describe('the string rules', () => {
  // A luoshu that isn't there, so any look at the disk would answer not-granted instead
  const nowhere = () => path.join(base, 'no-luoshu')

  const refused: [string, StringRule][] = [
    ['', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['/notes/a.md', 'absolute'],
    ['//server/share/a.md', 'absolute'],
    ['C:/Windows/win.ini', 'absolute'],
    ['c:notes/a.md', 'absolute'],
    ['C:', 'absolute'],
    ['\\\\server\\share\\a.md', 'backslash'],
    ['\\\\?\\C:\\Windows\\win.ini', 'backslash'],
    ['notes\\a.md', 'backslash'],
    ['notes/a.md::$DATA', 'colon'],
    ['.git::$INDEX_ALLOCATION/config', 'colon'],
    ['notes/a.md:hidden', 'colon'],
    ['notes:x/a.md', 'colon'],
    ['1:/a.md', 'colon'],
    ['notes/a\u0000.md', 'control'],
    ['notes/a\n.md', 'control'],
    ['notes/\u001b[31m.md', 'control'],
    ['notes//a.md', 'empty-segment'],
    ['notes/', 'empty-segment'],
    ['notes/a.md.', 'trailing'],
    ['notes/a.md ', 'trailing'],
    ['notes./a.md', 'trailing'],
    ['notes /a.md', 'trailing'],
    ['.git./config', 'trailing'],
    ['.git . ./config', 'trailing'],
    ['...', 'trailing'],
    ['CON', 'device'],
    ['con.md', 'device'],
    ['notes/NUL', 'device'],
    ['notes/nul.txt', 'device'],
    ['Aux.tar.gz', 'device'],
    ['prn', 'device'],
    ['COM1.md', 'device'],
    ['com0', 'device'],
    ['lpt9.md', 'device'],
    ['COM\u00b9.md', 'device'],
    ['lpt\u00b3', 'device'],
    ['CON .md', 'device'],
    ['CON  .md', 'device'],
    ['conin$', 'device'],
    ['CONOUT$.md', 'device'],
    ['con/a.md', 'device'],
    ['notes/a\ud800.md', 'ill-formed'],
    ['\udc00', 'ill-formed'],
  ]
  it.each(refused)('refuses %j as %s before looking at the disk', async (input, rule) => {
    expect(await canonical(nowhere(), input)).toEqual(invalid(rule))
  })

  it('refuses every COM and LPT digit as device, the superscripts too', async () => {
    for (const digit of '0123456789\u00b9\u00b2\u00b3') {
      for (const name of [`com${digit}`, `LPT${digit}.md`]) {
        expect(await canonical(nowhere(), name), name).toEqual(invalid('device'))
      }
    }
  })

  // JSON keeps DEL and the C1 controls unescaped in a test name, hence a test of their own
  it('refuses DEL and the C1 controls as control', async () => {
    for (const input of ['notes/a\u007f.md', 'notes/a\u0085.md', 'notes/a\u009f.md']) {
      expect(await canonical(nowhere(), input)).toEqual(invalid('control'))
    }
  })

  it('refuses a path that is not a string', async () => {
    for (const input of [42, null, undefined, ['notes', 'a.md'], { length: 1 }]) {
      expect(await canonical(nowhere(), input as unknown as string)).toEqual(invalid('type'))
    }
  })

  it('takes 512 characters and refuses 513', async () => {
    const longest = [...Array.from({ length: 7 }, () => 'n'.repeat(63)), 'n'.repeat(64)].join('/')
    expect(longest).toHaveLength(512)
    expect(await canonical(luoshu, longest)).not.toMatchObject({ code: 'invalid' })
    expect(await canonical(nowhere(), `${longest}n`)).toEqual(invalid('too-long'))
  })

  const allowed = [
    'notes/a.md',
    'notes/new.md',
    'notes/a..b.md',
    'notes/ leading space.md',
    'console.md',
    'com10.md',
    'lpt.md',
    'nul-notes.md',
    'auxiliary/x.md',
    'COM\u2074.md',
    'notes/caf\u00e9.md',
    'notes/\ud83d\ude00.md',
  ]
  it.each(allowed)('lets %j through, close to a refused name but not one', async input => {
    expect(await canonical(luoshu, input)).toEqual(await resolved(input))
  })
})

describe('.. tricks', () => {
  it.each<[string, StringRule]>([
    ['..', 'dot-segment'],
    ['.', 'dot-segment'],
    ['../outside/secret.md', 'dot-segment'],
    ['notes/../../outside/secret.md', 'dot-segment'],
    ['notes/..', 'dot-segment'],
    ['./notes/a.md', 'dot-segment'],
    ['notes/./a.md', 'dot-segment'],
    ['..\\outside\\secret.md', 'backslash'],
    ['notes/..\\..\\outside', 'backslash'],
    ['.. /outside/secret.md', 'trailing'],
    ['../', 'dot-segment'],
  ])('refuses %j as %s', async (input, rule) => {
    expect(await canonical(luoshu, input)).toEqual(invalid(rule))
  })

  it.each(['%2e%2e/secret.md', 'notes/%2e%2e%2foutside'])('keeps %j as one name inside the luoshu', async input => {
    expect(await canonical(luoshu, input)).toEqual(await resolved(input))
  })

  it.each(['..notes/x.md', '..%2f..%2foutside/secret.md'])('refuses %j as one dot name inside the luoshu', async input => {
    expect(await canonical(luoshu, input)).toEqual(notGranted('dot'))
  })

  it('refuses a relative link that climbs out and resolves one that climbs back in', async () => {
    await linkFolder('..', 'up')
    expect(await canonical(luoshu, 'up/outside/secret.md')).toEqual(notGranted('outside'))
    expect(await canonical(luoshu, 'up/outside/new.md')).toEqual(notGranted('outside'))
    expect(await canonical(luoshu, 'up/luoshu/notes/a.md')).toEqual(await resolved('notes/a.md'))
  })
})

describe('resolving on the disk', () => {
  it('gives the real path of a note that exists', async () => {
    expect(await canonical(luoshu, 'notes/a.md')).toEqual(await resolved('notes/a.md'))
  })

  it('keeps the names that do not exist yet for a write', async () => {
    expect(await canonical(luoshu, 'notes/new.md')).toEqual(await resolved('notes/new.md'))
    expect(await canonical(luoshu, 'notes/new/deeper/x.md')).toEqual(await resolved('notes/new/deeper/x.md'))
    expect(await canonical(luoshu, 'fresh/x.md')).toEqual(await resolved('fresh/x.md'))
  })

  it('reads names below a file as not there yet, so perform finds nothing', async () => {
    expect(await canonical(luoshu, 'notes/a.md/x.md')).toEqual(await resolved('notes/a.md/x.md'))
  })

  it('resolves a luoshu folder that is itself a link, every path comes out under the real one', async () => {
    const through = path.join(base, 'through')
    await symlink(luoshu, through, 'junction')
    expect(await canonical(through, 'notes/a.md')).toEqual(await resolved('notes/a.md'))
    expect(await canonical(through, 'notes/new.md')).toEqual(await resolved('notes/new.md'))
  })

  // A volume root's real path ends in a separator: / on macOS and Linux, the drive root on Windows
  it('resolves a note when the luoshu is the root of a volume', async () => {
    const real = path.join(await realpath(luoshu), 'notes', 'a.md')
    const { root } = path.parse(real)
    const relative = real.slice(root.length).split(path.sep).join('/')
    expect(await canonical(root, relative)).toEqual({ ok: true, absolute: real, relative, key: expect.any(String) })
  })

  it('refuses every path when the luoshu folder is gone', async () => {
    expect(await canonical(path.join(base, 'gone'), 'notes/a.md')).toEqual(notGranted('unresolved'))
  })

  // chmod sets no folder ACL on Windows and root reads every folder anyway
  it.skipIf(onWindows)('refuses a path through a folder that can not be read', async ({ skip }) => {
    if (process.getuid?.() === 0) skip('root reads every folder')
    const locked = path.join(luoshu, 'locked')
    await mkdir(locked)
    await writeFile(path.join(locked, 'x.md'), 'x')
    await chmod(locked, 0o000)
    try {
      expect(await canonical(luoshu, 'locked/x.md')).toEqual(notGranted('unresolved'))
      expect(await canonical(luoshu, 'locked/new.md')).toEqual(notGranted('unresolved'))
    } finally {
      await chmod(locked, 0o755)
    }
  })

  it('gives the names as the disk holds them on a volume that ignores case', async ({ skip }) => {
    if (!await ignoresCase()) skip('this volume keeps case apart')
    expect(await canonical(luoshu, 'NOTES/A.MD')).toEqual(await resolved('notes/a.md'))
    // A name that doesn't exist yet keeps the caller's spelling
    expect(await canonical(luoshu, 'Notes/New.md')).toEqual(await resolved('notes/New.md'))
  })
})

describe('the key for locks and leases', () => {
  async function keyFor(input: string) {
    const answer = await canonical(luoshu, input)
    if (!answer.ok) throw new Error(`${input} refused as ${answer.rule}`)
    return answer.key
  }

  // A name that doesn't exist yet keeps the caller's spelling, so two writers creating one note through two spellings
  // would take two locks. Each pair is one file on APFS or HFS+, whatever the volume running these tests does.
  // Lowercase alone keeps the long s, the sharp s and the micro sign apart
  it.each([
    ['case', 'notes/New.md', 'notes/NEW.md', 'notes/new.md'],
    ['case, for a note that exists', 'NOTES/A.MD', 'notes/a.md', 'notes/a.md'],
    ['a long s', 'notes/te\u017ft.md', 'notes/test.md', 'notes/test.md'],
    ['a sharp s', 'notes/stra\u00dfe.md', 'notes/STRASSE.md', 'notes/strasse.md'],
    ['the micro sign', 'notes/\u00b5.md', 'notes/\u03bc.md', 'notes/\u03bc.md'],
    ['NFC and NFD', 'notes/caf\u00e9.md', 'notes/cafe\u0301.md', 'notes/caf\u00e9.md'],
    ['a code point HFS+ skips', 'notes/a\u200db.md', 'notes/ab.md', 'notes/ab.md'],
    ['two of those', 'notes/a\u200cb\ufeff.md', 'notes/ab.md', 'notes/ab.md'],
  ])('gives one key to two spellings that differ by %s', async (_, first, second, key) => {
    expect(await keyFor(first)).toBe(key)
    expect(await keyFor(second)).toBe(key)
  })

  it('leaves relative in the caller\'s spelling, the key is for locks and leases only', async () => {
    expect(await canonical(luoshu, 'notes/New.md')).toMatchObject({ relative: 'notes/New.md', key: 'notes/new.md' })
  })
})

describe('links', () => {
  it('refuses a folder link out of the luoshu, for a note there, a new one and the link itself', async () => {
    await linkFolder(outside, 'out')
    expect(await canonical(luoshu, 'out/secret.md')).toEqual(notGranted('outside'))
    expect(await canonical(luoshu, 'out/new.md')).toEqual(notGranted('outside'))
    expect(await canonical(luoshu, 'out/new/deeper.md')).toEqual(notGranted('outside'))
    expect(await canonical(luoshu, 'out')).toEqual(notGranted('outside'))
  })

  it('refuses a file link out of the luoshu', async ({ skip }) => {
    await linkFile(path.join(outside, 'secret.md'), 'secret.md', skip)
    expect(await canonical(luoshu, 'secret.md')).toEqual(notGranted('outside'))
  })

  // A folder whose name starts with the luoshu's is still outside the luoshu
  it('refuses a link into a folder beside the luoshu whose name starts with the luoshu\'s', async () => {
    await mkdir(path.join(base, 'luoshu-copy'))
    await linkFolder(path.join(base, 'luoshu-copy'), 'copy')
    expect(await canonical(luoshu, 'copy/a.md')).toEqual(notGranted('outside'))
  })

  // On a volume that keeps case apart LUOSHU is another folder, which a folded comparison would read as the luoshu
  it('refuses a link to a folder named like the luoshu in another case, on a volume that keeps case apart', async ({ skip }) => {
    if (await ignoresCase()) skip('this volume ignores case')
    await mkdir(path.join(base, 'LUOSHU'))
    await writeFile(path.join(base, 'LUOSHU', 'secret.md'), 'secret')
    await linkFolder(path.join(base, 'LUOSHU'), 'upper')
    expect(await canonical(luoshu, 'upper/secret.md')).toEqual(notGranted('outside'))
  })

  it('follows a chain of links to where it ends', async () => {
    await linkFolder(outside, 'second')
    await linkFolder(path.join(luoshu, 'second'), 'first')
    expect(await canonical(luoshu, 'first/secret.md')).toEqual(notGranted('outside'))
  })

  it('gives where a link inside the luoshu points, the object the gate then judges', async () => {
    await linkFolder(path.join(luoshu, 'notes'), 'alias')
    expect(await canonical(luoshu, 'alias/a.md')).toEqual(await resolved('notes/a.md'))
    expect(await canonical(luoshu, 'alias/new.md')).toEqual(await resolved('notes/new.md'))
  })

  it('refuses a link to the luoshu itself but resolves the paths below it', async () => {
    await linkFolder(luoshu, 'self')
    expect(await canonical(luoshu, 'self')).toEqual(notGranted('root'))
    expect(await canonical(luoshu, 'self/notes/a.md')).toEqual(await resolved('notes/a.md'))
  })

  // The old daemon skipped the real path check when realpath failed, so a write followed this link out
  it('refuses a file link to nowhere, a write through it would create its target outside', async ({ skip }) => {
    await linkFile(path.join(outside, 'planted.md'), 'ghost.md', skip)
    expect(await canonical(luoshu, 'ghost.md')).toEqual(notGranted('unresolved'))
  })

  it('refuses a path through a folder link to nowhere', async () => {
    await linkFolder(path.join(outside, 'none'), 'ghost')
    expect(await canonical(luoshu, 'ghost/new.md')).toEqual(notGranted('unresolved'))
  })

  it('refuses a link loop', async () => {
    await linkFolder(path.join(luoshu, 'loop'), 'loop')
    expect(await canonical(luoshu, 'loop/x.md')).toEqual(notGranted('unresolved'))
  })
})

describe('.git', () => {
  it.each(['.git', '.git/config', '.git/hooks/pre-commit', 'notes/.git/config', 'notes/sub/.git'])('refuses %j', async input => {
    expect(await canonical(luoshu, input)).toEqual(notGranted('git'))
  })

  it.each(['.GIT/config', '.Git/config', '.gIT/hooks/new', 'notes/.GiT/config'])('refuses %j, case folded', async input => {
    expect(await canonical(luoshu, input)).toEqual(notGranted('git'))
  })

  it('refuses .GIT on a volume that ignores case, where it opens the real .git', async ({ skip }) => {
    if (!await ignoresCase()) skip('this volume keeps case apart')
    expect(await readFile(path.join(luoshu, '.GIT', 'config'), 'utf8')).toBe('[core]\n')
    expect(await canonical(luoshu, '.GIT/config')).toEqual(notGranted('git'))
  })

  it('refuses a link inside the luoshu that points at .git', async () => {
    await linkFolder(path.join(luoshu, '.git'), 'repo')
    expect(await canonical(luoshu, 'repo')).toEqual(notGranted('git'))
    expect(await canonical(luoshu, 'repo/config')).toEqual(notGranted('git'))
    expect(await canonical(luoshu, 'repo/hooks/post-checkout')).toEqual(notGranted('git'))
  })

  it.each([
    ['a zero width non-joiner', '.g\u200cit/config'],
    ['a zero width no-break space', 'notes/.git\ufeff/config'],
    ['a zero width joiner', '.G\u200dIT/hooks/new'],
    ['a right-to-left override', '.gi\u202et'],
    ['two zero width joiners', 'notes/.g\u200di\u200dt/config'],
  ])('refuses .git with %s in it, which HFS+ reads as .git', async (_, input) => {
    expect(await canonical(luoshu, input)).toEqual(notGranted('git'))
  })

  // Each code point git's protectHFS skips, in a folder with no .git for HFS+ to open, so a range cut short shows
  it('refuses .git with any one of the code points HFS+ skips in it', async () => {
    const skipped = [
      0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfeff,
    ]
    for (const code of skipped) {
      const input = `notes/.g${String.fromCharCode(code)}it/config`
      expect(await canonical(luoshu, input), `U+${code.toString(16)}`).toEqual(notGranted('git'))
    }
  })

  it.each(['notes.git', 'git/config', 'notes/git'])('lets %j through, not .git', async input => {
    expect(await canonical(luoshu, input)).toEqual(await resolved(input))
  })

  // JS uppercases a dotless i to I but APFS opens no .git for that spelling. An NTFS that did would resolve to .git
  // and answer git on Windows
  it.each(['.gitignore', '.github/x.md', '.g\u0131t/config'])('refuses %j as a dot name, not as .git', async input => {
    expect(await canonical(luoshu, input)).toEqual(notGranted('dot'))
  })
})

describe('dot names', () => {
  beforeEach(async () => {
    await mkdir(path.join(luoshu, '.obsidian', 'plugins', 'x'), { recursive: true })
    await writeFile(path.join(luoshu, '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
  })

  it.each([
    ['a plugin Obsidian runs', '.obsidian/plugins/x/main.js'],
    ['a new plugin there', '.obsidian/plugins/y/main.js'],
    ['the folder itself', '.obsidian'],
    ['a workflow GitHub runs', '.github/workflows/x.yml'],
    ['a dot folder deep in a path', 'notes/sub/deeper/.config/x.md'],
    ['a dot folder second', 'notes/.trash/a.md'],
    ['a dot file', 'notes/.hidden.md'],
    ['a dot file at the top', '.gitignore'],
    ['a dot name read like a device', '.con'],
    ['a name of only dots and more', '..x/a.md'],
    ['another case', '.OBSIDIAN/plugins/x/main.js'],
    ['another case of a new name', '.GitHub/workflows/x.yml'],
  ])('refuses %s: %j', async (_, input) => {
    expect(await canonical(luoshu, input)).toEqual(notGranted('dot'))
  })

  // HFS+ skips these when it compares names, so each spelling opens .obsidian there
  it('refuses a dot after any one of the code points HFS+ skips', async () => {
    const skipped = [
      0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfeff,
    ]
    for (const code of skipped) {
      const mark = String.fromCharCode(code)
      expect(await canonical(luoshu, `${mark}.obsidian/plugins/x/main.js`), `U+${code.toString(16)}`).toEqual(notGranted('dot'))
      expect(await canonical(luoshu, `notes/${mark}${mark}.config/x.md`), `U+${code.toString(16)} twice`).toEqual(notGranted('dot'))
    }
  })

  it('refuses a folder link into a dot folder, for a file there, a new one and the link itself', async () => {
    await linkFolder(path.join(luoshu, '.obsidian'), 'cfg')
    expect(await readFile(path.join(luoshu, 'cfg', 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
    expect(await canonical(luoshu, 'cfg/plugins/x/main.js')).toEqual(notGranted('dot'))
    expect(await canonical(luoshu, 'cfg/plugins/y/main.js')).toEqual(notGranted('dot'))
    expect(await canonical(luoshu, 'cfg')).toEqual(notGranted('dot'))
  })

  it('refuses a link into a folder inside a dot folder and a chain of links ending in one', async () => {
    await linkFolder(path.join(luoshu, '.obsidian', 'plugins'), 'plugins')
    await linkFolder(path.join(luoshu, 'plugins'), 'first')
    expect(await canonical(luoshu, 'plugins/x/main.js')).toEqual(notGranted('dot'))
    expect(await canonical(luoshu, 'first/x/main.js')).toEqual(notGranted('dot'))
  })

  it('refuses a file link to a file in a dot folder', async ({ skip }) => {
    await linkFile(path.join(luoshu, '.obsidian', 'plugins', 'x', 'main.js'), 'main.js', skip)
    expect(await canonical(luoshu, 'main.js')).toEqual(notGranted('dot'))
  })

  // The caller's spelling counts as well as where it leads
  it('refuses a dot named link that leads to a plain folder', async () => {
    await linkFolder(path.join(luoshu, 'notes'), '.alias')
    expect(await canonical(luoshu, '.alias/a.md')).toEqual(notGranted('dot'))
  })

  it('serves the notes of a luoshu that itself sits in a dot folder', async () => {
    const inside = path.join(base, '.vault')
    await mkdir(path.join(inside, 'notes'), { recursive: true })
    await writeFile(path.join(inside, 'notes', 'a.md'), 'a')
    expect(await canonical(inside, 'notes/a.md')).toEqual({
      ok: true, absolute: path.join(await realpath(inside), 'notes', 'a.md'), relative: 'notes/a.md', key: 'notes/a.md',
    })
  })

  // Each is shown to name another file than the one in .obsidian, so letting it through reaches no dot folder
  it.each([
    ['a fullwidth full stop', '\uff0eobsidian'],
    ['a one dot leader', '\u2024obsidian'],
    ['a small full stop', '\ufe52obsidian'],
    ['an ideographic full stop', '\u3002obsidian'],
    ['a space before the dot', ' .obsidian'],
  ])('lets a look-alike through as its own name: %s', async (_, folder) => {
    await expect(readFile(path.join(luoshu, folder, 'plugins', 'x', 'main.js'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await canonical(luoshu, `${folder}/plugins/x/main.js`)).toEqual(await resolved(`${folder}/plugins/x/main.js`))
  })

  // On every platform these are characters of one name, so the dot after them starts no segment
  it.each(['notes\u2215.obsidian/x.md', 'notes\uff0f.obsidian/x.md', 'notes\u29f8.obsidian/x.md', 'notes\uff3c.obsidian/x.md'])(
    'reads %j as two names, the first holding a slash look-alike',
    async input => {
      const answer = await canonical(luoshu, input)
      expect(answer).toEqual(await resolved(input))
      expect((answer as { relative: string }).relative.split('/')).toHaveLength(2)
    },
  )

  // The string rules answer first, so these never reach the disk
  it.each<[string, StringRule]>([
    ['.obsidian./plugins/x/main.js', 'trailing'],
    ['.obsidian /plugins/x/main.js', 'trailing'],
    ['.obsidian::$INDEX_ALLOCATION/plugins/x/main.js', 'colon'],
    ['.obsidian:stream', 'colon'],
    ['.obsidian\\plugins\\x\\main.js', 'backslash'],
    ['notes/..\\.obsidian/x.md', 'backslash'],
    ['/.obsidian/plugins/x/main.js', 'absolute'],
    ['C:/.obsidian/plugins/x/main.js', 'absolute'],
    ['c:.obsidian/plugins/x/main.js', 'absolute'],
    ['notes//.obsidian/x.md', 'empty-segment'],
    ['./.obsidian/x.md', 'dot-segment'],
    ['notes/../.obsidian/x.md', 'dot-segment'],
  ])('refuses %j as %s first', async (input, rule) => {
    expect(await canonical(luoshu, input)).toEqual(invalid(rule))
  })
})

describe('hetu\'s own folders in the luoshu', () => {
  beforeEach(async () => {
    await mkdir(path.join(luoshu, 'data', 'state'), { recursive: true })
    await writeFile(path.join(luoshu, 'data', 'state', 'switches.json'), '{}')
    await mkdir(path.join(luoshu, 'app'))
    await writeFile(path.join(luoshu, 'app', 'main.js'), '')
  })
  const folders = (): CanonicalOptions => ({ dataDir: path.join(luoshu, 'data'), installDir: path.join(luoshu, 'app') })

  it.each<[string, DiskRule]>([
    ['data', 'data'],
    ['data/state/switches.json', 'data'],
    ['data/state/new.json', 'data'],
    ['app', 'install'],
    ['app/main.js', 'install'],
    ['app/new/x.js', 'install'],
  ])('refuses %j as inside the %s folder', async (input, rule) => {
    expect(await canonical(luoshu, input, folders())).toEqual(notGranted(rule))
  })

  it.each(['database.md', 'data-notes/x.md', 'app.md', 'apps/x.js', 'notes/a.md'])('lets %j beside those folders through', async input => {
    expect(await canonical(luoshu, input, folders())).toEqual(await resolved(input))
  })

  it('refuses a link inside the luoshu into the data folder', async () => {
    await linkFolder(path.join(luoshu, 'data'), 'd')
    expect(await canonical(luoshu, 'd/state/switches.json', folders())).toEqual(notGranted('data'))
  })

  it('finds the folders when they are given through a link', async () => {
    const through = path.join(base, 'through')
    await symlink(luoshu, through, 'junction')
    const options = { dataDir: path.join(through, 'data'), installDir: path.join(through, 'app') }
    expect(await canonical(luoshu, 'data/state/switches.json', options)).toEqual(notGranted('data'))
    expect(await canonical(luoshu, 'app/main.js', options)).toEqual(notGranted('install'))
  })

  it('refuses another case of the data folder on a volume that ignores case', async ({ skip }) => {
    if (!await ignoresCase()) skip('this volume keeps case apart')
    expect(await canonical(luoshu, 'DATA/state/switches.json', folders())).toEqual(notGranted('data'))
  })

  it('refuses every path when a folder passed in can not be resolved', async () => {
    const gone = path.join(base, 'gone')
    expect(await canonical(luoshu, 'notes/a.md', { dataDir: gone })).toEqual(notGranted('data'))
    expect(await canonical(luoshu, 'notes/a.md', { installDir: gone })).toEqual(notGranted('install'))
    expect(await canonical(luoshu, 'notes/a.md', { dataDir: '' })).toEqual(notGranted('data'))
  })

  it('lets those paths through when the caller passes no folders', async () => {
    expect(await canonical(luoshu, 'data/state/switches.json')).toEqual(await resolved('data/state/switches.json'))
    expect(await canonical(luoshu, 'app/main.js')).toEqual(await resolved('app/main.js'))
  })
})

// Each shows the OS reaching the file through the other name first, so a pass means the name was refused, not missing
describe.runIf(onWindows)('other Windows names for the same file', () => {
  // The 8.3 short name Windows made for a name in a folder, as dir /x shows it. null when the volume makes none
  async function shortName(folder: string, name: string): Promise<string | null> {
    const { stdout } = await run('cmd.exe', ['/d', '/c', 'dir', '/x', '/a'], { cwd: folder })
    for (const line of stdout.split(/\r?\n/).map(l => l.trimEnd())) {
      if (!line.endsWith(` ${name}`)) continue
      const short = line.slice(0, -name.length).trimEnd().split(/\s+/).at(-1)
      if (short?.includes('~')) return short
    }
    return null
  }

  it('expands an 8.3 short name and refuses the one for .git', async ({ skip }) => {
    await mkdir(path.join(luoshu, 'Long folder name'))
    const git = await shortName(luoshu, '.git')
    const long = await shortName(luoshu, 'Long folder name')
    if (git === null || long === null) {
      // A volume can have short names off, which on CI would leave GIT~1 unproven behind a green run
      if (process.env.CI) throw new Error('no 8.3 short names on this CI volume, GIT~1 unproven')
      return skip('this volume makes no 8.3 short names')
    }
    expect(await readFile(path.join(luoshu, git, 'config'), 'utf8')).toBe('[core]\n')
    expect(await canonical(luoshu, `${git}/config`)).toEqual(notGranted('git'))
    expect(await canonical(luoshu, `${git}/hooks/new`)).toEqual(notGranted('git'))
    expect(await canonical(luoshu, `${long}/x.md`)).toEqual(await resolved('Long folder name/x.md'))
  })

  it('expands the 8.3 short name of a dot folder and refuses it', async ({ skip }) => {
    await mkdir(path.join(luoshu, '.obsidian', 'plugins', 'x'), { recursive: true })
    await writeFile(path.join(luoshu, '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
    const short = await shortName(luoshu, '.obsidian')
    if (short === null) {
      if (process.env.CI) throw new Error('no 8.3 short names on this CI volume, the dot folder\'s short name unproven')
      return skip('this volume makes no 8.3 short names')
    }
    expect(short.startsWith('.')).toBe(false)
    expect(await readFile(path.join(luoshu, short, 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
    expect(await canonical(luoshu, `${short}/plugins/x/main.js`)).toEqual(notGranted('dot'))
    expect(await canonical(luoshu, `${short}/plugins/y/main.js`)).toEqual(notGranted('dot'))
    expect(await canonical(luoshu, short)).toEqual(notGranted('dot'))
    // A dot folder deeper in the path, named by its short name
    await mkdir(path.join(luoshu, 'notes', '.config long'))
    await writeFile(path.join(luoshu, 'notes', '.config long', 'x.md'), 'x')
    const deeper = await shortName(path.join(luoshu, 'notes'), '.config long')
    expect(deeper).not.toBeNull()
    expect(await canonical(luoshu, `notes/${deeper}/x.md`)).toEqual(notGranted('dot'))
    expect(await canonical(luoshu, `notes/${deeper}/new.md`)).toEqual(notGranted('dot'))
  })

  it('refuses ::$INDEX_ALLOCATION, which opens .git as its folder stream', async () => {
    expect(await readFile(path.join(luoshu, '.git::$INDEX_ALLOCATION', 'config'), 'utf8')).toBe('[core]\n')
    expect(await canonical(luoshu, '.git::$INDEX_ALLOCATION/config')).toEqual(invalid('colon'))
  })

  it('refuses ::$DATA, which opens the note itself', async () => {
    expect(await readFile(path.join(luoshu, 'notes', 'a.md::$DATA'), 'utf8')).toBe('note a')
    expect(await canonical(luoshu, 'notes/a.md::$DATA')).toEqual(invalid('colon'))
  })

  it('refuses trailing dots and spaces, which Windows drops to open the name without them', async () => {
    const type = async (file: string) => (await run('cmd.exe', ['/d', '/c', 'type', file], { cwd: luoshu })).stdout
    expect(await type('notes\\a.md.')).toBe('note a')
    expect(await type('.git.\\config')).toBe('[core]\n')
    expect(await canonical(luoshu, 'notes/a.md.')).toEqual(invalid('trailing'))
    expect(await canonical(luoshu, 'notes/a.md ')).toEqual(invalid('trailing'))
    expect(await canonical(luoshu, '.git./config')).toEqual(invalid('trailing'))
  })
})
