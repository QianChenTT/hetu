// A half's end of its way to the carrier: the HostLink the loader gives a host half. From step 11 a worker's port sits
// behind the same two calls. Messages the carrier sends before listen wait for it
export type Transport = {
  post(message: unknown): void
  listen(listener: (message: unknown) => void): void
}
