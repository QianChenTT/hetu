// The general tag parser and the gate every tag passes before it becomes a real element.
// Notes are plain text, so nothing renders unless this file builds it. Anything it doesn't
// recognize or allow stays as text, which is the rule for components too

export type ParsedTag = {
  name: string // as written, so component names keep their case
  tag: string // lowercase, for HTML lookups
  attrs: Record<string, string>
  kind: 'open' | 'close' | 'self'
}

const VOID = new Set(['br', 'hr', 'img', 'wbr'])

// Tags allowed inside a line of text
export const INLINE_TAGS = new Set([
  'span', 'mark', 'kbd', 'sub', 'sup', 'u', 's', 'small', 'abbr', 'b', 'i', 'em', 'strong', 'code', 'font', 'a', 'br', 'img',
])

// Tags allowed in an HTML block (its own paragraph of lines)
export const BLOCK_TAGS = new Set([
  ...INLINE_TAGS,
  'div', 'p', 'center', 'details', 'summary', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'figure', 'figcaption',
])

const ATTRS = new Set(['style', 'title', 'align', 'colspan', 'rowspan', 'width', 'height', 'alt', 'src', 'href', 'color', 'open'])

// Parse one tag: <span style="color:red">, </span>, <img src="a.png" /> or <br>
export function parseTag(src: string): ParsedTag | null {
  const m = /^<(\/?)([A-Za-z][\w-]*)([^<>]*?)(\/?)>$/.exec(src.trim())
  if (!m) return null
  const [, close, name, rest, slash] = m
  const tag = name.toLowerCase()
  if (close) return rest.trim() ? null : { name, tag, attrs: {}, kind: 'close' }

  const attrs: Record<string, string> = {}
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let leftover = rest
  for (const a of rest.matchAll(re)) {
    attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? ''
    leftover = leftover.replace(a[0], '')
  }
  // Anything the attribute pattern couldn't read means the tag is malformed
  if (leftover.trim()) return null
  return { name, tag, attrs, kind: slash || VOID.has(tag) ? 'self' : 'open' }
}

const safeUrl = (v: string) => !/^\s*(javascript|data|vbscript|file):/i.test(v)
const safeStyle = (v: string) => !/url\s*\(|expression\s*\(|@import|behavior\s*:/i.test(v)

// The gate for attributes: every attribute must be known and its value safe, or the whole tag stays text
export function attrsAllowed(attrs: Record<string, string>): boolean {
  return Object.entries(attrs).every(([k, v]) => {
    if (!ATTRS.has(k)) return false
    if ((k === 'href' || k === 'src') && !safeUrl(v)) return false
    if (k === 'style' && !safeStyle(v)) return false
    return true
  })
}

export function inlineAllowed(t: ParsedTag): boolean {
  return INLINE_TAGS.has(t.tag) && attrsAllowed(t.attrs)
}

// How an allowed inline tag is drawn around editable text. <font> and <a> are mapped to safe stand-ins
export function inlineElement(t: ParsedTag): { tagName: string; attributes: Record<string, string> } {
  const attributes = { ...t.attrs }
  if (t.tag === 'font') {
    const color = attributes.color
    delete attributes.color
    if (color) attributes.style = `color:${color};${attributes.style ?? ''}`
    return { tagName: 'span', attributes }
  }
  if (t.tag === 'a') {
    // A real link inside an editable area would navigate on click, so show it styled with the URL as a tooltip
    const href = attributes.href
    delete attributes.href
    return { tagName: 'span', attributes: { ...attributes, class: 'cm-link', ...(href ? { title: href } : {}) } }
  }
  return { tagName: t.tag, attributes }
}

// Parse a block of HTML with the browser's parser in an inert template (nothing loads or runs there),
// then check every element against the gate. Returns null if anything is not allowed
function parseInert(html: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

function treeAllowed(node: Node): boolean {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue
    if (child.nodeType !== Node.ELEMENT_NODE) return false
    const el = child as Element
    const attrs: Record<string, string> = {}
    for (const a of Array.from(el.attributes)) attrs[a.name.toLowerCase()] = a.value
    if (!BLOCK_TAGS.has(el.tagName.toLowerCase()) || !attrsAllowed(attrs)) return false
    if (!treeAllowed(el)) return false
  }
  return true
}

export function blockAllowed(html: string): boolean {
  return treeAllowed(parseInert(html))
}

// Rebuild the allowed tree with createElement, so the live DOM only ever gets elements we made
function rebuild(node: Node, into: Node) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(document.createTextNode(child.textContent ?? ''))
      continue
    }
    const el = child as Element
    const tag = el.tagName.toLowerCase()
    const attrs: Record<string, string> = {}
    for (const a of Array.from(el.attributes)) attrs[a.name.toLowerCase()] = a.value
    const { tagName, attributes } = INLINE_TAGS.has(tag)
      ? inlineElement({ name: tag, tag, attrs, kind: 'open' })
      : { tagName: tag, attributes: attrs }
    const out = document.createElement(tagName)
    for (const [k, v] of Object.entries(attributes)) out.setAttribute(k, v)
    rebuild(el, out)
    into.appendChild(out)
  }
}

export function buildBlock(html: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'cm-html-block'
  rebuild(parseInert(html), wrap)
  return wrap
}

export function buildVoid(t: ParsedTag): HTMLElement {
  const el = document.createElement(t.tag)
  for (const [k, v] of Object.entries(t.attrs)) el.setAttribute(k, v)
  return el
}
