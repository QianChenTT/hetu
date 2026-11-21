// A throw that isn't a refusal is a bug in search. It is logged, so no promise left running ends unhandled
export function threw(err: unknown): void {
  console.error('search: a task threw', err)
}
