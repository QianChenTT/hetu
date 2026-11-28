import { defineConfig } from 'vitest/config'

// The tests that start the driven build, named *.real.test.ts. The rest of tier 0's tests run in the unit suite. Files
// run side by side, each instance on folders of its own, starting one at a time behind the memory gate, and an instance
// holding the door waits for the others through its lock. The fixtures run alone, from instance.real.test.ts
export default defineConfig({
  test: {
    include: process.env.HETU_TIER0_FIXTURES === '1' ? ['test/tier0/fixtures/*.real.test.ts'] : ['test/tier0/*.real.test.ts'],
    maxWorkers: 3,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
