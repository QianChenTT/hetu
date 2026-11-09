import { describe, expect, it } from 'vitest'
import {
  allowedStyles, applyOps, contrast, editorColors, MAX_NODE_TEXT, MAX_NODES, MAX_OPS, MAX_TREE_DEPTH, node, type Op, op, parseDrawerCall,
  styleProblem, themeSpec, themeVariables, type UiNode, uiNeeds,
} from '../api/ui.ts'

const box = (id: string, children: UiNode[] = [], extra: object = {}): UiNode => ({ kind: 'box', id, children, ...extra } as UiNode)
const text = (id: string, value: string): UiNode => ({ kind: 'text', id, text: value })
const call = (verb: string, args: unknown, id = 1) => JSON.stringify({ v: 1, kind: 'call', id, verb, args })

describe('the building blocks', () => {
  const every: UiNode[] = [
    box('a', [text('b', 'hi')], { style: { display: 'flex', gap: '4px' }, hover: { color: '#333' }, click: true, tip: 'A box' }),
    { kind: 'text', id: 't', text: 'Hello' },
    { kind: 'icon', id: 'i', src: 'dist/icon.svg', alt: 'Notes' },
    { kind: 'button', id: 'b', text: 'Save', disabled: false },
    { kind: 'input', id: 'in', value: '', placeholder: 'Filter' },
    { kind: 'checkbox', id: 'c', checked: true, label: 'Done' },
    { kind: 'select', id: 's', value: 'a', options: [{ value: 'a', text: 'A' }, { value: 'b', text: 'B' }] },
    { kind: 'list', id: 'l', rowHeight: 24, rows: [text('r1', 'one'), text('r2', 'two')] },
    { kind: 'scroll', id: 'sc', children: [text('x', 'x')] },
    { kind: 'split', id: 'sp', direction: 'row', children: [box('l1'), box('l2')], sizes: [200, 400], min: [100, 100], resizable: true },
    { kind: 'popover', id: 'p', anchor: 'b', side: 'below', children: [text('pt', 'menu')] },
    { kind: 'slot', id: 'sl', instance: 'v1' },
    { kind: 'slot', id: 'items', items: true },
    { kind: 'editor', id: 'e', instance: 'n3' },
    { kind: 'editor', id: 'cur', instance: 'current' },
    { kind: 'title', id: 'ti', of: 'v2' },
    box('z', [], { zone: 'left', accepts: ['note'], drag: { type: 'note', value: 'notes/a.md' } }),
    box('d', [], { drag: { type: 'text', value: 'some words' } }),
  ]

  it.each(every)('takes a $kind', value => {
    expect(node.parse(value)).toEqual(value)
  })

  it.each([
    ['an unknown block', { kind: 'iframe', id: 'x', src: 'https://example.com' }],
    ['an unknown property', { kind: 'text', id: 'x', text: 'a', html: '<b>a</b>' }],
    ['an id with a space', { kind: 'text', id: 'a b', text: 'a' }],
    ['an id past 64 characters', { kind: 'text', id: 'x'.repeat(65), text: 'a' }],
    ['a text past the cap', { kind: 'text', id: 'x', text: 'x'.repeat(MAX_NODE_TEXT + 1) }],
    ['an icon outside the folder', { kind: 'icon', id: 'x', src: '../icon.svg' }],
    ['an icon that is a script', { kind: 'icon', id: 'x', src: 'dist/icon.js' }],
    ['a style that escapes its box', { kind: 'box', id: 'x', style: { position: 'fixed' } }],
    ['a hover style with a url', { kind: 'box', id: 'x', hover: { 'background-color': 'url(x)' } }],
    ['a note payload that is no path', { kind: 'box', id: 'x', drag: { type: 'note', value: '../secret.md' } }],
    ['a payload of an unknown type', { kind: 'box', id: 'x', drag: { type: 'file', value: 'a' } }],
    ['a payload past 4 KiB', { kind: 'box', id: 'x', drag: { type: 'text', value: 'x'.repeat(4097) } }],
    ['a slot naming an editor instance', { kind: 'slot', id: 'x', instance: 'n1' }],
    ['an editor slot naming a view', { kind: 'editor', id: 'x', instance: 'v1' }],
    ['a split of one child', { kind: 'split', id: 'x', direction: 'row', children: [box('a')] }],
    ['a split whose sizes miss a child', { kind: 'split', id: 'x', direction: 'row', children: [box('a'), box('b')], sizes: [100] }],
    ['a list row height of 2', { kind: 'list', id: 'x', rowHeight: 2, rows: [] }],
    ['a select with 201 options', { kind: 'select', id: 'x', value: 'a', options: Array.from({ length: 201 }, (_, i) => ({ value: `${i}`, text: `${i}` })) }],
  ])('refuses %s', (_name, value) => {
    expect(node.safeParse(value).success).toBe(false)
  })
})

describe('styles', () => {
  it.each([
    { color: 'red' },
    { display: 'flex', 'flex-direction': 'column', gap: '8px' },
    { position: 'absolute', top: '0', 'z-index': '9' },
    { color: 'var(--hetu-color-fg)', 'background-color': 'var(--hetu-color-surface)' },
    { 'grid-template-columns': 'repeat(3, 1fr)', width: 'calc(100% - 8px)' },
    { 'font-family': 'Inter, system-ui', 'box-shadow': '0 1px 2px rgb(0 0 0 / 20%)' },
  ])('takes %j', style => {
    expect(styleProblem(style)).toBe(null)
  })

  it.each([
    ['position fixed', { position: 'fixed' }],
    ['a z-index of 10', { 'z-index': '10' }],
    ['a negative z-index', { 'z-index': '-1' }],
    ['a url', { 'background-color': 'url(https://example.com/x)' }],
    ['an image-set', { 'background-color': 'image-set("a.png" 1x)' }],
    ['a selector smuggled in a value', { color: 'red;}a{color:blue' }],
    ['a backslash escape', { color: 'u\\72l(x)' }],
    ['a comment', { color: 'red/**/' }],
    ['important', { color: 'red !important' }],
    ['an at rule', { color: '@import' }],
    ['a quote', { 'font-family': '"Inter"' }],
    ['a var naming no hetu token', { color: 'var(--x)' }],
    ['a var naming an unknown hetu token', { color: 'var(--hetu-color-link)' }],
    ['a var with a fallback', { color: 'var(--hetu-color-fg, url(x))' }],
    ['an attr', { width: 'attr(data-x)' }],
    ['an env', { width: 'env(safe-area-inset-top)' }],
    ['a property off the list', { behavior: 'url(x.htc)' }],
    ['a custom property', { '--hetu-color-fg': '#000' }],
    ['a background shorthand', { background: 'red' }],
    ['a value past 200 characters', { width: 'x'.repeat(201) }],
    ['an angle bracket', { color: '<b>' }],
  ])('refuses %s', (_name, style) => {
    expect(styleProblem(style)).not.toBe(null)
  })

  it('refuses more than 64 properties', () => {
    const names = [...allowedStyles].filter(name => !['position', 'z-index', 'display', 'pointer-events'].includes(name)).slice(0, 65)
    expect(names).toHaveLength(65)
    expect(styleProblem(Object.fromEntries(names.slice(0, 64).map(name => [name, '0'])))).toBe(null)
    expect(styleProblem(Object.fromEntries(names.map(name => [name, '0'])))).not.toBe(null)
  })
})

describe('applying operations', () => {
  const start: UiNode = box('root', [box('side', [text('a', 'one')]), text('b', 'two')])
  const run = (tree: UiNode | null, ops: Op[], layout = false) => applyOps(tree, ops, { layout })

  it('replaces the whole tree', () => {
    expect(run(null, [{ op: 'tree', root: start }])).toMatchObject({ tree: start })
  })

  it('sets a node and its subtree by id, leaving the tree it was given as it was', () => {
    const before = JSON.stringify(start)
    const got = run(start, [{ op: 'set', node: box('side', [text('c', 'three')]) }])
    expect('tree' in got && got.tree).toEqual(box('root', [box('side', [text('c', 'three')]), text('b', 'two')]))
    expect(JSON.stringify(start)).toBe(before)
  })

  it('changes a node\'s properties and keeps its children', () => {
    const got = run(start, [{ op: 'props', node: { kind: 'box', id: 'side', style: { color: 'red' } } }])
    expect('tree' in got && got.tree).toEqual(box('root', [box('side', [text('a', 'one')], { style: { color: 'red' } }), text('b', 'two')]))
  })

  it('changes a split\'s sizes through props, its children kept, and refuses sizes that miss a child', () => {
    const split: UiNode = { kind: 'split', id: 'cols', direction: 'row', children: [box('l'), box('r')], sizes: [100, 0] }
    const sized = { kind: 'split', id: 'cols', direction: 'row', sizes: [300, 0] } as UiNode
    expect(op.safeParse({ op: 'props', node: sized }).success).toBe(true)
    const got = run(split, [{ op: 'props', node: sized }])
    expect('tree' in got && got.tree).toEqual({ ...split, sizes: [300, 0] })
    expect(run(split, [{ op: 'props', node: { ...sized, sizes: [300] } as UiNode }])).toHaveProperty('problem')
  })

  it('changes a text', () => {
    const got = run(start, [{ op: 'text', id: 'b', text: 'TWO' }])
    expect('tree' in got && got.tree).toEqual(box('root', [box('side', [text('a', 'one')]), text('b', 'TWO')]))
  })

  it('inserts and removes', () => {
    const got = run(start, [{ op: 'insert', parent: 'side', at: 0, node: text('z', 'zero') }, { op: 'remove', id: 'b' }])
    expect('tree' in got && got.tree).toEqual(box('root', [box('side', [text('z', 'zero'), text('a', 'one')])]))
  })

  it.each([
    ['a set naming no node', [{ op: 'set', node: text('nope', 'x') }]],
    ['a props of another kind', [{ op: 'props', node: { kind: 'text', id: 'side', text: 'x' } }]],
    ['a props carrying children', [{ op: 'props', node: box('side', [text('q', 'q')]) }]],
    ['a text on a box', [{ op: 'text', id: 'side', text: 'x' }]],
    ['an insert into a text', [{ op: 'insert', parent: 'a', at: 0, node: text('q', 'q') }]],
    ['an insert past the end', [{ op: 'insert', parent: 'side', at: 5, node: text('q', 'q') }]],
    ['removing the root', [{ op: 'remove', id: 'root' }]],
    ['a duplicate id', [{ op: 'insert', parent: 'side', at: 0, node: text('b', 'again') }]],
    ['a popover anchored to no node', [{ op: 'insert', parent: 'root', at: 0, node: { kind: 'popover', id: 'p', anchor: 'gone', side: 'below', children: [] } }]],
  ] as [string, Op[]][])('refuses %s', (_name, ops) => {
    expect(run(start, ops)).toHaveProperty('problem')
  })

  it('refuses an operation before any tree', () => {
    expect(run(null, [{ op: 'text', id: 'a', text: 'x' }])).toHaveProperty('problem')
  })

  it(`refuses a tree past ${MAX_NODES} nodes or ${MAX_TREE_DEPTH} deep`, () => {
    const wide = box('root', Array.from({ length: MAX_NODES }, (_, i) => text(`t${i}`, 'x')))
    expect(run(null, [{ op: 'tree', root: wide }])).toHaveProperty('problem')
    let deep = text('leaf', 'x')
    for (let i = 0; i < MAX_TREE_DEPTH; i++) deep = box(`d${i}`, [deep])
    expect(run(null, [{ op: 'tree', root: deep }])).toHaveProperty('problem')
  })

  it('lets only a layout place slots, editors, titles and zones', () => {
    for (const placed of [
      { kind: 'slot', id: 's', instance: 'v1' }, { kind: 'editor', id: 'e', instance: 'current' }, { kind: 'title', id: 't', of: 'n1' },
      box('z', [], { zone: 'left' }),
    ] as UiNode[]) {
      const tree = box('root', [placed])
      expect(run(null, [{ op: 'tree', root: tree }])).toHaveProperty('problem')
      expect(run(null, [{ op: 'tree', root: tree }], true)).toHaveProperty('tree')
    }
  })

  it('counts the nodes it visited, which the drawer charges', () => {
    const got = run(start, [{ op: 'text', id: 'b', text: 'x' }])
    expect('visited' in got && got.visited).toBeGreaterThan(0)
  })
})

describe('an operation as sent', () => {
  it('takes each operation', () => {
    for (const value of [
      { op: 'tree', root: text('a', 'x') }, { op: 'set', node: text('a', 'x') }, { op: 'props', node: { kind: 'text', id: 'a', text: 'y' } },
      { op: 'text', id: 'a', text: 'x' }, { op: 'insert', parent: 'r', at: 0, node: text('a', 'x') }, { op: 'remove', id: 'a' },
    ]) expect(op.safeParse(value).success).toBe(true)
  })

  it('refuses an unknown one', () => {
    expect(op.safeParse({ op: 'html', id: 'a', html: '<b>' }).success).toBe(false)
  })
})

describe('themes', () => {
  it('turns tokens into the variables the drawer sets, only those given', () => {
    expect(themeVariables({ 'color-bg': '#fafafa', radius: '4px' })).toEqual({ '--hetu-color-bg': '#fafafa', '--hetu-radius': '4px' })
  })

  it('measures contrast as WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#fff', '#fff')).toBeCloseTo(1, 5)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })

  it('keeps the editor\'s text at 4.5 to 1 against its background, else hetu\'s colors', () => {
    expect(editorColors({ 'color-editor-fg': '#202020', 'color-editor-bg': '#fdfdfd' })).toEqual({ ok: true, fg: '#202020', bg: '#fdfdfd' })
    expect(editorColors({ 'color-editor-fg': '#ffffff', 'color-editor-bg': '#fefefe' })).toEqual({ ok: false, fg: '#1f1f1f', bg: '#ffffff' })
    // The general colors stand in for the editor's
    expect(editorColors({ 'color-fg': '#eeeeee', 'color-bg': '#111111' })).toEqual({ ok: true, fg: '#eeeeee', bg: '#111111' })
    expect(editorColors({ 'color-fg': '#eeeeee' })).toEqual({ ok: false, fg: '#1f1f1f', bg: '#ffffff' })
  })

  it('takes a theme of tokens and refuses anything else', () => {
    expect(themeSpec.safeParse({ tokens: { 'color-fg': '#000' } }).success).toBe(true)
    expect(themeSpec.safeParse({ tokens: { 'color-fg': 'red' } }).success).toBe(false)
  })
})

describe('the ui verbs on a plugin\'s port', () => {
  const tree = { kind: 'text', id: 'a', text: 'hi' }

  it.each([
    ['view.open', { view: 'tree' }],
    ['view.close', { instance: 'v1' }],
    ['view.title', { instance: 'v1', title: 'Board: plans' }],
    ['view.draw', { instance: 'v1', ops: [{ op: 'tree', root: tree }] }],
    ['view.post', { instance: 'v1', data: { cards: [1, 2] } }],
    ['view.bind', { bindings: [{ key: 'j', command: 'down' }, { key: 'Mod-Enter', command: 'open' }] }],
    ['layout.draw', { ops: [{ op: 'tree', root: tree }] }],
    ['editor.open', { path: 'notes/a.md' }],
    ['editor.read', { instance: 'n1' }],
  ])('reads %s', (verb, args) => {
    expect(parseDrawerCall(call(verb, args))).toMatchObject({ verb, args })
  })

  it.each([
    ['view.open', { view: 'my tree' }],
    ['view.close', { instance: 'n1' }],
    ['view.title', { instance: 'v1', title: `hetu${String.fromCodePoint(0x202e)}` }],
    ['view.draw', { instance: 'v1', ops: Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'remove', id: 'a' })) }],
    ['view.post', { instance: 'v1', data: 'x'.repeat(64 * 1024 + 1) }],
    ['view.bind', { bindings: [{ key: 'Hyper-x', command: 'raw' }] }],
    ['view.bind', { bindings: [{ key: 'Mod-', command: 'x' }] }],
    ['layout.draw', { ops: [{ op: 'tree', root: { kind: 'frame', id: 'a' } }] }],
    ['editor.open', { path: '../secret.md' }],
    ['view.unknown', {}],
  ])('refuses %s with %j', (verb, args) => {
    expect(parseDrawerCall(call(verb, args))).toBe(null)
  })

  it('answers null for text that is no call and for a key reaching Object', () => {
    expect(parseDrawerCall('not json')).toBe(null)
    expect(parseDrawerCall('{"v":1,"kind":"call","id":1,"verb":"view.open","args":{"view":"a","__proto__":{}}}')).toBe(null)
  })

  it('names the item each verb needs', () => {
    expect(uiNeeds['view.draw']).toBe('ui.view')
    expect(uiNeeds['layout.draw']).toBe('ui.layout')
    expect(uiNeeds['editor.open']).toBe('ui.view')
  })
})
