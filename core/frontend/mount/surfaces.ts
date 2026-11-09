import type { RefusalCode } from '../../api/envelope.ts'
import { applyOps, MAX_SURFACES, type Op, type UiNode } from '../../api/ui.ts'

// The trees the drawer keeps: one per owner and surface, the layout's skeleton or a view instance. Each changes only
// through its owner's own operations, which the owner tag main set says, so no plugin reaches another's tree. A refused
// message leaves the surface as it was

export class Surfaces {
  private readonly trees = new Map<string, Map<string, UiNode>>()
  private readonly sizes = new Map<string, number>()

  apply(owner: string, surface: string, ops: readonly Op[], layout: boolean): { tree: UiNode, visited: number, nodes: number } | { refusal: RefusalCode, problem: string } {
    const held = this.trees.get(owner) ?? new Map<string, UiNode>()
    if (!held.has(surface) && held.size >= MAX_SURFACES) return { refusal: 'invalid', problem: `more than ${MAX_SURFACES} surfaces` }
    const applied = applyOps(held.get(surface) ?? null, ops, { layout })
    if ('problem' in applied) return { refusal: 'invalid', problem: applied.problem }
    held.set(surface, applied.tree)
    this.trees.set(owner, held)
    this.sizes.set(`${owner} ${surface}`, applied.nodes)
    return applied
  }

  // The nodes in the surface's tree, which a draw's cost is weighed by before it applies
  size(owner: string, surface: string): number {
    return this.trees.get(owner)?.has(surface) === true ? this.sizes.get(`${owner} ${surface}`) ?? 0 : 0
  }

  tree(owner: string, surface: string): UiNode | null {
    return this.trees.get(owner)?.get(surface) ?? null
  }

  dropSurface(owner: string, surface: string): void {
    this.trees.get(owner)?.delete(surface)
  }

  // Everything the owner drew, when its port ends
  drop(owner: string): void {
    this.trees.delete(owner)
  }
}
