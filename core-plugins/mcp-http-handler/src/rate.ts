// Requests in the last second, oldest first. One counter is shared by every listener, so a second way in can't double
// what the agents may send. A request counts only once it passed the checks before the rate, so a page on another
// name can't spend what the agents have
export function rate(perSecond: number, clock: () => number): () => boolean {
  const times: number[] = []
  return () => {
    const now = clock()
    while (times.length > 0 && now - times[0] >= 1000) times.shift()
    if (times.length >= perSecond) return false
    times.push(now)
    return true
  }
}
