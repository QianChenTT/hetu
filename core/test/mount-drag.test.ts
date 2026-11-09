import { describe, expect, it } from 'vitest'
import { accepts, DragGesture, fraction, splitSizes, zoneAt } from '../frontend/mount/drag.ts'

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height })

describe('the zone under the pointer', () => {
  const zones = [
    { zone: 'left', rect: rect(0, 0, 200, 600) },
    { zone: 'main', rect: rect(200, 0, 600, 600) },
    // Drawn later, so on top where it overlaps main
    { zone: 'main-top', rect: rect(200, 0, 600, 40) },
  ]

  it('finds the topmost zone holding the point', () => {
    expect(zoneAt(zones, 100, 300)?.zone).toBe('left')
    expect(zoneAt(zones, 400, 20)?.zone).toBe('main-top')
    expect(zoneAt(zones, 400, 300)?.zone).toBe('main')
    expect(zoneAt(zones, 900, 300)).toBe(null)
  })

  it('says where in the zone the point is, from 0 to 1 and clamped', () => {
    expect(fraction(rect(200, 0, 600, 600), 350, 150)).toEqual({ x: 0.25, y: 0.25 })
    expect(fraction(rect(200, 0, 600, 600), 100, 900)).toEqual({ x: 0, y: 1 })
    expect(fraction(rect(0, 0, 0, 0), 0, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('a drop target', () => {
  it('takes only the payload types it accepts', () => {
    expect(accepts(['note'], { type: 'note', value: 'a.md' })).toBe(true)
    expect(accepts(['note'], { type: 'text', value: 'a' })).toBe(false)
    expect(accepts(undefined, { type: 'text', value: 'a' })).toBe(false)
  })
})

describe('resizing a split', () => {
  it('moves the divider between two children by the pointer\'s travel, held to their minimums', () => {
    expect(splitSizes([200, 600], [100, 100], 0, 50)).toEqual([250, 550])
    expect(splitSizes([200, 600], [100, 100], 0, -150)).toEqual([100, 700])
    expect(splitSizes([200, 600], [100, 100], 0, 600)).toEqual([700, 100])
    expect(splitSizes([200, 300, 300], [50, 50, 50], 1, 100)).toEqual([200, 400, 200])
  })

  it('keeps the total and takes no minimum as zero', () => {
    expect(splitSizes([200, 600], undefined, 0, -500)).toEqual([0, 800])
  })
})

describe('a drag gesture', () => {
  it('starts only past a few pixels of travel from a trusted press, and drops where it ends', () => {
    const gesture = new DragGesture(10, 10)
    expect(gesture.move(12, 11)).toBe('pending')
    expect(gesture.move(20, 10)).toBe('dragging')
    expect(gesture.move(40, 10)).toBe('dragging')
    expect(gesture.end()).toBe('drop')
  })

  it('reads a press released before it travelled as a click, which drops nothing', () => {
    const gesture = new DragGesture(10, 10)
    gesture.move(11, 11)
    expect(gesture.end()).toBe('click')
  })
})
