const DOT = 0x2e

// HFS+ skips these code points when comparing names, so .g\u200cit opens .git there or becomes .git in a folder that
// has none. git's protectHFS skips the same set
const ignorable = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g

// The text with the code points HFS+ skips taken out
export function withoutIgnorable(text: string): string {
  return text.replace(ignorable, '')
}

// Whether a segment starts with a dot on some volume, once what HFS+ skips is taken out. Obsidian runs code from
// .obsidian and GitHub from .github, so no note path reaches a dot folder or a dot file. The matcher, the
// canonicaliser, the carrier and the SDK all ask this one check. Apart from zod, so a plugin bundles it through the SDK
export function isDotName(segment: string): boolean {
  return withoutIgnorable(segment).charCodeAt(0) === DOT
}
