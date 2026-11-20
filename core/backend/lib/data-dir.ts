import path from 'node:path'

// Where hetu keeps its data for a run, which boot and the runtime before Electron is ready both work out

function absolute(value: string | undefined, name: string): string {
  if (!value || !path.posix.isAbsolute(value)) throw new Error(`${name} is not an absolute path`)
  return value
}

// The local folder, not the roaming one, so the state stays on this machine.
// The folder is named hetu-dev for an unpackaged run
export function stateDir(platform: string = process.platform, env: Record<string, string | undefined> = process.env, name = 'hetu'): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (!local || !path.win32.isAbsolute(local)) throw new Error('LOCALAPPDATA is not an absolute path')
    return path.win32.join(local, name)
  }
  if (platform === 'darwin') return path.posix.join(absolute(env.HOME, 'HOME'), 'Library', 'Application Support', name) // mac
  if (platform === 'linux') {
    // A bad XDG_STATE_HOME is refused, not skipped, or a typo would move the state without a word
    const base = env.XDG_STATE_HOME === undefined
      ? path.posix.join(absolute(env.HOME, 'HOME'), '.local', 'state')
      : absolute(env.XDG_STATE_HOME, 'XDG_STATE_HOME')
    return path.posix.join(base, name)
  }
  throw new Error(`no security state location on ${platform}`)
}

// A packaged build ignores HETU_DATA_DIR, so the environment can't move the state somewhere else. An unpackaged run
// gets its own folder, so a dev copy never shares the state of an installed hetu
export function resolveDataDir(options: { packaged: boolean, env: Record<string, string | undefined>, platform: string }): { dataDir: string, dev: boolean } {
  const { packaged, env, platform } = options
  if (packaged) return { dataDir: stateDir(platform, env), dev: false }
  const override = env.HETU_DATA_DIR
  if (override === undefined) return { dataDir: stateDir(platform, env, 'hetu-dev'), dev: true }
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (!paths.isAbsolute(override)) throw new Error('HETU_DATA_DIR is not an absolute path')
  return { dataDir: override, dev: true }
}
