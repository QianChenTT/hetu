import { describe, expect, it } from 'vitest'
import { icoFromPng } from '../build/package.ts'

// The start of a PNG, enough for the header to be read
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)])

describe('the installer\'s icon', () => {
  it('is one 256 pixel PNG image in an ICO file, which Windows reads since Vista', () => {
    const ico = icoFromPng(png)
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 1])
    // 0 stands for 256 in an ICO entry's width and height
    expect([ico[6], ico[7], ico.readUInt16LE(10), ico.readUInt16LE(12)]).toEqual([0, 0, 1, 32])
    expect([ico.readUInt32LE(14), ico.readUInt32LE(18)]).toEqual([png.length, 22])
    expect(ico.subarray(22).equals(png)).toBe(true)
  })

  it('refuses bytes that aren\'t a PNG', () => {
    expect(() => icoFromPng(Buffer.from('not a png'))).toThrow('PNG')
  })
})
