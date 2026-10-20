// Starts the daemon, waits until it listens, then starts the editor. Ctrl+C stops both
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'

const PORT = Number(process.env.HETU_PORT ?? 4747)
const children: ChildProcess[] = []

function run(name: string, args: string[]): ChildProcess {
  // Windows only runs npm.cmd through a shell. One fixed command string, nothing from outside reaches the shell
  const child = spawn(`npm ${args.join(' ')}`, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const prefix = (chunk: Buffer) => chunk.toString().split(/\r?\n/).filter(Boolean).map(line => `${name.padEnd(6)} | ${line}`).join('\n') + '\n'
  child.stdout!.on('data', chunk => process.stdout.write(prefix(chunk)))
  child.stderr!.on('data', chunk => process.stderr.write(prefix(chunk)))
  child.on('exit', code => {
    console.log(`${name.padEnd(6)} | exited with ${code}`)
    stop(code === 0 ? 0 : 1)
  })
  children.push(child)
  return child
}

const listening = () =>
  new Promise<boolean>(resolve => {
    const socket = connect(PORT, '127.0.0.1')
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
  })

// npm runs each child through a shell, so killing the shell alone would orphan the daemon and keep port 4747 taken.
// Kill whole process trees instead
function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return
  // Synchronous, so the kill finishes before this launcher exits
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  // Ctrl+C already reached every process in the console, which lets the daemon commit open leases on its own.
  // Whatever is still running after 3 s is killed
  const waitAll = Promise.all(children.map(c => (c.exitCode !== null ? null : new Promise(r => c.once('exit', r)))))
  const timeout = new Promise(r => setTimeout(r, 3000))
  void Promise.race([waitAll, timeout]).then(() => {
    for (const child of children) killTree(child)
    process.exit(code)
  })
}
process.on('SIGINT', () => stop(0))

if (await listening()) {
  console.log(`port ${PORT} is already in use. Stop the running daemon first`)
  process.exit(1)
}
run('daemon', ['start', '-w', 'daemon'])
const deadline = Date.now() + 15_000
while (!(await listening())) {
  if (Date.now() > deadline || stopping) {
    console.log('daemon did not start listening within 15 s')
    stop(1)
    break
  }
  await new Promise(r => setTimeout(r, 200))
}
if (!stopping) run('editor', ['run', 'dev', '-w', 'editor'])
