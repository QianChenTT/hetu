// Packs the build the end-to-end tests drive, packaged and not locked, then runs the end-to-end tests against it, so
// saving a note, the plugins, the frames and the trusted window are seen working from inside app.asar
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { executableIn, packageHetu } from '../core/build/package.ts'

const repo = path.join(import.meta.dirname, '..')
const { appOutDir } = await packageHetu({ target: 'dir', locked: false, out: path.join(repo, 'dist-package', 'driven') })
// Windows only runs npx through a shell. One fixed command string, the path reaching vitest through the environment
const ran = spawnSync('npx vitest run --config test/e2e/vitest.config.ts', {
  cwd: path.join(repo, 'core'),
  shell: true,
  stdio: 'inherit',
  env: { ...process.env, HETU_E2E_APP: executableIn(appOutDir) },
})
process.exit(ran.status ?? 1)
