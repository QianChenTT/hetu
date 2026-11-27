// Run only by instance.real.test.ts in a run of its own, to see what a passed, a failed and a skipped instance leave
import { expect, it } from 'vitest'
import { start } from '../instance.ts'

it('passes', async context => {
  const instance = await start(context, { profile: { name: 'kept-pass', plugins: [] } })
  await instance.editor()
})

it('fails', async context => {
  const instance = await start(context, { profile: { name: 'kept-fail', plugins: [] } })
  await instance.editor()
  expect('a check').toBe('failed on purpose')
})

it('waits for memory', async context => {
  await start(context, { profile: { name: 'memory', plugins: [] }, free: () => 0.5, memoryWaitMs: 100 })
})
