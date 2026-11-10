import { configDefaults, defineConfig } from 'vitest/config'

// The end-to-end tests drive the built app, the packaged and installed suites start the packed build, each with its own
// config
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'test/e2e/**', 'test/packaged/**', 'test/installed/**'] },
})
