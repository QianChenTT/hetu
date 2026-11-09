import { defineConfig } from 'vitest/config'

// Each test starts the built app, so one file at a time with room for Electron to start
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
