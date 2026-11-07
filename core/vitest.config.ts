import { configDefaults, defineConfig } from 'vitest/config'

// The end-to-end tests drive the built app and run with their own config
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'test/e2e/**'] },
})
