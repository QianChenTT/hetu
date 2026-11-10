import { defineConfig } from 'vitest/config'

// Each test starts the install as a plain process, one at a time, with room for Electron to start
export default defineConfig({
  test: {
    include: ['test/installed/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
