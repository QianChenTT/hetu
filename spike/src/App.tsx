import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MDXEditor,
  type MDXEditorMethods,
  type JsxComponentDescriptor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  imagePlugin,
  tablePlugin,
  frontmatterPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  markdownShortcutPlugin,
  diffSourcePlugin,
  toolbarPlugin,
  jsxPlugin,
  GenericJsxEditor,
  DiffSourceToggleWrapper,
  UndoRedo,
  BoldItalicUnderlineToggles,
} from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'
import type { EditorView } from '@codemirror/view'
import { CmEditor, applyRemote } from './CmEditor'

// The one sample component. No `source`, so MDXEditor won't inject an import line into the note
const descriptors: JsxComponentDescriptor[] = [
  {
    name: 'Callout',
    kind: 'flow',
    props: [
      { name: 'type', type: 'string' },
      { name: 'title', type: 'string' },
    ],
    hasChildren: true,
    Editor: GenericJsxEditor,
  },
]

const languages = {
  '': 'Plain text',
  txt: 'Plain text',
  bash: 'Bash',
  sh: 'Shell',
  python: 'Python',
  js: 'JavaScript',
  ts: 'TypeScript',
  json: 'JSON',
  md: 'Markdown',
}

// Vault paths can hold slashes, each segment is encoded on its own
const notesUrl = (p: string) => `/api/notes/${p.split('/').map(encodeURIComponent).join('/')}`

type Change =
  | { type: 'note.changed'; path: string; version: string | null; by: 'agent' | 'human' | 'outside'; holder?: string }
  | { type: 'lease.acquired'; paths: string[]; holder: string }
  | { type: 'lease.released'; paths: string[]; holder: string; commit: string | null }

// Count lines that differ between two texts, position by position. Rough, but enough to spot reformatting
function changedLines(a: string, b: string): number {
  const x = a.split('\n')
  const y = b.split('\n')
  let n = Math.abs(x.length - y.length)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++
  return n
}

export default function App() {
  const [notes, setNotes] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [original, setOriginal] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [banner, setBanner] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  // Who holds each leased note, from the daemon's event stream
  const [leases, setLeases] = useState<Map<string, string>>(new Map())
  const editor = useRef<MDXEditorMethods>(null)
  const cmView = useRef<EditorView | null>(null)
  const [engine, setEngine] = useState<'cm' | 'mdx'>('cm')
  // What the open note looks like on disk: its version (sent back on save) and its text (to tell unsaved edits apart)
  const activeRef = useRef<string | null>(null)
  const versionRef = useRef<string | null>(null)
  const diskText = useRef<string | null>(null)

  const loadList = useCallback(async () => {
    const list: { path: string }[] = await (await fetch('/api/notes')).json()
    setNotes(list.map((n) => n.path).filter((p) => /\.mdx?$/.test(p)))
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  const open = useCallback(async (name: string) => {
    const note = await (await fetch(notesUrl(name))).json()
    setParseError(null)
    setStatus('')
    setBanner(null)
    activeRef.current = name
    versionRef.current = note.version
    diskText.current = note.text
    setOriginal(note.text)
    setActive(name)
  }, [])

  const current = () => (engine === 'cm' ? cmView.current?.state.doc.toString() : editor.current?.getMarkdown())

  // A note changed on disk. Show it at once unless the user has unsaved edits, which are never overwritten
  const onChanged = useCallback(async (change: Extract<Change, { type: 'note.changed' }>) => {
    if (change.path !== activeRef.current || change.version === versionRef.current) return
    const note = await (await fetch(notesUrl(change.path))).json()
    const view = cmView.current
    const doc = view?.state.doc.toString()
    if (doc === note.text) {
      // Already showing it, for example our own save coming back
    } else if (view && doc === diskText.current) {
      applyRemote(view, note.text)
      setStatus(`Updated live, ${change.by === 'agent' ? `written by ${change.holder}` : change.by === 'human' ? 'saved in another tab' : 'changed outside the daemon'}`)
    } else {
      setBanner('This note changed on disk while you have unsaved edits. Your edits are kept, but saving will fail until you reopen the note')
      return
    }
    versionRef.current = note.version
    diskText.current = note.text
  }, [])

  useEffect(() => {
    const es = new EventSource('/api/events')
    es.addEventListener('hello', (e) => {
      const { leases: list } = JSON.parse((e as MessageEvent).data) as { leases: { paths: string[]; holder: string }[] }
      setLeases(new Map(list.flatMap((l) => l.paths.map((p) => [p, l.holder] as [string, string]))))
    })
    es.addEventListener('lease.acquired', (e) => {
      const c = JSON.parse((e as MessageEvent).data) as Extract<Change, { type: 'lease.acquired' }>
      setLeases((m) => new Map([...m, ...c.paths.map((p) => [p, c.holder] as [string, string])]))
    })
    es.addEventListener('lease.released', (e) => {
      const c = JSON.parse((e as MessageEvent).data) as Extract<Change, { type: 'lease.released' }>
      setLeases((m) => new Map([...m].filter(([p]) => !c.paths.includes(p))))
      if (activeRef.current && c.paths.includes(activeRef.current)) setStatus(`${c.holder} finished${c.commit ? `, commit ${c.commit.slice(0, 7)}` : ''}. Editable again`)
    })
    es.addEventListener('note.changed', (e) => {
      const c = JSON.parse((e as MessageEvent).data) as Extract<Change, { type: 'note.changed' }>
      onChanged(c)
      if (c.version !== null && /\.mdx?$/.test(c.path)) setNotes((list) => (list.includes(c.path) ? list : [...list, c.path].sort()))
    })
    return () => es.close()
  }, [onChanged])

  const holder = active ? leases.get(active) : undefined

  const save = useCallback(async () => {
    if (!active || original === null) return
    const out = engine === 'cm' ? cmView.current?.state.doc.toString() : editor.current?.getMarkdown()
    if (out === undefined) return
    const res = await fetch(notesUrl(active), { method: 'PUT', body: JSON.stringify({ text: out, baseVersion: versionRef.current }) })
    const body = await res.json()
    if (res.status === 423) return setStatus(`Not saved, ${body.details?.holder ?? 'an agent'} is editing this note`)
    if (res.status === 409) return setStatus('Not saved, the note changed on disk since you opened it')
    if (!res.ok) return setStatus(`Not saved: ${body.error}`)
    versionRef.current = body.version
    diskText.current = out
    const diff = changedLines(original, out)
    setStatus(`Saved, commit ${body.commit ? body.commit.slice(0, 7) : 'none (no change)'}, ${diff} line(s) differ from when you opened it`)
  }, [active, original, engine])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  // Test hooks so round-trips can be scripted from the browser console
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__open = open
    w.__save = save
    w.__parseError = parseError
    w.__state = { active, original, version: versionRef.current, holder }
    w.__md = current
    w.__cm = () => cmView.current
    w.__engine = setEngine
  }, [open, save, parseError, active, original, engine, holder])

  const isMdx = active?.endsWith('.mdx') ?? false

  const plugins = useMemo(() => {
    if (original === null) return []
    const list = [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      imagePlugin(),
      tablePlugin(),
      frontmatterPlugin(),
      codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
      codeMirrorPlugin({ codeBlockLanguages: languages }),
      markdownShortcutPlugin(),
      diffSourcePlugin({ viewMode: 'rich-text', diffMarkdown: original }),
      toolbarPlugin({
        toolbarContents: () => (
          <DiffSourceToggleWrapper>
            <UndoRedo />
            <BoldItalicUnderlineToggles />
          </DiffSourceToggleWrapper>
        ),
      }),
    ]
    // Plain .md stays plain markdown. Only .mdx gets JSX parsing, so a stray { or < in a .md note can't break it
    if (isMdx) list.push(jsxPlugin({ jsxComponentDescriptors: descriptors }))
    return list
  }, [original, isMdx])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-title">playground_vault</div>
        {notes.map((n) => (
          <button key={n} className={n === active ? 'note active' : 'note'} onClick={() => open(n)} title={leases.has(n) ? `held by ${leases.get(n)}` : undefined}>
            {leases.has(n) ? '🔒 ' : ''}
            {n}
          </button>
        ))}
      </aside>
      <main className="main">
        {active && original !== null ? (
          <>
            <div className="bar">
              <span className="name">{active}</span>
              <div className="engine">
                <button className={engine === 'cm' ? 'on' : ''} onClick={() => setEngine('cm')}>CodeMirror</button>
                <button className={engine === 'mdx' ? 'on' : ''} onClick={() => setEngine('mdx')}>MDXEditor</button>
              </div>
              <button onClick={save} disabled={!!holder}>Save (Ctrl+S)</button>
              {engine === 'cm' && <span className="hint">Ctrl+/ raw view</span>}
              <span className="status">{status}</span>
            </div>
            {holder && <div className="lease-banner">Held by {holder}, view only. Changes appear here as the agent writes them</div>}
            {banner && <div className="error">{banner}</div>}
            {parseError && <div className="error">Parse error: {parseError}</div>}
            <div className="page">
              {engine === 'cm' ? (
                <CmEditor key={active} text={original} path={active} readOnly={!!holder} onReady={(v) => (cmView.current = v)} />
              ) : (
                <MDXEditor
                  key={active}
                  ref={editor}
                  markdown={original}
                  plugins={plugins}
                  contentEditableClassName="prose"
                  toMarkdownOptions={{ bullet: '-' }}
                  onError={(e) => setParseError(e.error)}
                />
              )}
            </div>
          </>
        ) : (
          <div className="empty">Pick a note on the left</div>
        )}
      </main>
    </div>
  )
}
