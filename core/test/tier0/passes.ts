// Tier 0 runs vitest in two passes, the timing file alone after the rest. A report file named in the arguments is
// named per pass, so the timing pass's report never takes the place of the main pass's
export const PASSES = ['main', 'timing'] as const
export type Pass = typeof PASSES[number]

// report.json becomes report.main.json and report.timing.json, a name with no extension gets the pass at its end
export function passReport(file: string, pass: Pass): string {
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  const dot = file.lastIndexOf('.')
  return dot > slash + 1 ? `${file.slice(0, dot)}.${pass}${file.slice(dot)}` : `${file}.${pass}`
}

// The arguments one pass gives vitest: each report file vitest is told to write, as --outputFile=<file> or
// --outputFile.<reporter>=<file>, with the value joined by = or as the next argument, named for the pass
export function passArgs(args: readonly string[], pass: Pass): string[] {
  const named: string[] = []
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    const option = /^--outputFile(\.[\w-]+)?(=|$)/.exec(arg)
    if (option === null) named.push(arg)
    else if (option[2] === '=') named.push(`${arg.slice(0, option[0].length)}${passReport(arg.slice(option[0].length), pass)}`)
    else if (at + 1 < args.length) named.push(arg, passReport(args[++at]!, pass))
    else named.push(arg)
  }
  return named
}
