import type { BridgeEvent, BridgeResults, ChangeJson, EditorVerb, Mark } from '../api/editor.ts'
import type { RefusalCode } from '../api/envelope.ts'
import { VERSION } from '../api/version.ts'
import { Refused } from './refused.ts'
import type { Transport } from './transport.ts'

// A worker's side of the editor bridge: calls on its port to the editor page's drawer, shaped like CodeMirror. The
// runtime hands a new port for each editor page load and none while no editor page is open or the plugin holds no ui
// item, so every call answers unavailable then. The drawer checks every call against what the gate gives the plugin
export type EditorTopic = 'opened' | 'closed' | 'changed' | 'command' | 'key'

export type EditorClient = {
  // The open notes the plugin reads
  instances(): Promise<BridgeResults['editor.instances']['instances']>
  read(instance: string): Promise<BridgeResults['editor.read']>
  // Replaces the plugin's set of marks of that name, made for version and mapped to the text as it is now
  decorate(instance: string, version: number, set: string, marks: Mark[]): Promise<void>
  // A change list as CodeMirror's ChangeSet.toJSON writes it, made for version and rebased over what changed since
  edit(instance: string, version: number, changes: ChangeJson): Promise<{ version: number }>
  // Replaces every binding. The command named comes back as a command event
  bind(bindings: { key: string, command: string }[]): Promise<void>
  keys(on: boolean): Promise<void>
  on(topic: EditorTopic, handler: (event: BridgeEvent) => void): void
}

type Waiting = { verb: EditorVerb, resolve: (value: unknown) => void, reject: (error: Refused) => void }

export class Editor implements EditorClient {
  private transport: Transport | null = null
  private id = 0
  private readonly pending = new Map<number, Waiting>()
  private readonly handlers = new Map<string, ((event: BridgeEvent) => void)[]>()
  // What a new port is told again: the last bindings and the key stream
  private bindings: { key: string, command: string }[] | null = null
  private stream = false

  // A port to a new editor page load. Calls in flight on the last one fail unavailable
  connect(transport: Transport): void {
    this.transport = transport
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const call of waiting) call.reject(new Refused('unavailable', call.verb))
    transport.listen(message => {
      if (this.transport === transport) this.heard(message)
    })
    if (this.bindings !== null) this.send('editor.bind', { bindings: this.bindings }).catch(() => {})
    if (this.stream) this.send('editor.keys', { on: true }).catch(() => {})
  }

  instances(): Promise<BridgeResults['editor.instances']['instances']> {
    return this.send('editor.instances', undefined).then(result => (result as BridgeResults['editor.instances']).instances)
  }

  read(instance: string): Promise<BridgeResults['editor.read']> {
    return this.send('editor.read', { instance }) as Promise<BridgeResults['editor.read']>
  }

  async decorate(instance: string, version: number, set: string, marks: Mark[]): Promise<void> {
    await this.send('editor.decorate', { instance, version, set, marks })
  }

  edit(instance: string, version: number, changes: ChangeJson): Promise<{ version: number }> {
    return this.send('editor.edit', { instance, version, changes }) as Promise<{ version: number }>
  }

  async bind(bindings: { key: string, command: string }[]): Promise<void> {
    this.bindings = bindings.map(binding => ({ key: binding.key, command: binding.command }))
    await this.send('editor.bind', { bindings: this.bindings })
  }

  async keys(on: boolean): Promise<void> {
    this.stream = on
    await this.send('editor.keys', { on })
  }

  on(topic: EditorTopic, handler: (event: BridgeEvent) => void): void {
    const name = `editor.${topic}`
    const list = this.handlers.get(name) ?? []
    list.push(handler)
    this.handlers.set(name, list)
  }

  private send(verb: EditorVerb, args: unknown): Promise<unknown> {
    const transport = this.transport
    if (transport === null) return Promise.reject(new Refused('unavailable', verb))
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { verb, resolve, reject })
      try {
        transport.post({ v: VERSION, kind: 'call', id, verb, args })
      } catch {
        this.pending.delete(id)
        reject(new Refused('invalid', verb))
      }
    })
  }

  private heard(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const got = message as { kind?: unknown, id?: unknown, ok?: unknown, result?: unknown, refusal?: { code?: unknown }, topic?: unknown }
    if (got.kind === 'reply' && typeof got.id === 'number') {
      const waiting = this.pending.get(got.id)
      if (waiting === undefined) return
      this.pending.delete(got.id)
      if (got.ok === true) waiting.resolve(got.result)
      else waiting.reject(new Refused((typeof got.refusal?.code === 'string' ? got.refusal.code : 'failed') as RefusalCode, waiting.verb))
      return
    }
    if (got.kind !== 'event' || typeof got.topic !== 'string') return
    for (const handler of this.handlers.get(got.topic) ?? []) {
      try {
        handler(message as BridgeEvent)
      } catch (err) {
        console.error(`hetu: a handler for ${got.topic} threw`, err)
      }
    }
  }
}
