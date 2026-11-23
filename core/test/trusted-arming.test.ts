import { describe, expect, it } from 'vitest'
import { Arming } from '../frontend/trusted/arming.ts'

function armed() {
  let now = 0
  const arming = new Arming(() => now, 1000)
  return { arming, at: (ms: number) => { now = ms } }
}

describe('when the page arms its Confirm buttons', () => {
  it('waits the delay after the window shows and after each time it gains focus', () => {
    const { arming, at } = armed()
    expect(arming.wait()).toBe(1000)
    at(1000)
    expect(arming.wait()).toBe(0)
    at(5000)
    arming.focused()
    expect(arming.wait()).toBe(1000)
  })

  it('waits the delay again when a new staging or request is drawn, and not for one drawn again', () => {
    const { arming, at } = armed()
    at(2000)
    arming.show('staging', 's1')
    expect(arming.wait()).toBe(1000)
    at(3000)
    arming.show('staging', 's1')
    expect(arming.wait()).toBe(0)
    arming.show('staging', 's2')
    expect(arming.wait()).toBe(1000)
    at(4000)
    arming.show('request', 'r1')
    expect(arming.wait()).toBe(1000)
  })

  it('waits again for a staging drawn after none, though it is one drawn before', () => {
    const { arming, at } = armed()
    at(2000)
    arming.show('staging', 's1')
    at(3000)
    arming.show('staging', null)
    arming.show('staging', 's1')
    expect(arming.wait()).toBe(1000)
  })
})
