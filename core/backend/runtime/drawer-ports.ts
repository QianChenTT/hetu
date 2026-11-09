import type { WorkerStart } from '../loader/seams.ts'

// The ports between plugin workers and the editor page's drawer. Main makes one channel for each pair of a running worker
// whose plugin holds a ui item and an editor page load, once the page's dom-ready says its preload listens, and hands
// one end to the worker host page and the other to the editor page, named with the plugin and its incarnation, so no
// plugin sets the owner of what reaches the drawer. Messages then go renderer to renderer. A worker's end is told to the
// page, since a port's close needn't reach the other renderer. A new load gets new pairs: the old page's ends went with
// it. P is the page as main holds it
export type DrawerPortsOptions<P> = {
  channel(): { port1: unknown, port2: unknown }
  toWorker(id: string, incarnation: number, port: unknown): void
  toPage(page: P, plugin: string, incarnation: number, port: unknown): void
  endInPage(page: P, plugin: string, incarnation: number): void
}

export class DrawerPorts<P> {
  private readonly options: DrawerPortsOptions<P>
  // Each running worker with a ui item, by plugin, with its incarnation
  private readonly workers = new Map<string, number>()
  private page: P | null = null

  constructor(options: DrawerPortsOptions<P>) {
    this.options = options
  }

  started(id: string, incarnation: number): void {
    this.workers.set(id, incarnation)
    if (this.page !== null) this.pair(this.page, id, incarnation)
  }

  ended(id: string, incarnation: number): void {
    if (this.workers.get(id) !== incarnation) return
    this.workers.delete(id)
    if (this.page !== null) this.options.endInPage(this.page, id, incarnation)
  }

  // The editor page's preload is listening
  loaded(page: P): void {
    this.page = page
    for (const [id, incarnation] of this.workers) this.pair(page, id, incarnation)
  }

  // The page navigated, crashed or closed
  unloaded(page: P): void {
    if (this.page === page) this.page = null
  }

  private pair(page: P, id: string, incarnation: number): void {
    const { port1, port2 } = this.options.channel()
    this.options.toWorker(id, incarnation, port1)
    this.options.toPage(page, id, incarnation, port2)
  }
}

type WorkerSide = { start(start: WorkerStart): void, terminate(id: string, incarnation: number): void }

// The runtime's worker starts and ends with the drawer ports told: a start marked drawer and every end, which the loader
// sends for each incarnation that ends, a crash included
export function withDrawers(workers: WorkerSide, drawers: Pick<DrawerPorts<unknown>, 'started' | 'ended'>): WorkerSide {
  return {
    start(start) {
      workers.start(start)
      if (start.drawer) drawers.started(start.id, start.incarnation)
    },
    terminate(id, incarnation) {
      drawers.ended(id, incarnation)
      workers.terminate(id, incarnation)
    },
  }
}
