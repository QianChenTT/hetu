import type { PluginContext, UiEvent } from '@hetu/sdk'
import { threw } from './threw.ts'
import { counted, Ids, MAX_TEXT, viewOf } from './view.ts'

type ViewEvent = Extract<UiEvent, { topic: 'view.event' }>

// The human's own view: the words typed, the notes holding them and the views that show them. It lists what search
// finds with no filterReadable, since the human may read every note and search's own read on ** would drop nothing.
// editor.open checks the read again on a click
export class Viewer {
  private readonly ctx: PluginContext
  private readonly search: (text: string) => string[]
  private readonly instances = new Set<string>()
  private readonly ids = new Ids()
  private typed = ''
  // Counts the searches typed, so an open that answers after a newer one leaves its status line alone
  private searches = 0
  // What the last click came to, shown in the status line until the next word typed
  private told: string | null = null
  private drawing = false
  private drawAgain = false

  constructor(ctx: PluginContext, search: (text: string) => string[]) {
    this.ctx = ctx
    this.search = search
  }

  // A new editor page numbers its instances afresh, so each opened view is drawn whole
  start(): void {
    this.ctx.ui.on('view.opened', event => {
      this.instances.add(event.instance)
      this.draw()
    })
    this.ctx.ui.on('view.closed', event => {
      this.instances.delete(event.instance)
    })
    this.ctx.ui.on('view.event', event => void this.heard(event).catch(threw))
  }

  // Draws every view again with what the index holds now
  draw(): void {
    void this.paint().catch(threw)
  }

  private async heard(event: ViewEvent): Promise<void> {
    if (!this.instances.has(event.instance)) return
    if (event.node === 'query') {
      if (typeof event.value !== 'string') return
      this.typed = event.value.slice(0, MAX_TEXT)
      this.searches++
      this.told = null
      return this.paint()
    }
    if (event.type !== 'click') return
    const path = this.ids.path(event.node)
    if (path === undefined) return
    const searches = this.searches
    const opened = await this.ctx.try(this.ctx.editor.open(path))
    if (this.searches !== searches) return
    this.told = opened.ok ? null : `Can’t open ${path}: ${opened.refused.code}`
    await this.paint()
  }

  // One draw at a time and one more after it when anything changed meanwhile
  private async paint(): Promise<void> {
    if (this.drawing) {
      this.drawAgain = true
      return
    }
    this.drawing = true
    try {
      do {
        this.drawAgain = false
        const hits = this.search(this.typed)
        const tree = viewOf({ typed: this.typed, hits, ids: this.ids, status: this.told ?? counted(this.typed, hits.length) })
        for (const instance of this.instances) await this.ctx.try(this.ctx.ui.views.draw(instance, tree))
      } while (this.drawAgain)
    } finally {
      this.drawing = false
    }
  }
}
