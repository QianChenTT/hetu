import { describe, expect, it } from 'vitest'
import { MAX_SCOPE_LENGTH, pathProblem, scope, scopeMatches, scopeProblem } from '../api/scope.ts'

const fold = { foldCase: true }
const exact = { foldCase: false }
const matches = (grant: string, path: string, options = fold) => scopeMatches(grant, path, options)

describe('the scope grammar', () => {
  it.each([
    '**', 'notes/**', '04 - Daily/*.md', 'notes/a.md', '*', '*/*.md', '.obsidian/app.json', '.*', 'a*b*c', 'notes/**/x.md',
    '**/**', 'caf\u00e9.md', '\u65e5\u8a18/**', ' leading space', "it's ~ + = , ; @ $ % ^ & ' `", 'x'.repeat(MAX_SCOPE_LENGTH),
  ])('takes %j', grant => {
    expect(scopeProblem(grant)).toBeNull()
    expect(scope.safeParse(grant).success).toBe(true)
  })

  // Every character the #66 brief refuses, whole, at the start of a segment and inside one
  it.each(['\\', ':', '?', '[', ']', '{', '}', '(', ')', '!', '#'])('refuses %j anywhere in a scope', char => {
    for (const grant of [char, `notes/${char}`, `notes/a${char}b.md`, `${char}notes/**`]) {
      expect(scopeProblem(grant)).toBe('a character outside the grammar')
      expect(scope.safeParse(grant).success).toBe(false)
    }
  })

  it.each([0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f])('refuses the control character U+%s', code => {
    expect(scopeProblem(`notes/a${String.fromCharCode(code)}b.md`)).toBe('a character outside the grammar')
  })

  // A scope shows on the approval screen, where an override or an isolate shows the rest of it in another order
  it.each(['202a', '202b', '202c', '202d', '202e', '2066', '2067', '2068', '2069'])('refuses the bidi control U+%s', code => {
    const grant = `notes/a${String.fromCharCode(parseInt(code, 16))}b/**`
    expect(scopeProblem(grant)).toBe('a character outside the grammar')
    expect(scope.safeParse(grant).success).toBe(false)
  })

  // Names in some scripts need them, so the screens show them instead (#74)
  it('takes the zero-width joiner and non-joiner', () => {
    expect(scopeProblem('notes/\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.md')).toBeNull()
    expect(scopeProblem('notes/\u{1F469}\u200d\u{1F4BB}/**')).toBeNull()
  })

  const refused: [string, string, string][] = [
    ['an empty scope', '', 'empty'],
    ['a leading /', '/notes/**', 'an empty, . or .. segment'],
    ['a lone /', '/', 'an empty, . or .. segment'],
    ['a drive', 'C:/notes/**', 'a character outside the grammar'],
    ['a drive relative path', 'C:notes', 'a character outside the grammar'],
    ['a UNC path', '//server/share/**', 'an empty, . or .. segment'],
    ['a trailing /', 'notes/', 'an empty, . or .. segment'],
    ['an empty segment', 'notes//a.md', 'an empty, . or .. segment'],
    ['a . segment', 'notes/./a.md', 'an empty, . or .. segment'],
    ['a leading . segment', './notes/**', 'an empty, . or .. segment'],
    ['a .. segment', 'notes/../secret/**', 'an empty, . or .. segment'],
    ['a scope that is only ..', '..', 'an empty, . or .. segment'],
    ['** after text in a segment', 'notes/a**', '** inside a segment'],
    ['** before text in a segment', 'notes/**.md', '** inside a segment'],
    ['three stars', '***', '** inside a segment'],
    ['** inside a middle segment', 'a/b**c/d', '** inside a segment'],
    ['a trailing dot', 'notes./**', 'a trailing dot or space'],
    ['a trailing dot on a file', 'notes/a.md.', 'a trailing dot or space'],
    ['a trailing space', 'notes /**', 'a trailing dot or space'],
    ['a trailing space on a file', 'notes/a.md ', 'a trailing dot or space'],
    ['NFD text', 'notes/cafe\u0301.md', 'not NFC'],
    ['the angstrom sign, which NFC turns into A with a ring', 'notes/\u212b.md', 'not NFC'],
    ['the Kelvin sign, which NFC turns into K', 'notes/\u212a.md', 'not NFC'],
    ['a lone surrogate', 'notes/\ud800.md', 'a lone surrogate'],
    ['one character over the cap', 'x'.repeat(MAX_SCOPE_LENGTH + 1), `longer than ${MAX_SCOPE_LENGTH} characters`],
    ['a long scope of short segments', 'a/'.repeat(300), `longer than ${MAX_SCOPE_LENGTH} characters`],
  ]

  it.each(refused)('refuses %s', (_name, grant, problem) => {
    expect(scopeProblem(grant)).toBe(problem)
    expect(scope.safeParse(grant).success).toBe(false)
  })

  it('refuses what is not a string', () => {
    expect(scopeProblem(5 as unknown as string)).toBe('empty')
    expect(scope.safeParse(5).success).toBe(false)
    expect(scope.safeParse(['**']).success).toBe(false)
  })

  it.each(refused)('matches nothing with %s', (_name, grant) => {
    expect(matches(grant, 'notes/a.md')).toBe(false)
    expect(matches(grant, 'secret/a.md')).toBe(false)
  })

  // Shapes other matchers took as syntax or folded away, from the #66 source check
  it.each([
    ['notes/../**', 'secret/x.md'],
    ['notes/../secret/**', 'secret/x.md'],
    ['notes/{a,b}.md', 'notes/a.md'],
    ['notes/[a]*', 'notes/a.md'],
    ['notes/a?.md', 'notes/ab.md'],
    ['!secret/**', 'notes/x.md'],
    ['#notes/**', 'notes/a.md'],
    ['notes\\*.md', 'notes/a.md'],
    ['notes\\*a.md', 'notes*a.md'],
    ['notes/**/', 'notes/x.md'],
    ['C:/notes/**', 'notes/a.md'],
  ])('never reads %j as syntax, so it matches nothing for %j', (grant, path) => {
    expect(scopeProblem(grant)).not.toBeNull()
    expect(matches(grant, path)).toBe(false)
  })
})

describe('the path a scope is matched against', () => {
  it.each([
    'notes/a.md', '.obsidian/app.json', 'notes/C# tips (draft) [1] {x} !?.md', '04 - Daily/2026-11-02.md', 'a.md ', 'a.md.',
    'x'.repeat(MAX_SCOPE_LENGTH),
  ])('takes %j, trailing dots and spaces are the canonicaliser\'s to refuse', path => {
    expect(pathProblem(path)).toBeNull()
  })

  it.each([
    ['', 'empty'],
    ['/notes/a.md', 'an empty, . or .. segment'],
    ['notes//a.md', 'an empty, . or .. segment'],
    ['notes/', 'an empty, . or .. segment'],
    ['./notes/a.md', 'an empty, . or .. segment'],
    ['notes/./a.md', 'an empty, . or .. segment'],
    ['notes/../secret.md', 'an empty, . or .. segment'],
    ['..', 'an empty, . or .. segment'],
    ['notes\\a.md', 'a character a canonical path never holds'],
    ['C:/notes/a.md', 'a character a canonical path never holds'],
    ['notes/a.md::$DATA', 'a character a canonical path never holds'],
    ['.git::$INDEX_ALLOCATION/config', 'a character a canonical path never holds'],
    ['notes/x\nsecret/y', 'a character a canonical path never holds'],
    ['notes/a\u0000.md', 'a character a canonical path never holds'],
    ['notes/\udc00.md', 'a lone surrogate'],
    ['x'.repeat(MAX_SCOPE_LENGTH + 1), `longer than ${MAX_SCOPE_LENGTH} characters`],
  ])('refuses %j, which no scope then matches', (path, problem) => {
    expect(pathProblem(path)).toBe(problem)
    expect(matches('**', path)).toBe(false)
    expect(matches('*', path)).toBe(false)
  })
})

describe('matching', () => {
  it.each([
    ['notes/**', 'notes/a.md'],
    ['notes/**', 'notes/sub/deep/a.md'],
    ['notes/**', 'notes'],
    ['notes/*.md', 'notes/a.md'],
    ['notes/*', 'notes/C# tips (draft) [1] {x} !.md'],
    ['04 - Daily/*.md', '04 - Daily/2026-11-02.md'],
    ['**', 'a.md'],
    ['**', 'a/b/c.md'],
    ['**/x.md', 'x.md'],
    ['**/x.md', 'a/b/x.md'],
    ['a*b', 'ab'],
    ['a*b', 'axxb'],
    ['*a*', 'bab'],
    ['notes/a.md', 'notes/a.md'],
    ['notes/**/x.md', 'notes/x.md'],
    ['notes/**/x.md', 'notes/a/b/x.md'],
    ['**/**', 'a/b'],
    // A trailing * may match nothing
    ['notes/a*', 'notes/a'],
    ['*.md*', 'x.md'],
    ['a*b*', 'ab'],
  ])('%j matches %j', (grant, path) => {
    expect(matches(grant, path)).toBe(true)
    expect(matches(grant, path, exact)).toBe(true)
  })

  it.each([
    ['notes/**', 'other/a.md'],
    ['notes/**', 'notesx/a.md'],
    ['notes/*.md', 'notes/sub/a.md'],
    ['notes/*.md', 'notes/a.txt'],
    ['04 - Daily/*.md', '04 - Daily/sub/x.md'],
    ['a*b', 'axxbc'],
    ['*', 'a/b'],
    ['notes/a.md', 'notes/a.mdx'],
    ['notes/a.md', 'notes/a.md.'],
    ['notes/a.md', 'notes/a.md '],
    ['notes/a.md', 'notes'],
    ['notes/**/x.md', 'notes/a/y.md'],
  ])('%j does not match %j', (grant, path) => {
    expect(matches(grant, path)).toBe(false)
  })

  it('takes ** only as a whole segment, so it never matches part of one', () => {
    expect(matches('a/**', 'a')).toBe(true)
    expect(matches('a/**', 'ab')).toBe(false)
    expect(matches('a/**', 'ab/c')).toBe(false)
    expect(matches('**/b', 'ab')).toBe(false)
  })

  describe('dot segments', () => {
    it.each([
      ['notes/*', 'notes/.hidden.md'],
      ['notes/*.md', 'notes/.md'],
      ['*', '.hidden'],
      ['*a', '.a'],
      ['**', '.obsidian/app.json'],
      ['**', 'notes/.trash/a.md'],
      ['notes/**', 'notes/.trash/a.md'],
      ['notes/**', 'notes/a/.b'],
      ['**/x.md', '.a/x.md'],
      ['**/x.md', 'a/.b/x.md'],
      ['**/*', '.a'],
      ['**/*', 'a/.b'],
    ])('%j never reaches %j through * or **', (grant, path) => {
      expect(matches(grant, path)).toBe(false)
    })

    it.each([
      ['.obsidian/**', '.obsidian/app.json'],
      ['**/.obsidian/*.json', 'a/.obsidian/app.json'],
      ['**/.obsidian/*.json', '.obsidian/app.json'],
      ['.*', '.hidden'],
      ['notes/.*.md', 'notes/.x.md'],
      ['.trash/*', '.trash/a.md'],
    ])('%j reaches %j, since a literal dot names the segment', (grant, path) => {
      expect(matches(grant, path)).toBe(true)
    })
  })

  // .git is refused after canonicalising whatever the grant says, so a grant naming .git reaches nothing
  it.each([
    ['**', '.git/config'],
    ['.git/**', '.git/config'],
    ['.*/**', '.git/config'],
    ['.git/config', '.git/config'],
    ['notes/**', 'notes/.git/config'],
    ['notes/.git/*', 'notes/.git/config'],
    ['.GIT/**', '.GIT/config'],
    ['.Git/**', '.Git/hooks/pre-commit'],
  ])('%j never reaches %j', (grant, path) => {
    expect(matches(grant, path)).toBe(false)
    expect(matches(grant, path, exact)).toBe(false)
  })

  it.each([['.gitignore', '.gitignore'], ['.github/**', '.github/x.yml'], ['notes/.git-notes/*', 'notes/.git-notes/a']])(
    '%j still reaches %j, which only start like .git',
    (grant, path) => {
      expect(matches(grant, path)).toBe(true)
    },
  )
})

describe('case', () => {
  it.each([
    ['notes/**', 'Notes/a.md'],
    ['notes/*.md', 'NOTES/A.MD'],
    ['Notes/A.md', 'notes/a.md'],
    ['04 - daily/*.md', '04 - Daily/2026-11-02.md'],
  ])('folds ASCII letters when asked: %j matches %j', (grant, path) => {
    expect(matches(grant, path, fold)).toBe(true)
    expect(matches(grant, path, exact)).toBe(false)
  })

  it.each([
    ['kb/**', '\u212ab/x.md', 'the Kelvin sign is not k'],
    ['Kb/**', '\u212ab/x.md', 'the Kelvin sign is not K'],
    ['strasse.md', 'stra\u00dfe.md', '\u00df is not ss'],
    ['STRASSE.md', 'stra\u00dfe.md', '\u00df is not SS'],
    ['stra\u00dfe.md', 'STRASSE.md', 'ss is not \u00df'],
    ['stra\u00dfe.md', 'stra\u1e9ee.md', 'the capital sharp s is not \u00df'],
    ['s.md', '\u017f.md', 'the long s is not s'],
    ['i.md', '\u0131.md', 'the dotless i is not i'],
    ['I.md', '\u0131.md', 'the dotless i is not I'],
    ['i.md', '\u0130.md', 'the dotted capital I is not i'],
    ['caf\u00e9.md', 'CAF\u00c9.md', '\u00c9 is not \u00e9, a deny where NTFS would fold'],
  ])('keeps %j from %j: %s', (grant, path) => {
    expect(scopeProblem(grant)).toBeNull()
    expect(matches(grant, path, fold)).toBe(false)
    expect(matches(grant, path, exact)).toBe(false)
  })

  // @ and ` differ by the same bit as A and a, so do ^ and ~
  it('folds only letters, never other characters a case bit apart', () => {
    expect(matches('a@b', 'a`b')).toBe(false)
    expect(matches('a`b', 'a@b')).toBe(false)
    expect(matches('a^b', 'a~b')).toBe(false)
  })
})

describe('NFC', () => {
  it('compares a path as it is, so an NFD name never matches an NFC literal', () => {
    expect(matches('notes/caf\u00e9.md', 'notes/cafe\u0301.md')).toBe(false)
    expect(matches('notes/caf\u00e9.md', 'notes/caf\u00e9.md')).toBe(true)
  })

  it('lets a wildcard take an NFD name, which is still inside the scope', () => {
    expect(matches('notes/*', 'notes/cafe\u0301.md')).toBe(true)
  })

  it('refuses an NFD grant even against the same NFD path', () => {
    expect(matches('notes/cafe\u0301.md', 'notes/cafe\u0301.md')).toBe(false)
  })
})

describe('the 512 character cap', () => {
  it('matches a path of exactly 512 characters and nothing longer', () => {
    const path = `notes/${'a'.repeat(MAX_SCOPE_LENGTH - 6)}`
    expect(path.length).toBe(MAX_SCOPE_LENGTH)
    expect(matches('notes/**', path)).toBe(true)
    expect(matches('notes/**', `${path}a`)).toBe(false)
  })

  it('takes a scope of exactly 512 characters and refuses one more', () => {
    const grant = `notes/${'a'.repeat(MAX_SCOPE_LENGTH - 6)}`
    expect(matches(grant, grant)).toBe(true)
    expect(matches(`${grant}a`, `${grant}a`)).toBe(false)
  })
})

// Shapes that took picomatch 4.0.7, minimatch 10.2.6 and outmatch past 2.5 seconds, grown to the cap. Greedy matching
// with a return to the last star stays within the product of the two lengths
describe('patterns that made glob libraries slow', () => {
  const cut = (text: string) => text.slice(0, MAX_SCOPE_LENGTH).replace(/\/+$/, '')
  const slow: [string, string, string][] = [
    ['many wildcards before a literal that never comes, CVE-2026-26996', `notes/${'*a'.repeat(252)}*b`, `notes/${'a'.repeat(506)}`],
    ['many ** segments, CVE-2026-27903', `${'**/a/'.repeat(102)}b`, `${'a/'.repeat(255)}cc`],
    ['** between expensive segments', cut('**/*a*a*a*b/'.repeat(43)), `${'aaaaaaa/'.repeat(63)}aaaaaaaa`],
    ['* in every segment', `${'*a*/'.repeat(127)}*b`, `${'a/'.repeat(255)}aa`],
    ['one long segment after **', `**/${'*a'.repeat(250)}*b`, 'a'.repeat(MAX_SCOPE_LENGTH)],
    ['**/.. portions, GHSA-g3hv-75wg-m249', `x/${'**/../'.repeat(14)}y`, `x/${'y/'.repeat(254)}yy`],
    ['brace amplification', `notes/${'{a,b}'.repeat(18)}.md`, `notes/${'a'.repeat(503)}.md`],
  ]

  it.each(slow)('answers %s in well under 50 ms on a 512 character path', (_name, grant, path) => {
    expect(grant.length).toBeLessThanOrEqual(MAX_SCOPE_LENGTH)
    expect(path.length).toBe(MAX_SCOPE_LENGTH)
    expect(pathProblem(path)).toBeNull()
    const started = performance.now()
    const answer = matches(grant, path)
    expect(performance.now() - started).toBeLessThan(50)
    expect(answer).toBe(false)
  })
})

// The same rules as a plain recursion over both levels, which the greedy walk must agree with on any input
function reference(grant: string, path: string, foldCase: boolean): boolean {
  if (scopeProblem(grant) !== null || pathProblem(path) !== null) return false
  const segments = path.split('/')
  if (segments.some(segment => /^\.git$/i.test(segment))) return false
  const same = (a: string, b: string) => a === b || (foldCase && /[a-z]/i.test(a) && a.toLowerCase() === b.toLowerCase())
  const segment = (p: string, s: string): boolean => {
    if (p.startsWith('*') && s.startsWith('.')) return false
    const memo = new Map<number, boolean>()
    const at = (i: number, j: number): boolean => {
      const key = i * 1024 + j
      if (!memo.has(key)) {
        memo.set(key, i === p.length ? j === s.length
          : p[i] === '*' ? at(i + 1, j) || (j < s.length && at(i, j + 1))
            : j < s.length && same(p[i], s[j]) && at(i + 1, j + 1))
      }
      return memo.get(key)!
    }
    return at(0, 0)
  }
  const patterns = grant.split('/')
  const memo = new Map<number, boolean>()
  const at = (i: number, j: number): boolean => {
    const key = i * 1024 + j
    if (!memo.has(key)) {
      memo.set(key, i === patterns.length ? j === segments.length
        : patterns[i] === '**' ? at(i + 1, j) || (j < segments.length && !segments[j].startsWith('.') && at(i, j + 1))
          : j < segments.length && segment(patterns[i], segments[j]) && at(i + 1, j + 1))
    }
    return memo.get(key)!
  }
  return at(0, 0)
}

describe('against a plain recursion', () => {
  it('agrees on 20000 random scopes and paths', () => {
    let seed = 66
    // Math.imul keeps the low 32 bits of the product exact, where a plain * rounds them away past 2^53 and the draws
    // stick at 0. The low bits of this generator cycle quickly, so each draw takes the high ones
    const random = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return (seed >>> 16) % n
    }
    const word = (letters: string) => Array.from({ length: 1 + random(5) }, () => letters[random(letters.length)]).join('')
    let agreed = 0
    let matched = 0
    const grants = new Set<string>()
    for (let n = 0; n < 20000; n++) {
      const grant = Array.from({ length: 1 + random(4) }, () => random(4) === 0 ? '**' : word('ab*.A')).join('/')
      const path = Array.from({ length: 1 + random(5) }, () => word('abA.')).join('/')
      const foldCase = random(2) === 0
      const answer = scopeMatches(grant, path, { foldCase })
      expect({ grant, path, foldCase, answer }).toEqual({ grant, path, foldCase, answer: reference(grant, path, foldCase) })
      agreed++
      grants.add(grant)
      if (answer) matched++
    }
    expect(agreed).toBe(20000)
    // Enough different grants and enough of both answers that the agreement means something. The stuck generator drew
    // 5 grants, almost all of them **
    expect(grants.size).toBeGreaterThan(10000)
    expect(matched).toBeGreaterThan(500)
  })
})
