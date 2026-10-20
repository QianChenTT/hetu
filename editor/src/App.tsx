import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { CmEditor, applyRemote } from './CmEditor'

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
  // Who holds each leased note, from the daemon's event stream
  const [leases, setLeases] = useState<Map<string, string>>(new Map())
  const cmView = useRef<EditorView | null>(null)
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
    setStatus('')
    setBanner(null)
    activeRef.current = name
    versionRef.current = note.version
    diskText.current = note.text
    setOriginal(note.text)
    setActive(name)
  }, [])

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
    const out = cmView.current?.state.doc.toString()
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
  }, [active, original])

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
    w.__state = { active, original, version: versionRef.current, holder }
    w.__md = () => cmView.current?.state.doc.toString()
    w.__cm = () => cmView.current
  }, [open, save, active, original, holder])

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
              <button onClick={save} disabled={!!holder}>Save (Ctrl+S)</button>
              <span className="hint">Ctrl+/ raw view</span>
              <span className="status">{status}</span>
            </div>
            {holder && <div className="lease-banner">Held by {holder}, view only. Changes appear here as the agent writes them</div>}
            {banner && <div className="error">{banner}</div>}
            <div className="page">
              <CmEditor key={active} text={original} path={active} readOnly={!!holder} onReady={(v) => (cmView.current = v)} />
            </div>
          </>
        ) : (
          <div className="empty">Pick a note on the left</div>
        )}
      </main>
    </div>
  )
}
