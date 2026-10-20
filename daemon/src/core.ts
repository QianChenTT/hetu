import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Git, type Commit } from './git.ts'
import { callContext, EventLog, short } from './log.ts'

export type Version = string | null // sha256 of the bytes on disk, null when the file doesn't exist

export type ErrorCode =
  | 'LeaseHeld'
  | 'LeaseNotFound'
  | 'OutOfScope'
  | 'StaleVersion'
  | 'NotUnique'
  | 'TextNotFound'
  | 'NotFound'
  | 'OutsideVault'

export class VaultError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.code = code
    this.details = details
  }
}

type Lease = {
  id: string
  label: string
  paths: string[]
  acquiredAt: number
  expiresAt: number
  timer: NodeJS.Timeout
  // The version the lease expects on disk for each path: from acquire, then from each daemon write
  versions: Map<string, Version>
  writes: number
  outsideWrites: Set<string>
}

type ReleaseReason = 'agent' | 'expired' | 'shutdown'

// Pushed to editors. Never carries a lease id: holding one is what lets a client write, and editors don't need it
export type LeaseView = { paths: string[]; holder: string; expires_at: string }
export type Change =
  | { type: 'note.changed'; path: string; version: Version; by: 'agent' | 'human' | 'outside'; holder?: string }
  | ({ type: 'lease.acquired' } & LeaseView)
  | { type: 'lease.released'; paths: string[]; holder: string; commit: string | null }

export type CoreOptions = {
  root: string
  leaseTtlSeconds?: number
  events?: EventLog
}

export function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// Windows and macOS file systems ignore case, so Notes/a.md and notes/a.md are one file and must share one lease
const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
const key = (p: string) => (caseInsensitive ? p.toLowerCase() : p)

export class VaultCore {
  readonly root: string
  readonly git: Git
  readonly events: EventLog
  private readonly ttlMs: number
  private readonly leases = new Map<string, Lease>()
  private readonly leaseByPath = new Map<string, Lease>()
  // Hash of the last bytes the daemon itself wrote to each path, so the watcher can tell its own writes apart
  private readonly ownWrites = new Map<string, string>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<(change: Change) => void>()

  constructor(options: CoreOptions) {
    this.root = path.resolve(options.root)
    this.git = new Git(this.root)
    this.ttlMs = (options.leaseTtlSeconds ?? 120) * 1000
    this.events = options.events ?? new EventLog({ dir: null })
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const { created, dirty } = await this.git.init()
    if (created) this.events.emit('vault.created', { vault: this.root })
    if (dirty.length > 0) {
      const commit = await this.git.commit(dirty, 'edit: changes made while the daemon was stopped')
      this.events.emit('vault.offline_changes', { commit })
    }
  }

  async stop(): Promise<void> {
    await callContext.run({ source: 'shutdown' }, async () => {
      for (const lease of [...this.leases.values()]) await this.release(lease, 'shutdown', 'daemon stopped')
    })
  }

  get openLeases(): number {
    return this.leases.size
  }

  // Editors subscribe to this. A failing listener never breaks the write that triggered it
  subscribe(listener: (change: Change) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private signal(change: Change) {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {}
    }
  }

  leaseViews(): LeaseView[] {
    return [...this.leases.values()].map(l => ({ paths: l.paths, holder: l.label, expires_at: new Date(l.expiresAt).toISOString() }))
  }

  // Vault-relative, forward slashes, inside the vault and never inside .git
  normalize(input: string): string {
    const posix = input.replace(/\\/g, '/').trim()
    if (posix === '' || path.posix.isAbsolute(posix) || /^[a-zA-Z]:/.test(posix)) {
      throw new VaultError('OutsideVault', `Path must be relative to the vault: ${input}`)
    }
    const clean = path.posix.normalize(posix).replace(/^\.\//, '')
    if (clean === '.' || clean.startsWith('../') || clean === '..') {
      throw new VaultError('OutsideVault', `Path leaves the vault: ${input}`)
    }
    if (clean.split('/').some(part => part.toLowerCase() === '.git')) {
      throw new VaultError('OutsideVault', `The vault's .git folder is off limits: ${input}`)
    }
    return clean
  }

  private abs(p: string): string {
    return path.join(this.root, ...p.split('/'))
  }

  // Follows symlinks on an existing file, so a link can't point a write outside the vault
  private async checkReal(p: string): Promise<void> {
    let real: string
    try {
      real = await realpath(this.abs(p))
    } catch {
      return
    }
    const rootReal = await realpath(this.root)
    const rel = path.relative(rootReal, real)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new VaultError('OutsideVault', `Path resolves outside the vault: ${p}`)
    }
  }

  async versionOf(p: string): Promise<Version> {
    try {
      return hash(await readFile(this.abs(p)))
    } catch {
      return null
    }
  }

  private withLock<T>(p: string, task: () => Promise<T>): Promise<T> {
    const k = key(p)
    const next = (this.locks.get(k) ?? Promise.resolve()).then(task, task)
    this.locks.set(k, next.catch(() => {}))
    return next
  }

  private leaseInfo(p: string) {
    const lease = this.leaseByPath.get(key(p))
    return lease ? { holder: lease.label, expires_at: new Date(lease.expiresAt).toISOString() } : undefined
  }

  // A timer started inside a tool call would otherwise carry that call's req id into the expiry event
  private startTimer(lease: Lease, ms: number): NodeJS.Timeout {
    return callContext.exit(() => setTimeout(() => callContext.run({ source: 'timer' }, () => this.expire(lease.id)), ms))
  }

  async listNotes(folder?: string) {
    const start = folder ? this.normalize(folder) : ''
    const out: { path: string; version: string; lease?: { holder: string; expires_at: string } }[] = []
    const walk = async (rel: string) => {
      const entries = await readdir(rel ? this.abs(rel) : this.root, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.git') continue
        const child = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(child)
        else if (entry.isFile()) out.push({ path: child, version: (await this.versionOf(child))!, lease: this.leaseInfo(child) })
      }
    }
    try {
      await walk(start)
    } catch {
      throw new VaultError('NotFound', `No such folder: ${folder}`)
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async readNote(input: string, record = true) {
    const p = this.normalize(input)
    await this.checkReal(p)
    let bytes: Buffer
    try {
      bytes = await readFile(this.abs(p))
    } catch {
      throw new VaultError('NotFound', `No such file: ${p}`)
    }
    const version = hash(bytes)
    // Reads leave no trace in git, so this is the only record of which agent looked at which file
    if (record) this.events.emit('note.read', { path: p, version: short(version) })
    return { path: p, text: bytes.toString('utf8'), version, lease: this.leaseInfo(p) }
  }

  // All or nothing: either every path is free and the lease covers all of them, or nothing is leased
  async acquireLease(inputs: string[], label = 'agent', ttlSeconds?: number) {
    if (inputs.length === 0) throw new VaultError('OutOfScope', 'A lease needs at least one path')
    const cleanLabel = label.replace(/[^\w .@-]/g, '').slice(0, 60) || 'agent'
    const paths = [...new Map(inputs.map(i => this.normalize(i)).map(p => [key(p), p])).values()]
    for (const p of paths) await this.checkReal(p)
    const held = paths
      .map(p => ({ path: p, lease: this.leaseByPath.get(key(p)) }))
      .filter(h => h.lease)
      .map(h => ({ path: h.path, holder: h.lease!.label, lease: h.lease!.id, expires_at: new Date(h.lease!.expiresAt).toISOString() }))
    if (held.length > 0) {
      this.events.emit('lease.denied', { label: cleanLabel, paths, conflicts: held.map(({ path, holder, lease }) => ({ path, holder, lease })) })
      throw new VaultError('LeaseHeld', `Already leased: ${held.map(h => `${h.path} (${h.holder})`).join(', ')}`, held)
    }
    const ttl = ttlSeconds ? ttlSeconds * 1000 : this.ttlMs
    const versions = new Map<string, Version>()
    for (const p of paths) versions.set(key(p), await this.versionOf(p))
    const lease: Lease = {
      id: randomUUID(),
      label: cleanLabel,
      paths,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + ttl,
      timer: undefined as unknown as NodeJS.Timeout,
      versions,
      writes: 0,
      outsideWrites: new Set(),
    }
    lease.timer = this.startTimer(lease, ttl)
    this.leases.set(lease.id, lease)
    for (const p of paths) this.leaseByPath.set(key(p), lease)
    this.events.emit('lease.acquired', { lease: lease.id, label: lease.label, paths, ttl_s: ttl / 1000 })
    this.signal({ type: 'lease.acquired', paths, holder: lease.label, expires_at: new Date(lease.expiresAt).toISOString() })
    const files = paths.map(p => ({ path: p, version: versions.get(key(p)) ?? null }))
    return { lease_id: lease.id, expires_at: new Date(lease.expiresAt).toISOString(), files }
  }

  private async expire(id: string) {
    const lease = this.leases.get(id)
    if (!lease) return
    await this.release(lease, 'expired', '(lease expired)').catch(err =>
      this.events.emit('git.failed', { op: 'commit', lease: id, error: String(err) }, 'error'),
    )
  }

  private leaseFor(id: string, p: string): Lease {
    const lease = this.leases.get(id)
    if (!lease) throw new VaultError('LeaseNotFound', `No active lease ${id}. It may have expired or been released`)
    if (this.leaseByPath.get(key(p)) !== lease) {
      throw new VaultError('OutOfScope', `${p} is not in this lease. Leased paths: ${lease.paths.join(', ')}`, {
        holder: this.leaseByPath.get(key(p))?.label ?? null,
      })
    }
    return lease
  }

  private renew(lease: Lease) {
    clearTimeout(lease.timer)
    lease.expiresAt = Date.now() + this.ttlMs
    lease.timer = this.startTimer(lease, this.ttlMs)
  }

  async writeNote(leaseId: string, input: string, text: string, baseVersion: Version, op: 'write' | 'edit' = 'write') {
    const p = this.normalize(input)
    return this.withLock(p, async () => {
      const lease = this.leaseFor(leaseId, p)
      await this.checkReal(p)
      const current = await this.versionOf(p)
      if (current !== baseVersion) {
        throw new VaultError('StaleVersion', `${p} changed since version ${baseVersion}. Read it again and retry`, { current })
      }
      await mkdir(path.dirname(this.abs(p)), { recursive: true })
      // Bytes go to disk exactly as sent, no reformatting
      const bytes = Buffer.from(text, 'utf8')
      const version = hash(bytes)
      this.ownWrites.set(key(p), version)
      lease.versions.set(key(p), version)
      await writeFile(this.abs(p), bytes)
      lease.writes++
      this.renew(lease)
      // A lease squashes all its writes into one commit, so the versions in between exist only here
      this.events.emit('note.written', { lease: lease.id, path: p, op, base: short(baseVersion), version: short(version), created: baseVersion === null })
      this.signal({ type: 'note.changed', path: p, version, by: 'agent', holder: lease.label })
      return { path: p, version, expires_at: new Date(lease.expiresAt).toISOString() }
    })
  }

  async editNote(leaseId: string, input: string, oldText: string, newText: string, baseVersion: string) {
    const p = this.normalize(input)
    const { text, version } = await this.readNote(p, false).catch(() => {
      throw new VaultError('NotFound', `No such file: ${p}`)
    })
    this.leaseFor(leaseId, p)
    if (version !== baseVersion) {
      throw new VaultError('StaleVersion', `${p} changed since version ${baseVersion}. Read it again and retry`, { current: version })
    }
    const first = text.indexOf(oldText)
    if (oldText === '' || first === -1) throw new VaultError('TextNotFound', `old_text was not found in ${p}`)
    if (text.indexOf(oldText, first + 1) !== -1) {
      throw new VaultError('NotUnique', `old_text appears more than once in ${p}. Include more surrounding text`)
    }
    const next = text.slice(0, first) + newText + text.slice(first + oldText.length)
    // writeNote checks the version again under the per-note lock, so a write landing in between still fails
    return this.writeNote(leaseId, p, next, version, 'edit')
  }

  async releaseLease(leaseId: string, message?: string) {
    const lease = this.leases.get(leaseId)
    if (!lease) throw new VaultError('LeaseNotFound', `No active lease ${leaseId}`)
    return this.release(lease, 'agent', message)
  }

  // One commit for the whole lease, holding only the lease's paths
  private async release(lease: Lease, reason: ReleaseReason, message?: string) {
    clearTimeout(lease.timer)
    this.leases.delete(lease.id)
    for (const p of lease.paths) this.leaseByPath.delete(key(p))

    const warnings = [...lease.outsideWrites].map(p => `${p} was changed outside the daemon during the lease`)
    const subject = `agent(${lease.label}): ${lease.paths.join(', ')}`
    const body = [message, ...warnings.map(w => `Hetu-Warning: ${w}`)].filter(Boolean).join('\n')
    const author = `${lease.label} (hetu agent) <agent@hetu.local>`
    const commit = await this.git.commit(lease.paths, body ? `${subject}\n\n${body}` : subject, author)
    // The commit holds the files, time and author. The log adds how the lease ended and what happened inside it
    this.events.emit(
      'lease.released',
      { lease: lease.id, reason, commit, writes: lease.writes, held_s: Math.round((Date.now() - lease.acquiredAt) / 1000), outside_writes: [...lease.outsideWrites] },
      lease.outsideWrites.size > 0 ? 'warn' : 'info',
    )
    this.signal({ type: 'lease.released', paths: lease.paths, holder: lease.label, commit })
    return { commit, warnings }
  }

  // A save from the hetu editor: refused while an agent holds the note, checked against the version the editor opened,
  // committed at once since Ctrl+S is a deliberate save
  async humanSave(input: string, text: string, baseVersion: Version) {
    const p = this.normalize(input)
    return this.withLock(p, async () => {
      const lease = this.leaseByPath.get(key(p))
      if (lease) {
        throw new VaultError('LeaseHeld', `${p} is being edited by ${lease.label}`, { holder: lease.label, expires_at: new Date(lease.expiresAt).toISOString() })
      }
      await this.checkReal(p)
      const current = await this.versionOf(p)
      if (current !== baseVersion) {
        throw new VaultError('StaleVersion', `${p} changed since you opened it`, { current })
      }
      await mkdir(path.dirname(this.abs(p)), { recursive: true })
      const bytes = Buffer.from(text, 'utf8')
      const version = hash(bytes)
      this.ownWrites.set(key(p), version)
      await writeFile(this.abs(p), bytes)
      const commit = await this.git.commit([p], `edit: ${p}`)
      this.events.emit('human.save', { path: p, base: short(baseVersion), version: short(version), commit })
      this.signal({ type: 'note.changed', path: p, version, by: 'human' })
      return { path: p, version, commit }
    })
  }

  // Raw bytes for artifacts and other non-note files the editor embeds
  async readRaw(input: string) {
    const p = this.normalize(input)
    await this.checkReal(p)
    try {
      const bytes = await readFile(this.abs(p))
      return { path: p, bytes, version: hash(bytes) }
    } catch {
      throw new VaultError('NotFound', `No such file: ${p}`)
    }
  }

  history(input: string, limit = 10): Promise<Commit[]> {
    return this.git.log(this.normalize(input), limit)
  }

  // Called by the watcher. Returns true when the change is a human edit that should be committed
  async noticeChange(p: string): Promise<boolean> {
    const version = await this.versionOf(p)
    if (version !== null && this.ownWrites.get(key(p)) === version) return false
    const lease = this.leaseByPath.get(key(p))
    if (!lease) {
      this.signal({ type: 'note.changed', path: p, version, by: 'outside' })
      return true
    }
    const expected = lease.versions.get(key(p)) ?? null
    if (version === expected) return false
    // Someone wrote a leased file without the daemon. The watcher can't tell a person from a script or an agent's shell
    lease.outsideWrites.add(p)
    lease.versions.set(key(p), version)
    this.events.emit(
      'watch.outside_write',
      { path: p, lease: lease.id, holder: lease.label, expected: short(expected), found: short(version), deleted: version === null },
      'warn',
    )
    this.signal({ type: 'note.changed', path: p, version, by: 'outside', holder: lease.label })
    return false
  }

  async commitHumanEdit(p: string): Promise<string | null> {
    // A lease taken during the debounce wins, its commit will hold the change
    if (this.leaseByPath.has(key(p))) {
      this.events.emit('human.deferred', { path: p, lease: this.leaseByPath.get(key(p))!.id })
      return null
    }
    const commit = await this.git.commit([p], `edit: ${p}`)
    if (commit) this.events.emit('human.commit', { commit })
    return commit
  }
}
