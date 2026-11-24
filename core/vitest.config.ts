import { configDefaults, defineConfig } from 'vitest/config'

// The end-to-end tests drive the built app, the packaged and installed suites start the packed build, each with its own
// config
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/e2e/**', 'test/packaged/**', 'test/installed/**'],
    // CI's Windows and macOS runners are slow and uneven, so a test that waits on workers or timers gets well past
    // vitest's 5 s and 10 s defaults before it counts as hung
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
