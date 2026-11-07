import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { checkHash, parseStrict, withHash } from '../lib/hashed-file.ts'

const bytes = (text: string) => Buffer.from(text)
// A record drops __proto__ without a word, so these schemas leave the key checks to the parser alone
const loose = [['unknown', z.unknown()], ['a record', z.record(z.string(), z.unknown())]] as const

describe('the strict parser with a schema that would take anything', () => {
  it.each(loose)('takes clean JSON with %s', (_name, schema) => {
    expect(parseStrict(bytes('{"a":{"b":[1,{"c":2}]}}'), schema)).toEqual({ a: { b: [1, { c: 2 }] } })
  })

  it.each(loose)('refuses __proto__ at any depth with %s', (_name, schema) => {
    for (const text of ['{"__proto__":{}}', '{"a":{"__proto__":{"x":1}}}', '{"a":[{"b":{"__proto__":1}}]}']) {
      expect(() => parseStrict(bytes(text), schema)).toThrow(/__proto__/)
    }
  })

  it.each(loose)('refuses a duplicate key at any depth with %s', (_name, schema) => {
    for (const text of ['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '{"a":[{"b":1,"\\u0062":2}]}']) {
      expect(() => parseStrict(bytes(text), schema)).toThrow(/duplicate/)
    }
  })

  it('refuses bytes that are not UTF-8 and a byte order mark', () => {
    expect(() => parseStrict(Buffer.from([0x7b, 0xff, 0x7d]), z.unknown())).toThrow()
    expect(() => parseStrict(bytes('\uFEFF{}'), z.unknown())).toThrow()
  })
})

describe('the hash line', () => {
  it('gives back the body it was written over', () => {
    const body = bytes('{"a":1}\n')
    expect(checkHash(withHash(body))).toEqual({ body })
  })

  it('tells a missing hash line from one that does not match', () => {
    expect(checkHash(bytes('{"a":1}\n'))).toEqual({ result: 'hash-missing' })
    const written = withHash(bytes('{"a":1}\n'))
    written[2] = 0x62
    expect(checkHash(written)).toEqual({ result: 'hash-mismatch' })
  })
})
