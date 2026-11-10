import type { ActionArgs, ResultOf } from '../api/actions.ts'
import type { CallOptions, RequestOptions } from './calls.ts'

// The provider actions a plugin calls by name. The same list as core/api's providerActions, which a test holds it to.
// Kept here as strings, so a plugin bundles none of core/api's schemas
export const providerActionNames = [
  'luoshu.read', 'luoshu.write', 'luoshu.list',
  'leases.acquire', 'leases.renew', 'leases.release', 'leases.list',
  'storage.get', 'storage.set', 'storage.delete',
  'cache.get', 'cache.set', 'cache.delete',
  'history.commit', 'history.log', 'history.read',
  'exec.run',
] as const satisfies readonly (keyof ActionArgs)[]

type ProviderAction = typeof providerActionNames[number]
type NamespaceOf<A> = A extends `${infer N}.${string}` ? N : never
type MethodOf<A> = A extends `${string}.${infer M}` ? M : never

// Args may be left out where the action takes none
type Method<A extends ProviderAction> = {} extends ActionArgs[A]
  ? (args?: ActionArgs[A], options?: CallOptions) => Promise<ResultOf<A>>
  : (args: ActionArgs[A], options?: CallOptions) => Promise<ResultOf<A>>

type Namespaces = {
  readonly [N in NamespaceOf<ProviderAction>]: {
    readonly [A in ProviderAction as NamespaceOf<A> extends N ? MethodOf<A> : never]: Method<A>
  }
}

// One call per action, such as ctx.luoshu.read({ path }) or ctx.storage.set({ key, value }). call reaches another
// plugin's <target>.<name>, which needs plugin.call on that target
export type Client = Namespaces & {
  call(target: string, name: string, args?: unknown, options?: CallOptions): Promise<unknown>
}

export type Request = (action: string, args: unknown, options?: RequestOptions) => Promise<unknown>

// A client whose calls go through request. parent and its deadline ride on every call, for the client a call's
// handler gets
export function makeClient(request: Request, parent?: { callId: string, deadline: number }): Client {
  const send = (action: string, args: unknown, options: CallOptions = {}) =>
    request(action, args === undefined ? {} : args, parent === undefined ? options : { ...options, parent: parent.callId, deadline: parent.deadline })
  const namespaces: Record<string, Record<string, unknown>> = {}
  for (const action of providerActionNames) {
    const dot = action.indexOf('.')
    const namespace = (namespaces[action.slice(0, dot)] ??= {})
    namespace[action.slice(dot + 1)] = (args: unknown, options?: CallOptions) => send(action, args, options)
  }
  return {
    ...namespaces,
    call: (target: string, name: string, args?: unknown, options?: CallOptions) => send(`${target}.${name}`, args, options),
  } as Client
}
