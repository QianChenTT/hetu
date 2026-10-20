// The generic sandbox: every piece of code that shows in a note (artifacts now, registry and local
// components later) runs in one of these frames. The frame has an opaque origin, so it can't touch
// the app, other notes or storage. A CSP blocks the network unless the gate granted domains. The only
// way out is a private message port, and every call through it is checked against the gate

import { allowed, type Capability, type Grants } from './policy'

export type Handler = (cap: Capability, args: unknown[], sandbox: Sandbox) => unknown | Promise<unknown>

const CDNS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net']

function csp(grants: Grants): string {
  const scripts = ["'unsafe-inline'", ...(grants.cdnScripts ? CDNS : [])].join(' ')
  const connect = grants.network.length ? grants.network.map((d) => `https://${d}`).join(' ') : "'none'"
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    `connect-src ${connect}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

// The client side of the bridge, injected before the artifact's own code. It exposes window.vault
const CLIENT = `(() => {
  let port = null, init = null, next = 1, ready
  const pending = new Map(), subs = {}
  const readyP = new Promise((r) => (ready = r))
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== 'vault-init' || !e.ports[0]) return
    port = e.ports[0]
    init = e.data.init
    port.onmessage = (m) => {
      const d = m.data
      if (d.type === 'reply') {
        const p = pending.get(d.id)
        if (p) { pending.delete(d.id); d.ok ? p.res(d.result) : p.rej(new Error(d.error)) }
      } else if (d.type === 'event') {
        for (const f of subs[d.topic] || []) f(d.data, d.from)
      }
    }
    ready()
  })
  const call = (cap, ...args) => readyP.then(() => new Promise((res, rej) => {
    const id = next++
    pending.set(id, { res, rej })
    port.postMessage({ type: 'call', id, cap, args })
  }))
  window.vault = {
    ready: readyP.then(() => init),
    note: {
      read: () => call('note.read'),
      highlight: (anchor) => call('note.highlight', anchor),
      popup: (anchor, text) => call('note.popup', anchor, text),
      scrollTo: (anchor) => call('note.scrollTo', anchor),
    },
    state: { get: () => call('state.get'), set: (s) => call('state.set', s) },
    bus: {
      publish: (topic, data) => call('bus.publish', topic, data),
      subscribe: (topic, fn) => { (subs[topic] = subs[topic] || []).push(fn); return call('bus.subscribe', topic) },
    },
    frame: { resize: (h) => call('frame.resize', h) },
  }
})()`

// Put the CSP and the bridge first in <head>, so they apply before any artifact code runs.
// A second CSP the artifact adds can only tighten this one, never loosen it
function srcdoc(html: string, grants: Grants): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp(grants)}"><script>${CLIENT}</script>`
  const m = /<head[^>]*>/i.exec(html)
  return m ? html.slice(0, m.index + m[0].length) + head + html.slice(m.index + m[0].length) : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
}

export class Sandbox {
  readonly frame: HTMLIFrameElement
  readonly topics = new Set<string>()
  private port: MessagePort | null = null

  constructor(
    readonly name: string,
    html: string,
    readonly grants: Grants,
    getInit: () => unknown,
    private handler: Handler,
  ) {
    const f = document.createElement('iframe')
    // allow-scripts only: no allow-same-origin, popups, forms, top navigation or downloads
    f.setAttribute('sandbox', 'allow-scripts')
    f.setAttribute('referrerpolicy', 'no-referrer')
    f.className = 'cm-artifact-frame'
    f.srcdoc = srcdoc(html, grants)
    // A frame reloads when the editor re-attaches it, so hand over a fresh port and state every load
    f.addEventListener('load', () => {
      this.port?.close()
      const ch = new MessageChannel()
      this.port = ch.port1
      this.topics.clear()
      ch.port1.onmessage = (e) => void this.onCall(e.data)
      f.contentWindow?.postMessage({ type: 'vault-init', init: getInit() }, '*', [ch.port2])
    })
    this.frame = f
  }

  private async onCall(d: { type?: string; id?: unknown; cap?: unknown; args?: unknown }) {
    if (!d || d.type !== 'call' || typeof d.id !== 'number' || typeof d.cap !== 'string') return
    const cap = d.cap as Capability
    if (!allowed(this.grants, cap)) return this.reply(d.id, false, `denied by the gate: ${cap}`)
    try {
      const result = await this.handler(cap, Array.isArray(d.args) ? d.args : [], this)
      this.reply(d.id, true, result)
    } catch (e) {
      this.reply(d.id, false, e instanceof Error ? e.message : String(e))
    }
  }

  private reply(id: number, ok: boolean, value: unknown) {
    this.port?.postMessage(ok ? { type: 'reply', id, ok, result: value } : { type: 'reply', id, ok, error: value })
  }

  emit(topic: string, data: unknown, from: string) {
    if (this.topics.has(topic) && allowed(this.grants, 'bus.subscribe')) this.port?.postMessage({ type: 'event', topic, data, from })
  }

  destroy() {
    this.port?.close()
    this.frame.remove()
  }
}
