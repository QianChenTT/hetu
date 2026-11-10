import { defineConfig } from 'vitest/config'

// Each test starts the packed build as a plain process, one at a time, with room for Electron to start
export default defineConfig({
  test: {
    include: ['test/packaged/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
