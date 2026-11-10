// What the capability schema, the gate and the history and exec plugins share. Kept apart from zod, so a plugin bundles
// none of it

const MiB = 1024 * 1024

// Paths one history.commit takes
export const MAX_COMMIT_PATHS = 64
// Characters in a commit message
export const MAX_COMMIT_MESSAGE = 4096
// Commits one history.log answers with, unless the caller names fewer or more, and the most it may name
export const LOG_PAGE = 50
export const MAX_LOG_PAGE = 200
// The largest file history stores: the result cap, since a larger one could never be read back
export const HISTORY_FILE_BYTES = 16 * MiB
// The most one history.commit reads into memory, all its notes together
export const HISTORY_COMMIT_BYTES = 64 * MiB
// What exec keeps of a command's stdout and of its stderr
export const EXEC_OUTPUT_BYTES = MiB
// Commands one caller runs at once
export const EXEC_RUNNING = 4

// A variable's name as a manifest declares one. Windows has names with brackets, such as ProgramFiles(x86)
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_()]{0,63}$/

// Variables that make a program load code or config of someone's choosing, by name and by family. Compared without
// case, as Windows reads names. The list misses names, so exec builds its environment from empty and passes only what
// a manifest names, each name shown on the approval screen
const CODE_LOADING = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB',
  'BASH_ENV', 'ENV', 'ELECTRON_RUN_AS_NODE', 'JAVA_TOOL_OPTIONS', 'DOTNET_STARTUP_HOOKS',
  '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'PERLLIB', 'PERL5DB', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES',
  'LUA_INIT', 'LUA_PATH', 'LUA_CPATH', 'PHPRC', 'PHP_INI_SCAN_DIR', 'ZDOTDIR', 'SHELLOPTS', 'BASHOPTS', 'PYTHONUSERBASE',
  'TCLLIBPATH',
])
// The .NET profilers and runtime, npm's own config, which names a shell for scripts, and the families above
const CODE_LOADING_FAMILIES = ['LD_', 'DYLD_', 'GIT_', 'COR_', 'CORECLR_', 'DOTNET_', 'NPM_CONFIG_']

export function loadsCode(name: string): boolean {
  const upper = name.toUpperCase()
  return CODE_LOADING.has(upper) || CODE_LOADING_FAMILIES.some(family => upper.startsWith(family))
}

// Why exec passes no variable of this name, or null for one it does
export function envNameProblem(name: string): string | null {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) return 'not a variable name'
  if (loadsCode(name)) return 'a variable that makes a program load code'
  return null
}

// A command as one string that is the same only for the same arguments in the same order, so a list of commands is
// matched whole and never by joining words
export function commandKey(command: readonly string[]): string {
  return JSON.stringify(command)
}
