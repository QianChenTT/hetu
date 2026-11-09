// A view frame's side of its view: the frame's script waits for the port the drawer sends on its first load and talks
// to its own plugin's worker over it, plain data as JSON text. The frame holds no power of its own: whatever it needs
// comes from its worker, which holds the plugin's grants

export type FrameChannel = {
  post(data: unknown): void
  on(handler: (data: unknown) => void): void
}

type FrameEvent = { source: unknown, data: unknown, ports: readonly MessagePort[] }

export type FrameScope = {
  readonly parent: unknown
  addEventListener(type: 'message', listener: (event: FrameEvent) => void): void
  removeEventListener(type: 'message', listener: (event: FrameEvent) => void): void
}

export function frameChannel(scope: FrameScope = globalThis as unknown as FrameScope): Promise<FrameChannel> {
  return new Promise(resolve => {
    const listener = (event: FrameEvent) => {
      const data = event.data as { v?: unknown, kind?: unknown } | null
      const port = event.ports[0]
      if (event.source !== scope.parent || data?.v !== 1 || data.kind !== 'view' || port === undefined) return
      scope.removeEventListener('message', listener)
      resolve({
        post: value => port.postMessage(JSON.stringify(value)),
        on: handler => {
          port.onmessage = message => {
            if (typeof message.data !== 'string') return
            let value: unknown
            try {
              value = JSON.parse(message.data)
            } catch {
              return
            }
            handler(value)
          }
        },
      })
    }
    scope.addEventListener('message', listener)
  })
}
