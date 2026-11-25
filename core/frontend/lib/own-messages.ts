// Hands listener the data of each message the window posted to itself, as a preload passes main's words on to its page
// and the page answers, never one a frame or another window posted. Data is the shape the listener reads it as,
// unchecked
export function onOwnMessage<Data = Record<string, unknown>>(listener: (data: Data | null, event: MessageEvent) => void): void {
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return
    listener(event.data as Data | null, event)
  })
}
