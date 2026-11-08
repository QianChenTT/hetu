import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { freezeIntrinsics } from '../backend/runtime/intrinsics.ts'

// A fresh realm with its built-ins frozen, so the test runner's own stay as they were. Code runs in strict mode
function frozenRealm(): (code: string) => unknown {
  const context = vm.createContext({})
  vm.runInContext(`(${freezeIntrinsics.toString()})()`, context)
  return code => vm.runInContext(`'use strict';{${code}}`, context)
}

const throws = (run: (code: string) => unknown, code: string) => run(`try { ${code}; 'passed' } catch (err) { err.constructor.name }`)

describe('freezing the built-ins', () => {
  it('keeps a host half from replacing a method core/api decides with', () => {
    const run = frozenRealm()
    for (const code of [
      'Array.prototype.includes = () => true', 'Set.prototype.has = () => true', 'String.prototype.startsWith = () => true',
      'Map.prototype.get = () => 1', 'JSON.parse = () => ({})', 'Object.freeze = x => x', 'Reflect.ownKeys = () => []',
      'Array.prototype.evil = 1', 'Object.prototype.polluted = 1', 'Math.max = () => 0',
    ]) {
      expect(throws(run, code), code).toBe('TypeError')
    }
    expect(run('[1].includes(2)')).toBe(false)
  })

  it('freezes the built-ins with no global name too', () => {
    const run = frozenRealm()
    for (const code of [
      'Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))', 'Object.getPrototypeOf([][Symbol.iterator]())',
      'Object.getPrototypeOf(Int8Array).prototype', 'Object.getPrototypeOf(Int8Array)', 'Object.getPrototypeOf(function* () {})',
      'Object.getPrototypeOf(function* () {}).prototype', 'Object.getPrototypeOf(async function () {})',
      'Object.getPrototypeOf(new Map()[Symbol.iterator]())', 'Object.getPrototypeOf(new Set()[Symbol.iterator]())',
      'Object.getPrototypeOf(""[Symbol.iterator]())',
    ]) {
      expect(run(`Object.isFrozen(${code})`), code).toBe(true)
    }
  })

  it('still lets code set name, message, toString and constructor on its own objects', () => {
    const run = frozenRealm()
    expect(run('class Odd extends Error { constructor() { super("m"); this.name = "Odd" } }; const e = new Odd(); `${e.name}:${e.message}`')).toBe('Odd:m')
    expect(run('const o = {}; o.toString = () => "mine"; `${o}`')).toBe('mine')
    expect(run('function F() {}; const f = new F(); f.constructor = 5; f.constructor')).toBe(5)
    expect(run('const e = new TypeError("x"); e.message = "y"; e.message')).toBe('y')
  })

  it('keeps each of those on the built-in itself as it was', () => {
    const run = frozenRealm()
    expect(throws(run, 'Object.prototype.toString = () => "x"')).toBe('TypeError')
    expect(throws(run, 'Error.prototype.name = "x"')).toBe('TypeError')
    expect(run('Object.prototype.toString.call([])')).toBe('[object Array]')
    expect(run('new Error("m").name')).toBe('Error')
  })
})
