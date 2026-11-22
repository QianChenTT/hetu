// The places a check lists, each a file of core/, the text on the line a hit stands in, how many hits it covers in that
// file and why. A place covers exactly the hits it lists, so one more on its line or on another line holding its text
// fails, and so does one fewer

export type Place = { place: string, text: string, hits: number, why: string }
export type Hit = { file: string, line: number, text: string }

// The hits no place covers, then what is wrong with a place: more or fewer hits than it lists, none and a why under 10
// characters. holds says what a hit is, for the message of a place with none
export function placeProblems<H extends Hit>(found: readonly H[], lineOf: (hit: H) => string, places: readonly Place[], holds: string) {
  const at = (hit: H, place: Place) => hit.file === `core/${place.place}` && lineOf(hit).includes(place.text)
  const unlisted = found.filter(hit => !places.some(place => at(hit, place)))
  const problems: string[] = []
  for (const place of places) {
    const covered = found.filter(hit => at(hit, place))
    if (covered.length === 0) problems.push(`${place.place} holds no "${place.text}" ${holds}: remove the entry`)
    else if (covered.length !== place.hits) {
      const hits = covered.map(hit => `line ${hit.line} ${hit.text}`).join(', ')
      problems.push(`${place.place} "${place.text}" covers ${covered.length} hit${covered.length === 1 ? '' : 's'} and lists ${place.hits}: ${hits}`)
    }
    if (place.why.length < 10) problems.push(`${place.place} "${place.text}" has a why under 10 characters`)
  }
  return { unlisted, problems }
}
