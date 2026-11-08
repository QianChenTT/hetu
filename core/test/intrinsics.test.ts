import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { freezeIntrinsics } from '../backend/runtime/intrinsics.ts'

// A fresh realm with its built-ins frozen, so the test runner's own stay as they were. Code runs in strict mode
function frozenRealm(): (code: string) => unknown {
  const context = vm.createContext({ structuredClone })
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

  it('still lets code set name, message and toString on its own objects', () => {
    const run = frozenRealm()
    expect(run('class Odd extends Error { constructor() { super("m"); this.name = "Odd" } }; const e = new Odd(); `${e.name}:${e.message}`')).toBe('Odd:m')
    expect(run('const o = {}; o.toString = () => "mine"; `${o}`')).toBe('mine')
    expect(run('const e = new TypeError("x"); e.message = "y"; e.message')).toBe('y')
  })

  it('leaves constructor a data property, since an accessor there takes V8\'s Array methods off their fast paths', () => {
    const run = frozenRealm()
    for (const name of ['Array', 'Object', 'Promise', 'Map', 'Set', 'RegExp', 'Uint8Array']) {
      expect(run(`'value' in Object.getOwnPropertyDescriptor(${name}.prototype, 'constructor')`), name).toBe(true)
    }
    // The cost: assigning constructor on code's own plain object now throws
    expect(throws(run, 'const o = {}; o.constructor = 5')).toBe('TypeError')
  })

  it('keeps the global names bound to the built-ins, so a host half can\'t swap Set or structuredClone under the core', () => {
    // A VM's global is a proxy that lets a delete through, so this one runs in a real realm of its own
    const freeze = pathToFileURL(path.join(import.meta.dirname, '..', 'backend', 'runtime', 'intrinsics.ts')).href
    const script = `
      'use strict'
      import { freezeIntrinsics } from ${JSON.stringify(freeze)}
      freezeIntrinsics()
      const out = []
      for (const code of ['globalThis.Set = function () {}', 'globalThis.structuredClone = x => x', 'delete globalThis.Map', 'globalThis.Array = 1']) {
        try { new Function('"use strict";' + code)(); out.push('passed') } catch (err) { out.push(err.constructor.name) }
      }
      console.log(JSON.stringify(out))
    `
    const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(JSON.parse(printed)).toEqual(['TypeError', 'TypeError', 'TypeError', 'TypeError'])
  })

  it('freezes the iterators, the async iterator and Intl\'s constructors too', () => {
    const run = frozenRealm()
    for (const code of [
      'Iterator', 'Iterator.prototype', 'Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}).prototype)',
      'Object.getPrototypeOf([].values().map(x => x))', 'Intl.Collator.prototype', 'Intl.DateTimeFormat.prototype',
      'Intl.NumberFormat', 'Intl.Segmenter.prototype',
    ]) {
      expect(run(`Object.isFrozen(${code})`), code).toBe(true)
    }
  })

  it('keeps each of those on the built-in itself as it was', () => {
    const run = frozenRealm()
    expect(throws(run, 'Object.prototype.toString = () => "x"')).toBe('TypeError')
    expect(throws(run, 'Error.prototype.name = "x"')).toBe('TypeError')
    expect(run('Object.prototype.toString.call([])')).toBe('[object Array]')
    expect(run('new Error("m").name')).toBe('Error')
  })
})
